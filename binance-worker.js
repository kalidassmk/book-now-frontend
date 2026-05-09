const WebSocket = require('ws');
const Redis = require('ioredis');
const https = require('https');
const crypto = require('crypto');
require('dotenv').config();

let API_KEY = process.env.BINANCE_API_KEY;
let SECRET_KEY = process.env.BINANCE_SECRET_KEY;
const BASE_URL = 'https://api.binance.com';
const BINANCE_HOST = 'api.binance.com';

// We hit Binance REST exactly ONCE on startup to load the current
// state of balances / open orders / OCO lists. After that, the User
// Data Stream WebSocket pushes every change (~100 ms latency) and the
// applyOrderEventToCache / applyListStatusToCache appliers keep Redis
// in sync. No polling — the dashboard is always live, no IP weight
// budget burned in quiet periods.
let snapshotTimer = null;  // kept for cleanup of any prior interval

// Binance deprecated POST/PUT/DELETE /api/v3/userDataStream (returns 410 Gone).
// The replacement is the WebSocket API: send `userDataStream.start` /
// `userDataStream.ping` over a short-lived connection to ws-api.binance.com
// and use the returned listenKey on the regular stream.binance.com socket.
const WS_API_URL = 'wss://ws-api.binance.com:443/ws-api/v3';

const redis = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379
});

let listenKey = null;
let ws = null;
let io = null;
let executionCallback = null;
let keepAliveTimer = null;

// 24-hour ticker cache, populated by the !miniTicker@arr WebSocket stream.
// Replaces per-symbol REST calls to /api/v3/ticker/24hr (which were paid per
// symbol and capped by Binance's IP weight limit). The mini-ticker stream
// arrives once per second with every spot pair's close/volume — so reads
// from this map are O(1) and free.
//
// Shape matches the REST 24h-ticker response so existing call sites can
// drop in without reshaping their parsing logic:
//   { lastPrice, quoteVolume, openPrice, highPrice, lowPrice, volume, ts }
const tickerCache = new Map();
let tickerWs = null;
let tickerReconnectTimer = null;

async function loadCredentials() {
    const rApiKey = await redis.get('BINANCE_API_KEY');
    const rSecretKey = await redis.get('BINANCE_SECRET_KEY');

    API_KEY = rApiKey || process.env.BINANCE_API_KEY;
    SECRET_KEY = rSecretKey || process.env.BINANCE_SECRET_KEY;

    if (!API_KEY || !SECRET_KEY) {
        console.warn('⚠️ API Keys are missing! Check your .env file.');
    }
}

// ─── Signed REST helper ──────────────────────────────────────────────
// Binance requires `timestamp` and an HMAC-SHA256 `signature` of the
// query string for every account-touching endpoint. server.js calls
// this for cancel-order, dust-transfer, and (now) the periodic
// snapshot fetches. Throws on any non-2xx reply with Binance's own
// error message intact.
function binanceFetch(path, method = 'GET', params = {}) {
    return new Promise((resolve, reject) => {
        if (!API_KEY || !SECRET_KEY) {
            return reject(new Error('Binance API keys not loaded'));
        }
        const requiresSig = path.startsWith('/api/v3/') || path.startsWith('/sapi/');
        let qs = '';
        if (requiresSig) {
            const merged = { ...params, timestamp: Date.now(), recvWindow: 5000 };
            qs = Object.entries(merged)
                .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
                .join('&');
            const signature = crypto.createHmac('sha256', SECRET_KEY).update(qs).digest('hex');
            qs = `${qs}&signature=${signature}`;
        } else {
            qs = Object.entries(params)
                .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
                .join('&');
        }

        // Binance accepts query params in the URL even for POST/DELETE
        // (it's a quirk of their REST design). Keeps signing logic
        // simple — body is unused.
        const reqPath = qs ? `${path}?${qs}` : path;
        const opts = {
            host: BINANCE_HOST,
            path: reqPath,
            method,
            headers: { 'X-MBX-APIKEY': API_KEY },
        };
        const req = https.request(opts, (resp) => {
            let body = '';
            resp.on('data', (chunk) => { body += chunk; });
            resp.on('end', () => {
                let data;
                try { data = body ? JSON.parse(body) : null; } catch (_) { data = body; }
                if (resp.statusCode >= 400) {
                    const msg = (data && (data.msg || data.message)) || `HTTP ${resp.statusCode}`;
                    return reject(new Error(`Binance ${method} ${path}: ${msg}`));
                }
                resolve(data);
            });
        });
        req.on('error', reject);
        req.end();
    });
}

