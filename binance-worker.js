const WebSocket = require('ws');
const Redis = require('ioredis');
const https = require('https');
const crypto = require('crypto');
require('dotenv').config();

let API_KEY = process.env.BINANCE_API_KEY;
let SECRET_KEY = process.env.BINANCE_SECRET_KEY;
const BASE_URL = 'https://api.binance.com';
const BINANCE_HOST = 'api.binance.com';

// Snapshot refresh cadence (REST). The User Data Stream pushes deltas on
// every change, but it only fires AFTER something changes — so initial
// state and quiet periods need a periodic snapshot to keep the dashboard
// honest. 30 s is a reasonable balance between responsiveness and
// Binance's IP weight budget (each call is ~10-20 weight, /1200 budget).
const SNAPSHOT_REFRESH_MS = 30 * 1000;
let snapshotTimer = null;

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
    try {
        const orders = await binanceFetch('/api/v3/openOrders', 'GET', {});
        if (!Array.isArray(orders)) return;
        await redis.set('BINANCE:OPEN_ORDERS:ALL', JSON.stringify(orders));
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

async function refreshAllSnapshots() {
    // Run in parallel — they hit different endpoints so weight is split.
    await Promise.allSettled([
        refreshBalanceSnapshot(),
        refreshOpenOrdersSnapshot(),
        refreshOrderListsSnapshot(),
    ]);
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

            // 🔥 Handle Order Execution Updates
            if (msg.e === 'executionReport') {
                const executionData = { 
                    symbol: msg.s, 
                    orderId: msg.i, 
                    status: msg.X, 
                    executedQty: msg.z, 
                    price: msg.p 
                };
                console.log(`📈 Order Update: ${msg.s} | ${msg.X} | Qty: ${msg.z}`);
                
                await redis.set('BINANCE:LAST_ORDER_UPDATE', JSON.stringify(msg));
                if (io) io.emit('order-execution', executionData);
                if (executionCallback) executionCallback(executionData);
            }

            // 🔥 Handle Balance Updates
            if (msg.e === 'outboundAccountPosition' || msg.e === 'balanceUpdate') {
                console.log('💰 Balance Update Received');
                const balances = msg.B.map(b => ({
                    asset: b.a,
                    free: b.f,
                    locked: b.l
                })).filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
                
                await redis.set('BINANCE:BALANCES:ALL', JSON.stringify(balances));
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
    // user-data event arrives. WS gives us deltas; this gives us state.
    if (API_KEY && SECRET_KEY) {
        refreshAllSnapshots().then(() => {
            console.log('📊 Initial Binance snapshot loaded (balances + open orders + OCO lists)');
        });
        // Periodic refresh: cheap insurance against missed deltas (e.g. if
        // the user-data WS reconnected during a fill). Cancels and reschedules
        // on every start() to avoid duplicate timers across hot-reloads.
        clearInterval(snapshotTimer);
        snapshotTimer = setInterval(refreshAllSnapshots, SNAPSHOT_REFRESH_MS);
    }
}

module.exports = {
    start,
    getTicker24h,
    binanceFetch,           // signed REST — used by dust-transfer, cancel-order, etc.
    refreshAllSnapshots,    // exposed so server.js can force a refresh after a manual order
};