// ─── Snapshot refreshers ─────────────────────────────────────────────
// The User Data Stream sends *deltas* — it never emits the current
// state on connect. So on every restart, and during quiet periods,
// the dashboard sees stale Redis. These fetchers populate the cache
// directly from /api/v3/account and /api/v3/openOrders so the UI is
// correct as soon as the worker starts.

async function refreshBalanceSnapshot() {
    try {
        const account = await binanceFetch('/api/v3/account', 'GET', {});
        if (!account || !Array.isArray(account.balances)) return;
        // Match the shape emitted by the WS handler so server.js sees
        // identical rows whether they came from snapshot or stream.
        const balances = account.balances
            .filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
            .map(b => ({ asset: b.asset, free: b.free, locked: b.locked }));
        await redis.set('BINANCE:BALANCES:ALL', JSON.stringify(balances));
        const usdt = account.balances.find(b => b.asset === 'USDT');
        if (usdt) {
            await redis.set('BINANCE:BALANCE:USDT', JSON.stringify({ free: usdt.free, locked: usdt.locked }));
        }
        if (io) io.emit('balance-update', balances);
    } catch (err) {
        console.warn('[snapshot] balance refresh failed:', err.message);
    }
}

async function refreshOpenOrdersSnapshot() {
    // Per-symbol querying: each /api/v3/openOrders?symbol=X call costs
    // 6 weight, vs 80 weight for the no-symbol version that scans the
    // whole account. With 1-3 active symbols this is 75-90 % cheaper.
    //
    // Symbols we query are the union of:
    //   1. Anything we currently hold (sell-side orders sit on these)
    //   2. Symbols already present in the previous OPEN_ORDERS cache
    //      (carries forward limit-buys on coins we don't yet hold)
    try {
        const symbolSet = new Set();

        const balRaw = await redis.get('BINANCE:BALANCES:ALL');
        const balances = balRaw ? JSON.parse(balRaw) : [];
        for (const b of balances) {
            if (b.asset === 'USDT') continue;
            const total = parseFloat(b.free || 0) + parseFloat(b.locked || 0);
            if (total > 0) symbolSet.add(`${b.asset}USDT`);
        }

        const prevRaw = await redis.get('BINANCE:OPEN_ORDERS:ALL');
        const prev = prevRaw ? JSON.parse(prevRaw) : [];
        for (const o of prev) {
            if (o && o.symbol) symbolSet.add(o.symbol);
        }

        if (symbolSet.size === 0) {
            await redis.set('BINANCE:OPEN_ORDERS:ALL', '[]');
            return;
        }

        const allOrders = [];
        for (const symbol of symbolSet) {
            try {
                const orders = await binanceFetch('/api/v3/openOrders', 'GET', { symbol });
                if (Array.isArray(orders) && orders.length > 0) {
                    allOrders.push(...orders);
                }
            } catch (err) {
                console.warn(`[snapshot] open orders ${symbol} failed:`, err.message);
            }
        }
        await redis.set('BINANCE:OPEN_ORDERS:ALL', JSON.stringify(allOrders));
        console.log(`[snapshot] open-orders refreshed: ${allOrders.length} orders across ${symbolSet.size} symbols (≈${symbolSet.size * 6} weight)`);
    } catch (err) {
        console.warn('[snapshot] open-orders refresh failed:', err.message);
    }
}

async function refreshOrderListsSnapshot() {
    // OCO order lists. Binance returns ALL_DONE entries here too, so the
    // dashboard can reconcile when an OCO leg fills via the exchange.
    try {
        const lists = await binanceFetch('/api/v3/openOrderList', 'GET', {});
        if (!Array.isArray(lists)) return;
        await redis.set('BINANCE:ORDER_LISTS:ALL', JSON.stringify(lists));
    } catch (err) {
        console.warn('[snapshot] order-lists refresh failed:', err.message);
    }
}

// Trade history is per-symbol on Binance — there is no /api/v3/myTrades
// without a symbol filter. We seed BINANCE:TRADE_HISTORY:ALL by walking
// every asset with a non-zero balance and fetching its USDT-pair trades,
// then keep it fresh going forward via the WebSocket executionReport
// handler in connectWS().
const TRADE_HISTORY_CAP = 500;       // cap the global history list
const TRADE_HISTORY_PER_SYMBOL = 50; // recent trades per symbol on seed

async function refreshTradeHistorySnapshot() {
    try {
        // Skip dust (USDT-value < $1) to avoid burning weight on
        // micro-leftovers from old trades. The dashboard never shows
        // sub-$1 history rows anyway.
        const balRaw = await redis.get('BINANCE:BALANCES:ALL');
        const balances = balRaw ? JSON.parse(balRaw) : [];
        const symbolsToFetch = balances
            .filter(b => b.asset && b.asset !== 'USDT' && parseFloat(b.valueUsdt || 0) >= 1)
            .map(b => `${b.asset}USDT`);

        if (!symbolsToFetch.length) return;

        const collected = [];
        for (const symbol of symbolsToFetch) {
            try {
                const trades = await binanceFetch('/api/v3/myTrades', 'GET', {
                    symbol,
                    limit: TRADE_HISTORY_PER_SYMBOL,
                });
                if (Array.isArray(trades)) {
                    collected.push(...trades);
                    // Per-symbol cache for the detail view.
                    await redis.set(`BINANCE:TRADE_HISTORY:${symbol}`, JSON.stringify(trades));
                }
            } catch (err) {
                console.warn(`[snapshot] trade history ${symbol} failed:`, err.message);
            }
        }

        // Sort newest-first and cap. ``time`` is epoch-ms on Binance
        // myTrades response.
        collected.sort((a, b) => (b.time || 0) - (a.time || 0));
        const trimmed = collected.slice(0, TRADE_HISTORY_CAP);
        await redis.set('BINANCE:TRADE_HISTORY:ALL', JSON.stringify(trimmed));
    } catch (err) {
        console.warn('[snapshot] trade history refresh failed:', err.message);
    }
}

async function refreshAllSnapshots() {
    // Balance snapshot must complete before trade history — the latter
    // walks the asset list to know which symbols to fetch trades for.
    await Promise.allSettled([
        refreshBalanceSnapshot(),
        refreshOpenOrdersSnapshot(),
        refreshOrderListsSnapshot(),
    ]);
    // Trade history runs after so it has the freshest balances to walk.
    await refreshTradeHistorySnapshot();
}

// ─── WebSocket → cache appliers ──────────────────────────────────────
// These mutate the same Redis keys the snapshot fetchers populate, so
// reads from server.js see one consistent view whether the latest
// update arrived via REST snapshot or User Data Stream event.

async function applyOrderEventToCache(msg) {
    // executionReport status values we care about for cache shape:
    //   NEW             → add the order
    //   PARTIALLY_FILLED → update executedQty (still open)
    //   FILLED, CANCELED, EXPIRED, REJECTED → remove the order
    const status = msg.X;
    const orderId = msg.i;
    const symbol = msg.s;
    if (!orderId || !symbol) return;

    try {
        const raw = await redis.get('BINANCE:OPEN_ORDERS:ALL');
        const orders = raw ? JSON.parse(raw) : [];
        const idx = orders.findIndex(o => o.orderId === orderId);

        if (status === 'NEW' || status === 'PARTIALLY_FILLED') {
            // Build a Binance-shape row from the executionReport so the
            // dashboard sees the same fields whether they came from REST
            // /api/v3/openOrders or this WebSocket frame.
            const row = {
                symbol:               msg.s,
                orderId:              msg.i,
                orderListId:          msg.g >= 0 ? msg.g : -1,
                clientOrderId:        msg.c,
                price:                msg.p,
                origQty:              msg.q,
                executedQty:          msg.z,
                cummulativeQuoteQty:  msg.Z,
                status:               msg.X,
                timeInForce:          msg.f,
                type:                 msg.o,
                side:                 msg.S,
                stopPrice:            msg.P,
                time:                 msg.T,
                updateTime:           msg.T,
                isWorking:            msg.w,
            };
            if (idx >= 0) orders[idx] = row;
            else orders.push(row);
        } else {
            // Terminal states — drop from the cache.
            if (idx >= 0) orders.splice(idx, 1);
        }
        await redis.set('BINANCE:OPEN_ORDERS:ALL', JSON.stringify(orders));
    } catch (err) {
        // Non-fatal: a bad cache update doesn't break the worker.
        console.warn('[WS] applyOrderEventToCache failed:', err.message);
    }

    // Trade history append — every fill (full or partial) becomes a row
    // in BINANCE:TRADE_HISTORY:ALL and the per-symbol list. Mirrors the
    // shape of REST /api/v3/myTrades so the dashboard sees consistent
    // fields no matter which path produced the row.
    if (status === 'PARTIALLY_FILLED' || status === 'FILLED') {
        try {
            const lastFillQty = parseFloat(msg.l) || 0;   // last filled qty (this event)
            const lastFillPx  = parseFloat(msg.L) || 0;   // last fill price
            if (lastFillQty <= 0 || lastFillPx <= 0) return;
            const tradeRow = {
                symbol:           msg.s,
                id:               msg.t || msg.i,        // tradeId if present, else fall back
                orderId:          msg.i,
                orderListId:      msg.g >= 0 ? msg.g : -1,
                price:            msg.L,                 // last fill price
                qty:              msg.l,                 // last filled qty
                quoteQty:         (lastFillQty * lastFillPx).toString(),
                commission:       msg.n,
                commissionAsset:  msg.N,
                time:             msg.T,
                isBuyer:          msg.S === 'BUY',
                isMaker:          !!msg.m,
            };

            // Global cap for the dashboard's recent-history list.
            const allRaw = await redis.get('BINANCE:TRADE_HISTORY:ALL');
            const all = allRaw ? JSON.parse(allRaw) : [];
            all.unshift(tradeRow);
            if (all.length > TRADE_HISTORY_CAP) all.length = TRADE_HISTORY_CAP;
            await redis.set('BINANCE:TRADE_HISTORY:ALL', JSON.stringify(all));

            // Per-symbol cache so the detail view can pull fast.
            const perSymKey = `BINANCE:TRADE_HISTORY:${msg.s}`;
            const symRaw = await redis.get(perSymKey);
            const sym = symRaw ? JSON.parse(symRaw) : [];
            sym.unshift(tradeRow);
            if (sym.length > TRADE_HISTORY_PER_SYMBOL) sym.length = TRADE_HISTORY_PER_SYMBOL;
            await redis.set(perSymKey, JSON.stringify(sym));

            if (io) io.emit('trade-fill', tradeRow);
        } catch (err) {
            console.warn('[WS] trade history append failed:', err.message);
        }
    }
}

async function applyListStatusToCache(msg) {
    // listStatus payload (Binance):
    //   g  = orderListId
    //   c  = listClientOrderId
    //   l  = listStatusType   (RESPONSE | EXEC_STARTED | UPDATED | ALL_DONE)
    //   L  = listOrderStatus  (EXECUTING | ALL_DONE | REJECT)
    //   r  = listRejectReason
    //   T  = transactionTime
    //   O  = orders          [{s, i, c}, ...]
    if (msg.g === undefined) return;
    try {
        const raw = await redis.get('BINANCE:ORDER_LISTS:ALL');
        const lists = raw ? JSON.parse(raw) : [];
        const idx = lists.findIndex(x => x.orderListId === msg.g);

        const row = {
            orderListId:        msg.g,
            contingencyType:    'OCO',
            listStatusType:     msg.l,
            listOrderStatus:    msg.L,
            listClientOrderId:  msg.c,
            transactionTime:    msg.T,
            symbol:             msg.s,
            orders:             (msg.O || []).map(o => ({
                symbol:        o.s,
                orderId:       o.i,
                clientOrderId: o.c,
            })),
        };

        if (msg.L === 'ALL_DONE') {
            // Resolved — drop from the open lists cache.
            if (idx >= 0) lists.splice(idx, 1);
        } else {
            if (idx >= 0) lists[idx] = row;
            else lists.push(row);
        }
        await redis.set('BINANCE:ORDER_LISTS:ALL', JSON.stringify(lists));
    } catch (err) {
        console.warn('[WS] applyListStatusToCache failed:', err.message);
    }
}

// Send a single request/response pair over a short-lived WS-API connection.
// Used for both `userDataStream.start` (one-shot on boot) and
// `userDataStream.ping` (every 25 min keepalive). Each call opens, sends,
// reads one frame, and closes — there's nothing else to multiplex here.
function wsApiCall(method, params = {}, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        // Binance requires `id` to match ^[a-zA-Z0-9-_]{1,36}$. A plain UUID
        // is 36 chars of [a-f0-9-] and fits exactly. Don't embed the method
        // (it contains a dot) or unbounded counters.
        const id = (require('crypto').randomUUID && require('crypto').randomUUID())
            || (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 14));
        const sock = new WebSocket(WS_API_URL);
        const timer = setTimeout(() => {
            try { sock.terminate(); } catch (_) {}
            reject(new Error(`WS-API ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        sock.on('open', () => {
            sock.send(JSON.stringify({ id, method, params }));
        });
        sock.on('message', (raw) => {
            clearTimeout(timer);
            try { sock.close(); } catch (_) {}
            let msg;
            try { msg = JSON.parse(raw); }
            catch (e) { return reject(new Error(`WS-API ${method} non-JSON reply: ${raw.toString().slice(0, 200)}`)); }
            if (msg.status && msg.status >= 400) {
                const errMsg = msg.error?.msg || msg.error?.message || JSON.stringify(msg.error || msg);
                return reject(new Error(`WS-API ${method} ${msg.status}: ${errMsg}`));
            }
            resolve(msg.result || {});
        });
        sock.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

// 🔹 Step 1: Create Listen Key (via WebSocket API — REST endpoint is 410 Gone)
async function createListenKey() {
    if (!API_KEY) {
        console.warn('⚠️ Cannot create ListenKey — BINANCE_API_KEY is not set.');
        return null;
    }
    try {
        console.log('🔑 Requesting UserDataStream ListenKey via WS-API...');
        const result = await wsApiCall('userDataStream.start', { apiKey: API_KEY });
        if (!result.listenKey) {
            throw new Error(`No listenKey in WS-API response: ${JSON.stringify(result)}`);
        }
        listenKey = result.listenKey;
        console.log('✅ UserDataStream ListenKey created:', listenKey);
        return listenKey;
    } catch (err) {
        console.error('❌ Failed to create ListenKey:', err.message);
        if (err.message && err.message.includes('418')) {
            console.error('🚫 IP Banned (418). Cooling down for 60s before retry...');
            setTimeout(createListenKey, 60000);
        }
        return null;
    }
}

// 🔹 Step 2: Keep Alive (every 25 mins, via WS-API)
async function keepAlive() {
    if (!listenKey || !API_KEY) return;
    try {
        await wsApiCall('userDataStream.ping', { apiKey: API_KEY, listenKey });
        console.log('🔄 UserDataStream ListenKey refreshed');
    } catch (err) {
        console.error('⚠️ KeepAlive Error:', err.message);
        // If the key expired or was reaped, recreate and reconnect the events socket.
        if (/not found|404|listenKey/i.test(err.message)) {
            console.log('🔄 ListenKey expired, recreating...');
            const key = await createListenKey();
            if (key) connectWS();
        }
    }
}

// 🔹 Step 3: Connect WebSocket
function connectWS() {
    if (!listenKey) return;
    if (ws) {
        try { ws.terminate(); } catch (e) {}
    }

    console.log(`[WS] Connecting to User Data Stream: wss://stream.binance.com:9443/ws/${listenKey}`);
    ws = new WebSocket(`wss://stream.binance.com:9443/ws/${listenKey}`);

    ws.on('open', () => {
        console.log('🟢 User Data Stream Connected');
    });

    ws.on('message', async (data) => {
        try {
            const msg = JSON.parse(data);

            // 🔥 Order execution events — every order placement, fill,
            //    partial fill, cancellation. Drives the open-orders cache.
            if (msg.e === 'executionReport') {
                const executionData = {
                    symbol:      msg.s,
                    orderId:     msg.i,
                    status:      msg.X,    // NEW, PARTIALLY_FILLED, FILLED, CANCELED, EXPIRED, etc.
                    executedQty: msg.z,
                    price:       msg.p,
                    side:        msg.S,
                    type:        msg.o,
                };
                console.log(`📈 Order Update: ${msg.s} | ${msg.X} | Qty: ${msg.z}`);

                // Reflect the change in the open-orders cache so the
                // dashboard is correct without waiting for a REST refresh.
                await applyOrderEventToCache(msg);

                await redis.set('BINANCE:LAST_ORDER_UPDATE', JSON.stringify(msg));
                if (io) io.emit('order-execution', executionData);
                if (executionCallback) executionCallback(executionData);
            }

            // 🔥 OCO list status updates. Fires when an OCO is placed
            //    (EXECUTING) and again when it resolves (ALL_DONE). The
            //    Fast Scalper polls Redis for ALL_DONE; pushing it via
            //    WS means it reacts within ~100 ms instead of 2 s.
            if (msg.e === 'listStatus') {
                console.log(`📋 OCO List ${msg.l} list=${msg.g} status=${msg.L}`);
                await applyListStatusToCache(msg);
                if (io) io.emit('oco-update', msg);
            }

            // 🔥 Balance updates. outboundAccountPosition fires after
            //    every fill / cancel; balanceUpdate fires on transfers.
            if (msg.e === 'outboundAccountPosition' || msg.e === 'balanceUpdate') {
                console.log('💰 Balance Update Received');
                const balances = (msg.B || []).map(b => ({
                    asset:  b.a,
                    free:   b.f,
                    locked: b.l,
                })).filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);

                await redis.set('BINANCE:BALANCES:ALL', JSON.stringify(balances));
                const usdt = balances.find(b => b.asset === 'USDT');
                if (usdt) {
                    await redis.set('BINANCE:BALANCE:USDT', JSON.stringify({ free: usdt.free, locked: usdt.locked }));
                }
                if (io) io.emit('balance-update', balances);
            }

        } catch (err) {
            console.error('[WS] Message Error:', err.message);
        }
    });

    ws.on('close', () => {
        console.log('🔴 User Data Stream Closed. Reconnecting in 10s...');
        setTimeout(connectWS, 10000);
    });

    ws.on('error', (err) => {
        console.error('❌ WS Error:', err.message);
        if (err.message.includes('418')) {
            console.error('🚫 IP Banned (418). Cooling down for 60s...');
            setTimeout(connectWS, 60000);
        }
    });
}

// 🔹 Step 4: 24h Mini-Ticker Stream (replaces per-symbol REST /api/v3/ticker/24hr)
//
// The !miniTicker@arr stream pushes a snapshot of every spot pair's 24h
// rolling stats every second. We unpack and store a per-symbol entry so
// callers (e.g. server.js refreshAnalysisMetrics) can do a sync map lookup
// instead of issuing a REST call per symbol.
//
// Mini-ticker payload field mapping (Binance docs):
//   s = symbol           c = close (last) price
//   o = open price       h = high price
//   l = low price        v = base asset volume (24h)
//   q = quote asset volume (24h, USDT for *USDT pairs) ← what we mainly need
function connectTickerStream() {
    if (tickerWs) {
        try { tickerWs.terminate(); } catch (_) {}
    }
    const url = 'wss://stream.binance.com:9443/ws/!miniTicker@arr';
    console.log('[WS] Connecting to 24h mini-ticker stream:', url);
    tickerWs = new WebSocket(url);

    tickerWs.on('open', () => {
        console.log('🟢 24h mini-ticker stream connected');
    });

    tickerWs.on('message', (raw) => {
        try {
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return;
            const now = Date.now();
            for (const t of arr) {
                if (!t || !t.s) continue;
                tickerCache.set(t.s, {
                    lastPrice:   t.c,
                    quoteVolume: t.q,
                    openPrice:   t.o,
                    highPrice:   t.h,
                    lowPrice:    t.l,
                    volume:      t.v,
                    ts: now,
                });
            }
        } catch (err) {
            // Malformed frames are rare; don't spam the log.
        }
    });

    tickerWs.on('close', () => {
        console.log('🔴 24h mini-ticker stream closed. Reconnecting in 5s...');
        clearTimeout(tickerReconnectTimer);
        tickerReconnectTimer = setTimeout(connectTickerStream, 5000);
    });

    tickerWs.on('error', (err) => {
        console.error('❌ Mini-ticker WS error:', err.message);
    });
}

/**
 * Synchronously read a cached 24h ticker for a symbol (e.g. "BTCUSDT").
 * Returns null until the first WS frame arrives (~1 second after start).
 *
 * Object shape matches Binance's REST /api/v3/ticker/24hr (subset):
 *   { lastPrice, quoteVolume, openPrice, highPrice, lowPrice, volume, ts }
 */
function getTicker24h(symbol) {
    if (!symbol) return null;
    return tickerCache.get(symbol.toUpperCase()) || null;
}

async function start(socketIo, onExecution = null) {
    io = socketIo;
    executionCallback = onExecution;
    await loadCredentials();

    // 24h mini-ticker stream is public — start it before user-data so the
    // analysis cache has data to read by the time symbols are scored.
    connectTickerStream();

    const key = await createListenKey();
    if (key) {
        connectWS();
        clearInterval(keepAliveTimer);
        keepAliveTimer = setInterval(keepAlive, 25 * 60 * 1000);
    }

    // One-shot snapshot so the dashboard isn't empty before the first
    // user-data event arrives. There is no Binance WebSocket "give me
    // current state" frame — the User Data Stream only emits deltas
    // when something changes. So one REST call at boot is unavoidable.
    //
    // After this, every change (new order, fill, cancel, OCO list status)
    // arrives via WebSocket within ~100 ms and updates the cache via
    // applyOrderEventToCache / applyListStatusToCache. No polling.
    if (API_KEY && SECRET_KEY) {
        refreshAllSnapshots().then(() => {
            console.log('📊 Initial Binance snapshot loaded — WS now drives all updates');
        });
        // Stop any prior periodic snapshot timer (left over from earlier
        // versions). We do not start a new one — WebSocket deltas are
        // authoritative from this point on.
        clearInterval(snapshotTimer);
        snapshotTimer = null;
    }
}

module.exports = {
    start,
    getTicker24h,
    binanceFetch,           // signed REST — used by dust-transfer, cancel-order, etc.
    refreshAllSnapshots,    // exposed so server.js can force a refresh after a manual order
};
