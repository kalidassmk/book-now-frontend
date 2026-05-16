const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Redis = require('ioredis');
const path = require('path');
const { spawn } = require('child_process');
// Node v20+ has native fetch built-in — no extra package needed


// ─── Config ─────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const POLL_MS = 1500;   // Reduced from 400ms to 1500ms to lower Redis load
// BookNow Python engine (replaces the old Engine backend in 2026-Q2).
// Path layout matches Spring's: /api/v1/* trading + /api/v1/binance/* dashboard
// reads + /api/wallet/* balances. Override with BOOKNOW_ENGINE_BASE if the
// engine runs on a different host/port (e.g. behind a reverse proxy).
const ENGINE_PORT = parseInt(process.env.BOOKNOW_ENGINE_PORT || '8083', 10);
const ENGINE_BASE = process.env.BOOKNOW_ENGINE_BASE
    || `http://localhost:${ENGINE_PORT}/api/v1`;
const ENGINE_DIR = path.resolve(__dirname, '../python-engine');
// Backwards-compat alias for any module that still imports SPRING_BASE.
// New code should use ENGINE_BASE; this can be removed once the dashboard
// frontend bundle is rebuilt.
const SPRING_BASE = ENGINE_BASE;

// ─── Engine process handle ──────────────────────────────────────────────────
let engineProc = null;   // ChildProcess when we own the python-engine process

// ─── Auto-trade defaults (user can change via dashboard) ────────────────────
let autoConfig = {
    enabled: false,    // auto-trade on/off
    profitPct: 1.5,      // sell when gain reaches X%
    stopLossPct: 0.8,      // sell if loss exceeds X%
    maxPositions: 5,        // max simultaneous open positions
    simulationMode: true,     // true = paper trade only
    displayLimit: 30,       // max fast movers to display
};

// ─── Redis keys (must match Constant.java exactly) ──────────────────────────
const FAST_MOVE_KEY = 'FAST_MOVE';       // Constant.FAST_MOVE
const LT2MIN_KEY    = 'LT2MIN_0>3';     // Constant.LT2MIN_0_TO_3
const UF_0_2_KEY    = 'ULTRA_FAST0>2';  // Constant.ULTRA_FAST_0_TO_2
const UF_2_3_KEY    = 'ULTRA_FAST2>3';  // Constant.ULTRA_FAST_2_TO_3
const UF_0_3_KEY    = 'ULTRA_FAST0>3';  // Constant.ULTRA_FAST_0_TO_3
const UF_3_5_KEY    = 'ULTRA_FAST>3<5';  // Constant.ULTRA_FAST_3_5
const SF_2_3_KEY    = 'SUPER_FAST>2<3';  // Constant.SUPER_FAST_2_3
const USF_5_7_KEY   = 'ULTRA_SUPER_FAST>5<7'; // Constant.ULTRA_SUPER_FAST_5_7
const CURRENT_PRICE = 'CURRENT_PRICE';
const BUY_KEY       = 'BUY';
const SELL_KEY      = 'SELL';
const SIGNAL_PREFIX = 'SCALPER:SIGNAL:'; // Matrix data from Python scalper
const ANALYSIS_020_KEY = 'ANALYSIS_020_TIMELINE'; // Success trend data
const VIRTUAL_POSITIONS = 'VIRTUAL_POSITIONS:MICRO';
const VIRTUAL_HISTORY   = 'VIRTUAL_HISTORY:MICRO';


// ─── State ───────────────────────────────────────────────────────────────────
const positions = new Map();   // symbol → { buyPrice, qty, buyTime, target, stopLoss }
const tradeLog = [];          // all completed/active trades
let totalPnL = 0;
const USDT_INR_RATE = 92; // Approximate rate for decision making
const tradeStatusMap = new Map(); // Track symbol -> status to detect execution
const analysisCache = new Map(); // symbol → { high2m, low2m, avg2m, vol30dAvg, vol7dAvg, lastUpdated }
const activeLimitOrders = new Map(); // symbol → { orderId, symbol, side, limitPrice, qty, status, time }
const CACHE_TTL = 30 * 60 * 1000; // 30 mins

// ─── Setup ───────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.json());

// iter 24 (2026-05-13): '/' now serves the bot-monitor page (operational
// at-a-glance status). The old scanner UI is preserved at '/scanner' and
// '/index.html'. Register these BEFORE the static middleware so the
// custom '/' route wins over public/index.html.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'monitor.html')));
app.get('/scanner', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Disable browser caching for HTML so dashboard updates land immediately
// after a deploy. Static assets (JS/CSS bundles, images) get sane defaults.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
    }
  },
}));

// ── Binance Worker ───────────────────────────────────────────────────────────
const binanceWorker = require('./binance-worker');
binanceWorker.start(io, handleExecution);

// If the worker is in the same process, it calls handleExecution directly.
function handleExecution(event) {
    const { symbol, orderId, status, executedQty, price } = event;
    console.log(`[Event-Driven] Processing ${symbol} execution: ${status}`);

    const order = activeLimitOrders.get(orderId);
    if (!order) return;

    order.status = status;
    order.executedQty = executedQty;

    if (status === 'FILLED') {
        activeLimitOrders.delete(orderId);

        positions.set(symbol, {
            symbol,
            buyPrice: parseFloat(price),
            qty: parseFloat(executedQty),
            buyTime: Date.now(),
            status: 'FILLED'
        });
        console.log(`[Event-Driven] Position created for ${symbol} @ ${price}`);
    }

    io.emit('order-update', order);
}

const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT, lazyConnect: true });
const subRedis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });
// iter 15 fe (2026-05-15): connection to analyse DB for pattern storage.
// `booknow-redis-analyse` already holds PATTERNS:V2:SYM:* + vp_history:*
// — we store EARLY_PUMP:* detections here to build a pattern library.
const REDIS_ANALYSE_HOST = process.env.REDIS_ANALYSE_HOST || 'booknow-redis-analyse';
const REDIS_ANALYSE_PORT = parseInt(process.env.REDIS_ANALYSE_PORT || '6379', 10);
const redisAnalyse = new Redis({
    host: REDIS_ANALYSE_HOST,
    port: REDIS_ANALYSE_PORT,
    lazyConnect: true,
    retryStrategy: (times) => Math.min(times * 100, 3000),
});
redisAnalyse.on('error', e => console.error('[Server] Analyse-Redis Error:', e.message));

redis.on('error', e => console.error('[Server] Redis Error:', e.message));
subRedis.on('error', e => console.error('[Server] Sub-Redis Error:', e.message));

// Listen for detailed signals from Scalper
subRedis.subscribe('BINANCE_SIGNALS', (err) => {
    if (err) console.error('[Server] Failed to subscribe to signals:', err.message);
});

subRedis.on('message', (channel, message) => {
    if (channel === 'BINANCE_SIGNALS') {
        try {
            const payload = JSON.parse(message);
            io.emit('scalper-signal', payload);
        } catch (e) {
            console.error('[Server] Signal parse error:', e.message);
        }
    }
});

redis.on('connect', async () => {
    console.log('[Server] Redis Connected ✅');
    
    // Sync API Keys to Redis for Workers and Python Scripts
    const apiKey = process.env.BINANCE_API_KEY;
    const secretKey = process.env.BINANCE_SECRET_KEY;
    
    if (apiKey && secretKey) {
        await redis.set('BINANCE_API_KEY', apiKey);
        await redis.set('BINANCE_SECRET_KEY', secretKey);
        console.log('[Config] 🛡️ API Credentials synchronized to Redis.');
    } else {
        console.warn('[Config] ⚠️ API Keys missing in .env! Redis sync skipped.');
    }

    // Bulletproof Sync: Re-prime keys every 60 seconds in case of Redis FLUSHALL
    setInterval(async () => {
        if (apiKey && secretKey) {
            await redis.set('BINANCE_API_KEY', apiKey);
            await redis.set('BINANCE_SECRET_KEY', secretKey);
        }
    }, 60 * 1000);
});

io.on('connection', (socket) => {
    console.log(`[Socket] Client connected: ${socket.id}`);
    socket.on('disconnect', () => console.log(`[Socket] Client disconnected: ${socket.id}`));
});

/**
 * Check Binance via Engine for real order status (FILLED, PARTIAL, etc.)
 */
async function checkBinanceOrderStatus(symbol, orderId) {
    try {
        const url = `${SPRING_BASE}/order/status/${symbol}/${orderId}`;
        console.log(`[Engine] GET /order/status/${symbol}/${orderId}`);
        const res = await fetch(url);
        if (!res.ok) {
            console.warn(`[Engine] Status check failed: ${res.status}`);
            return;
        }

        const data = await res.json();
        console.log(`[Engine] Status check result for ${symbol}: ${data.status}`);
        const status = data.status; // e.g. "FILLED", "PARTIALLY_FILLED", "NEW"
        
        const order = activeLimitOrders.get(orderId);
        if (order && (order.status !== status || order.executedQty !== data.executedQty)) {
            order.status = status;
            order.executedQty = data.executedQty;
            order.origQty = data.origQty;
            console.log(`[Order] ${symbol} updated to ${status} (Executed: ${data.executedQty}/${data.origQty})`);
            io.emit('order-update', order);

            if (status === 'FILLED' || status === 'CANCELED' || status === 'EXPIRED') {
                activeLimitOrders.delete(orderId);
                if (status === 'FILLED') {
                    // Refresh positions to show the new position
                }
            }
        }
    } catch (e) {
        console.error(`[Order Monitor] Failed to check status for ${symbol}:`, e.message);
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function safeJson(raw) {
    try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

async function getList(key, start = 0, end = -1) {
    try {
        const raw = await redis.lrange(key, start, end);
        return raw.map(item => JSON.parse(item));
    } catch (e) {
        return [];
    }
}

async function getAllHash(key) {
    const raw = await redis.hgetall(key);
    if (!raw) return {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
        out[k] = safeJson(v) || v;
    }
    return out;
}

function currentPriceOf(sym, priceHash) {
    const entry = priceHash[sym];
    if (!entry) return 0;
    if (typeof entry === 'object') {
        // Handle cases where price is a BigDecimal object or nested
        const p = entry.price?.value ?? entry.price ?? entry.currentPrice ?? 0;
        return typeof p === 'object' ? parseFloat(p.value ?? 0) : parseFloat(p);
    }
    return parseFloat(entry) || 0;
}

/**
 * Fetch 60-day klines and 24h ticker for a symbol and cache the metrics.
 */
async function refreshAnalysisMetrics(symbol) {
    try {
        // 60-day daily klines stay on REST — there's no historical kline WS.
        // 24h ticker comes from the binance-worker !miniTicker@arr cache, so
        // this function now does ONE REST call instead of two.
        const klinesRes = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=60`);
        const klines = await klinesRes.json();

        if (!Array.isArray(klines) || klines.length < 14) return null;

        const closes    = klines.map(k => parseFloat(k[4]));
        const highs     = klines.map(k => parseFloat(k[2]));
        const lows      = klines.map(k => parseFloat(k[3]));
        const quoteVols = klines.map(k => parseFloat(k[7]));

        // Prefer the live mini-ticker cache; on a cold start (first ~1s) it
        // may be empty, in which case fall back to the most recent daily
        // candle's quote volume — close enough for the score and zero REST.
        const cachedTicker = binanceWorker.getTicker24h ? binanceWorker.getTicker24h(symbol) : null;
        const vol24h = cachedTicker
            ? parseFloat(cachedTicker.quoteVolume || 0)
            : (quoteVols[quoteVols.length - 1] || 0);

        const metrics = {
            high2m:    Math.max(...highs),
            low2m:     Math.min(...lows),
            low7d:     Math.min(...lows.slice(-7)),
            low14d:    Math.min(...lows.slice(-14)),
            low30d:    Math.min(...lows.slice(-30)),
            low60d:    Math.min(...lows),
            avg2m:     closes.reduce((a, b) => a + b, 0) / closes.length,
            vol30dAvg: quoteVols.slice(-30).reduce((a, b) => a + b, 0) / 30,
            vol7dAvg:  quoteVols.slice(-7).reduce((a, b) => a + b, 0) / 7,
            vol24h,
            quoteVols, // keep for rising vol check
            lastUpdated: Date.now()
        };
        analysisCache.set(symbol, metrics);
        return metrics;
    } catch (e) {
        console.error(`[Analysis] Failed for ${symbol}:`, e.message);
        return null;
    }
}

/**
 * Calculate the 0-7 score based on live price and cached metrics.
 */
function calculateScore(symbol, currentPrice, metrics) {
    if (!metrics || !currentPrice) return { score: 0, rec: '...' };

    let score = 0;
    const pricePos = (metrics.high2m - metrics.low2m) > 0
        ? ((currentPrice - metrics.low2m) / (metrics.high2m - metrics.low2m) * 100)
        : 50;

    if (currentPrice < metrics.avg2m) score++;
    if (pricePos < 40) score++;
    // Simple volume check (vs 30d avg)
    if (metrics.vol30dAvg > 0) {
        // We don't have live 24h vol here easily without extra fetch,
        // but we can assume if it's in FAST_MOVE, it has volume.
        // For simplicity in the loop, we focus on price metrics.
        score++;
    }

    const rec = score >= 5 ? 'STRONG_BUY' : score === 4 ? 'BUY' : score === 3 ? 'NEUTRAL' : score === 2 ? 'WAIT' : 'DONT_BUY';

    // Publish score to Redis so Engine ConsensusCoordinator can read it
    redis.hset('DASHBOARD_SCORE', symbol, JSON.stringify({
        score, recommendation: rec, pricePosition: Math.round(pricePos),
        priceBelowAvg: currentPrice < metrics.avg2m,
        timestamp: Date.now()
    })).catch(() => {});

    return { score, rec };
}

function now() { return Date.now(); }

// ─── Auto-trade Engine ───────────────────────────────────────────────────────
async function runAutoTrade(fastCoins, priceHash) {
    if (!autoConfig.enabled) return;

    for (const [symbol, data] of Object.entries(fastCoins)) {
        const price = currentPriceOf(symbol, priceHash);
        if (!price) continue;

        // ── AUTO BUY ─────────────────────────────────────────────────────────
        if (!positions.has(symbol) && positions.size < autoConfig.maxPositions) {
            const qty = 100 / price;   // invest $100 per position
            const target = price * (1 + autoConfig.profitPct / 100);
            const stop = price * (1 - autoConfig.stopLossPct / 100);

            positions.set(symbol, {
                symbol, buyPrice: price, qty,
                buyTime: now(),
                target, stop,
                signal: data.signal || 'FAST_MOVE',
            });

            const trade = {
                id: `${symbol}-${now()}`,
                symbol, action: 'BUY', price, qty,
                target, stop,
                time: now(),
                status: 'OPEN',
                simulation: autoConfig.simulationMode,
                pnl: 0,
            };
            tradeLog.unshift(trade);
            if (tradeLog.length > 200) tradeLog.pop();

            console.log(`[AUTO BUY]  ${symbol} @ ${price} | target ${target.toFixed(6)} | stop ${stop.toFixed(6)}`);
            io.emit('trade', trade);
        }
    }

    // ── AUTO SELL ─────────────────────────────────────────────────────────────
    for (const [symbol, pos] of positions) {
        const price = currentPriceOf(symbol, priceHash);
        if (!price) continue;

        const pnlPct = ((price - pos.buyPrice) / pos.buyPrice) * 100;
        const hitTarget = price >= pos.target;
        const hitStop = price <= pos.stop;
        const heldTooLong = (now() - pos.buyTime) > 5 * 60 * 1000;  // 5 min timeout

        let reason = null;
        if (hitTarget) reason = `PROFIT_TARGET (+${pnlPct.toFixed(2)}%)`;
        else if (hitStop) reason = `STOP_LOSS (${pnlPct.toFixed(2)}%)`;
        else if (heldTooLong && pnlPct > 0) reason = `TIME_EXIT (+${pnlPct.toFixed(2)}%)`;

        if (reason) {
            const realized = (price - pos.buyPrice) * pos.qty;
            totalPnL += realized;
            positions.delete(symbol);

            const trade = {
                id: `${symbol}-sell-${now()}`,
                symbol, action: 'SELL', price,
                qty: pos.qty,
                buyPrice: pos.buyPrice,
                pnlPct: pnlPct.toFixed(2),
                realizedPnL: realized.toFixed(4),
                reason, time: now(),
                status: 'CLOSED',
                simulation: autoConfig.simulationMode,
            };
            tradeLog.unshift(trade);
            if (tradeLog.length > 200) tradeLog.pop();

            console.log(`[AUTO SELL] ${symbol} @ ${price} | ${reason} | PnL: $${realized.toFixed(4)}`);
            io.emit('trade', trade);
        }
    }
}

// ─── Main Data Loop ──────────────────────────────────────────────────────────
async function tick() {
    try {
        // 1. Fast-move sources
        const [fastMove, lt2min, uf02, uf23, uf03, uf35, sf23, usf57, priceHash, botBuys, botSellsRaw, consensusRaw, profitReachedRaw, analysisTimeline, virtualPositions, virtualHistory, tradingConfigRaw] = await Promise.all([
            getAllHash(FAST_MOVE_KEY),
            getAllHash(LT2MIN_KEY),
            getAllHash(UF_0_2_KEY),
            getAllHash(UF_2_3_KEY),
            getAllHash(UF_0_3_KEY),
            getAllHash(UF_3_5_KEY),
            getAllHash(SF_2_3_KEY),
            getAllHash(USF_5_7_KEY),
            getAllHash(CURRENT_PRICE),
            getAllHash(BUY_KEY),
            getAllHash(SELL_KEY),
            getAllHash('FINAL_CONSENSUS_STATE'),
            getAllHash('PROFIT_REACHED_020'),
            getAllHash(ANALYSIS_020_KEY),
            getAllHash(VIRTUAL_POSITIONS),
            getList(VIRTUAL_HISTORY, 0, 50),
            redis.get('TRADING_CONFIG'),
        ]);
        let tradingConfig = null;
        try { tradingConfig = tradingConfigRaw ? JSON.parse(tradingConfigRaw) : null; } catch { tradingConfig = null; }

        // 2. Merge all fast signals into one map
        const fastCoins = {};

        const mergeSignal = (map, signalName, scoreField) => {
            for (const [sym, d] of Object.entries(map)) {
                let score = 0;
                if (d && typeof d === 'object') {
                    score = parseFloat(d[scoreField] || 0);
                } else if (d) {
                    score = parseFloat(d) || 0;
                }

                if (!fastCoins[sym] || score > (fastCoins[sym].score || 0)) {
                    fastCoins[sym] = {
                        ...fastCoins[sym],
                        signal: signalName,
                        raw: d,
                        score: score
                    };
                }
            }
        };

        mergeSignal(usf57, 'USF_5>7', 'increasedPercentage');
        mergeSignal(uf35,  'UF_3>5',  'increasedPercentage');
        mergeSignal(sf23,  'SF_2>3',  'increasedPercentage');
        mergeSignal(lt2min, 'LT2MIN_0>3', 'increasedPercentage');
        mergeSignal(uf03,   'UF_0>3',     'increasedPercentage');
        mergeSignal(uf02,   'UF_0>2',     'increasedPercentage');
        mergeSignal(uf23,   'UF_2>3',     'increasedPercentage');
        mergeSignal(fastMove, 'FAST_MOVE', 'overAllCount');

        // 3. Convert to list and perform initial sort by signal/score
        const priority = { 
            'USF_5>7': 0, 'UF_3>5': 1, 'SF_2>3': 2, 
            'LT2MIN_0>3': 3, 'UF_0>3': 4, 'UF_0>2': 5, 'UF_2>3': 6, 
            'FAST_MOVE': 7 
        };
        const allCoins = Object.entries(fastCoins).map(([symbol, data]) => ({
            symbol,
            signal: data.signal,
            score: data.score || 0,
            hasPosition: (positions.get(symbol)?.status === 'FILLED' || botBuys[symbol]?.status === 'FILLED')
        }));

        allCoins.sort((a, b) => {
            if (a.hasPosition && !b.hasPosition) return -1;
            if (b.hasPosition && !a.hasPosition) return 1;
            const pA = priority[a.signal] ?? 9;
            const pB = priority[b.signal] ?? 9;
            if (pA !== pB) return pA - pB;
            return (b.score || 0) - (a.score || 0);
        });

        // 4. Slice to display limit
        const limit = autoConfig.displayLimit || 10;
        const displayedRaw = allCoins.slice(0, limit);

        // 5. Enrich only displayed coins with live price and analysis
        const displayed = await Promise.all(displayedRaw.map(async (c) => {
            const { symbol } = c;
            const price = currentPriceOf(symbol, priceHash);
            const botBuy = botBuys[symbol];
            const myPos = positions.get(symbol);
            
            // 🔹 1. Core Rule & 4. P&L Calculation
            const status = myPos?.status || botBuy?.status || 'NEW';
            const isExecuted = status === 'FILLED';
            const bp = myPos?.buyPrice || (botBuy ? parseFloat(botBuy.buyPrice || 0) : null);
            
            const pnlPct = (isExecuted && bp && price) ? ((price - bp) / bp * 100) : 0;

            // Analysis scoring
            let metrics = analysisCache.get(symbol);
            if (!metrics || (Date.now() - metrics.lastUpdated > CACHE_TTL)) {
                // Stagger initial fetches to avoid startup bursts
                const delay = metrics ? 0 : Math.floor(Math.random() * 5000); 
                setTimeout(() => {
                    refreshAnalysisMetrics(symbol).catch(() => {});
                }, delay);
            }
            const { score: aScore, rec } = calculateScore(symbol, price, metrics);

            const isPos = isExecuted;
            let buyUsdt = 0;
            let curUsdt = 0;

            if (isExecuted) {
                if (myPos) {
                    buyUsdt = myPos.qty * myPos.buyPrice;
                    curUsdt = myPos.qty * price;
                } else if (botBuy) {
                    buyUsdt = 30; // Standard bot buy (small-scalp config)
                    curUsdt = bp > 0 ? (price / bp * buyUsdt) : 0;
                }
            }
            const profitUsdt = isExecuted ? (curUsdt - buyUsdt) : 0;

            let newsAnalysis = null;
            try {
                const coinName = symbol.replace('USDT', '');
                const rawNews = await redis.get(`analysis:${coinName}:detailed`);
                if (rawNews) {
                    newsAnalysis = JSON.parse(rawNews);
                }
            } catch(e) {}

            let scalperSignal = null;
            try {
                const rawSig = await redis.get(`${SIGNAL_PREFIX}${symbol}`);
                if (rawSig) {
                    scalperSignal = JSON.parse(rawSig);
                }
            } catch(e) {}

            return {
                ...c,
                analysisScore: aScore,
                recommendation: rec,
                currentPrice: price,
                buyPrice: bp,
                targetPrice:  myPos?.targetPrice || myPos?.target || null,
                pnlPct: isExecuted ? parseFloat(pnlPct.toFixed(3)) : null,
                isPosition: isPos,
                status: status,
                buyUsdt: parseFloat(buyUsdt.toFixed(2)),
                currentUsdt: parseFloat(curUsdt.toFixed(2)),
                profitUsdt: parseFloat(profitUsdt.toFixed(2)),
                profitInr: parseFloat((profitUsdt * USDT_INR_RATE).toFixed(2)),
                botSignal: !!botBuys[symbol],
                scalperSignal: scalperSignal, // Matrix data for "Bot Strategy" column
                consensus: consensusRaw[symbol] || null, // Final Consensus data (4 layers)
                profitReached: !!profitReachedRaw[symbol], // Flag for reaching $0.20 profit
                vol24h: metrics ? metrics.vol24h : 0,
                heldMs: (isExecuted && myPos) ? (now() - myPos.buyTime) : null,
                newsAnalysis: newsAnalysis,
            };
        }));

        // 4. Dashboard (Node) active positions enriched
        const activePositions = Array.from(positions.values()).map(p => {
            const price = currentPriceOf(p.symbol, priceHash);
            const status = p.status || 'FILLED';
            const isExecuted = status === 'FILLED';
            const pnlPct = (isExecuted && price) ? ((price - p.buyPrice) / p.buyPrice * 100) : 0;
            const buyUsdt = p.qty * p.buyPrice;
            const curUsdt = p.qty * (price || p.buyPrice);
            const profitUsdt = isExecuted ? (curUsdt - buyUsdt) : 0;

            return {
                ...p,
                source: 'DASHBOARD',
                status: status,
                currentPrice: price,
                targetPrice:  p.target || null,
                pnlPct: parseFloat(pnlPct.toFixed(3)),
                buyUsdt: parseFloat(buyUsdt.toFixed(2)),
                currentUsdt: parseFloat(curUsdt.toFixed(2)),
                profitUsdt: parseFloat(profitUsdt.toFixed(2)),
                profitInr: parseFloat((profitUsdt * USDT_INR_RATE).toFixed(2)),
                heldSec: isExecuted ? Math.floor((now() - p.buyTime) / 1000) : 0,
                hms: p.hms || new Date(p.buyTime).toLocaleTimeString(),
            };
        });

        // 4b. Engine bot positions — read directly from BUY Redis hash
        //     Buy fields: buyPrice, selP (sell target %), status, hms, buyPercentage
        const botPositions = Object.entries(botBuys)
            .map(([symbol, buy]) => {
                const status = buy?.status ?? 'NEW';
                const isExecuted = status === 'FILLED';
                const bp = parseFloat(
                    buy?.buyPrice?.value ?? buy?.buyPrice ?? 0
                );
                const selP = parseFloat(buy?.selP ?? 0);
                const currentPrice = currentPriceOf(symbol, priceHash);
                const targetPrice  = bp > 0 ? bp * (1 + selP / 100) : null;
                const pnlPct = (isExecuted && bp > 0 && currentPrice)
                    ? parseFloat(((currentPrice - bp) / bp * 100).toFixed(3))
                    : 0;
                const buyUsdt = 50; // Standard bot buy is $50/leg (2026-05-12 iter 12 sizing)
                const curUsdt = (isExecuted && bp > 0 && currentPrice) ? (currentPrice / bp * buyUsdt) : 0;
                const profitUsdt = isExecuted ? (curUsdt - buyUsdt) : 0;

                return {
                    symbol,
                    source:       'BOT',
                    buyPrice:     bp,
                    selP,
                    targetPrice:  targetPrice ? parseFloat(targetPrice.toFixed(8)) : null,
                    currentPrice,
                    pnlPct,
                    buyUsdt:      parseFloat(buyUsdt.toFixed(2)),
                    currentUsdt:  parseFloat(curUsdt.toFixed(2)),
                    profitUsdt:   parseFloat(profitUsdt.toFixed(2)),
                    profitInr:    parseFloat((profitUsdt * USDT_INR_RATE).toFixed(2)),
                    status:       status,
                    hms:          buy?.hms ?? null,
                    buyPct:       parseFloat(buy?.buyPercentage ?? 0),
                    orderId:      buy?.orderId ?? null,
                    executedQty:  buy?.executedQty ?? null,
                    origQty:      buy?.origQty ?? null,
                };
            })
            .filter(b => b.buyPrice > 0 && b.status !== 'Y')   // ignore sold/empty entries
            .sort((a, b) => (b.pnlPct ?? -999) - (a.pnlPct ?? -999));

        // Detect Status Changes (Execution Alert)
        botPositions.forEach(p => {
            const oldStatus = tradeStatusMap.get(p.symbol);
            if (oldStatus === 'PENDING' && p.status !== 'PENDING') {
                io.emit('trade-executed', { ...p, action: 'BUY' });
                console.log(`[Alert] ${p.symbol} order filled!`);
            }
            tradeStatusMap.set(p.symbol, p.status);
        });
        // Cleanup old status tracking
        for (const sym of tradeStatusMap.keys()) {
            if (!botPositions.find(p => p.symbol === sym)) tradeStatusMap.delete(sym);
        }

        // ── 3. Monitor Active Limit Orders ──────────────────────────────────
        for (const order of activeLimitOrders.values()) {
            const cp = priceHash[order.symbol];
            if (!cp) continue;

            const current = parseFloat(cp.price);
            const limit = order.limitPrice;
            const isHit = order.side === 'BUY' ? current <= limit : current >= limit;

            if (isHit) {
                // Price hit! Check Binance for real status
                checkBinanceOrderStatus(order.symbol, order.orderId);
            }
        }

        // 4c. Engine sell history — from SELL Redis hash
        //     Sell fields: sellingPoint (sell price), status, timestamp, sellMaxPercentage, buy (nested)
        const botSells = Object.entries(botSellsRaw)
            .map(([symbol, sell]) => {
                const sellPrice = parseFloat(sell?.sellingPoint ?? 0);
                const buyPrice  = parseFloat(
                    sell?.buy?.buyPrice?.value ?? sell?.buy?.buyPrice ?? 0
                );
                const sellPct   = parseFloat(sell?.buy?.selP ?? 0);
                const pnlPct    = (buyPrice > 0 && sellPrice > 0)
                    ? parseFloat(((sellPrice - buyPrice) / buyPrice * 100).toFixed(3))
                    : null;
                const pnlUsdt   = (buyPrice > 0 && sellPrice > 0)
                    ? parseFloat(((sellPrice - buyPrice) / buyPrice * 100).toFixed(4))  // $100 position
                    : 0;
                const ts        = sell?.timestamp ?? null;
                return {
                    symbol,
                    sellPrice,
                    buyPrice,
                    sellPct,
                    pnlPct,
                    pnlUsdt,
                    pnlInr: parseFloat((pnlUsdt * USDT_INR_RATE).toFixed(2)),
                    status: sell?.status ?? 'Y',
                    ts,
                };
            })
            .filter(s => s.sellPrice > 0)
            .sort((a, b) => {
                // Sort by timestamp descending (most recent first)
                if (a.ts && b.ts) return b.ts - a.ts;
                return 0;
            });


        // 5. Account Data (from Binance Worker)
        const [binanceOrdersRaw, binanceTradesRaw, binanceOrderListsRaw, binanceBalancesRaw, usdtFree] = await Promise.all([
            redis.get('BINANCE:OPEN_ORDERS:ALL'),
            redis.get('BINANCE:TRADE_HISTORY:ALL'),
            redis.get('BINANCE:ORDER_LISTS:ALL'),
            redis.get('BINANCE:BALANCES:ALL'),
            redis.get('BINANCE:BALANCE:USDT')
        ]);

        const openOrders = binanceOrdersRaw ? JSON.parse(binanceOrdersRaw) : [];
        const tradeHistory = binanceTradesRaw ? JSON.parse(binanceTradesRaw) : [];
        const orderLists = binanceOrderListsRaw ? JSON.parse(binanceOrderListsRaw) : [];
        const balances = binanceBalancesRaw ? JSON.parse(binanceBalancesRaw) : [];

        // Enrich balances with current prices to calculate USDT value
        balances.forEach(b => {
            if (b.asset === 'USDT') {
                b.valueUsdt = (parseFloat(b.free) + parseFloat(b.locked)).toFixed(2);
            } else {
                const price = currentPriceOf(b.asset + 'USDT', priceHash);
                if (price > 0) {
                    b.valueUsdt = ((parseFloat(b.free) + parseFloat(b.locked)) * price).toFixed(2);
                } else {
                    b.valueUsdt = '0.00';
                }
            }
        });
        


        let usdtAmount = 0;
        if (usdtFree) {
            try {
                const parsed = JSON.parse(usdtFree);
                usdtAmount = parseFloat(parsed.free || 0);
            } catch (e) {
                usdtAmount = parseFloat(usdtFree); // Fallback if it's still a plain string
            }
        }

        const configRaw = await redis.get(CONFIG_KEY);
        const config = configRaw ? JSON.parse(configRaw) : { autoBuyEnabled: false };

        const stats = {
            fastCount: allCoins.length,
            positions: positions.size,
            botPositions: botPositions.length,
            botSells: botSells.length,
            totalPnL: parseFloat(totalPnL.toFixed(4)),
            usdtBalance: usdtAmount,
            autoEnabled: config.autoBuyEnabled, // Dynamic from Redis
            buyAmount: config.buyAmountUsdt || 48,
            profitPct: config.profitPct || 0.5,
            profitAmount: config.profitAmountUsdt || 0.15,
            simulation: autoConfig.simulationMode,
            redisOk: true,
            walletAssets: balances.length,
            ts: now(),
        };

        // 6. Auto-trade (runs on ALL fast coins, not just displayed ones)
        await runAutoTrade(fastCoins, priceHash);

        // Update stat to show total detected vs displayed
        stats.fastCount = Object.keys(fastCoins).length;
        stats.fastDisplayed = displayed.length;


        const behavioralSentiment = await getAdaptiveSentiment();
        const volumeScores = await getVolumeScores();
        const scalperSignals = await getScalperSignals();
        
        const feeIntelRaw = await redis.get('TRADING_FEE_INTELLIGENCE');
        
        // Optimization: Create a "Latest Only" summary for the Hub to reduce payload size
        const latestAnalysis = {};
        // Trim full timelines so we don't OOM the Node heap. Up to 100
        // snapshots × ~200 coins is ~10-20 MB per broadcast at 1.5 s — that
        // crashed the frontend container with "Reached heap limit". The
        // dashboards (profit_analysis trajectory chart, intelligence_hub
        // sequence detection) only need the most recent ~30 snapshots.
        const TIMELINE_TRIM = 30;
        const trimmedTimeline = {};
        Object.keys(analysisTimeline).forEach(sym => {
            const history = analysisTimeline[sym];
            if (Array.isArray(history) && history.length > 0) {
                latestAnalysis[sym] = history[history.length - 1];
                trimmedTimeline[sym] = history.length > TIMELINE_TRIM
                    ? history.slice(-TIMELINE_TRIM)
                    : history;
            } else {
                trimmedTimeline[sym] = history;
            }
        });

        // [AUDIT] Final broadcast packet - optimized
        io.emit('update', {
            coins: displayed,
            activePositions: Array.from(positions.values()),
            botPositions,
            botSells,
            openOrders,
            tradeHistory,
            orderLists,
            balances,
            stats,
            behavioralSentiment,
            volumeScores,
            scalperSignals,
            profitTimeline: profitReachedRaw,
            analysisTimeline: latestAnalysis, // Send only latest for most coins
            fullTimeline: trimmedTimeline,    // Trimmed to last 30 snapshots/coin
            virtualPositions,
            virtualHistory,
            tradingConfig,
            feeStats: feeIntelRaw ? JSON.parse(feeIntelRaw) : null,
            ts: now()
        });

    } catch (e) {
        console.error('[Tick]', e.message);
    }
}

async function getScalperSignals() {
    try {
        const keys = await redis.keys('BINANCE:SIGNAL:*');
        if (keys.length === 0) return {};
        const pipeline = redis.pipeline();
        keys.forEach(k => pipeline.get(k));
        const results = await pipeline.exec();
        const data = {};
        results.forEach((r, i) => {
            if (r && r[1]) {
                const parsed = JSON.parse(r[1]);
                data[parsed.symbol] = parsed;
            }
        });
        return data;
    } catch (e) {
        console.error('[Scalper Signals] Error:', e.message);
        return {};
    }
}

async function getAdaptiveSentiment() {
    try {
        const keys = await redis.keys('sentiment:market:adaptive:*');
        if (keys.length === 0) return {};
        const pipeline = redis.pipeline();
        keys.forEach(k => pipeline.get(k));
        const results = await pipeline.exec();
        const data = {};
        results.forEach((r, i) => {
            if (r && r[1]) {
                const parsed = JSON.parse(r[1]);
                data[parsed.symbol.replace('/USDT', '').replace('/', '')] = parsed;
            }
        });
        return data;
    } catch (e) {
        console.error('[Adaptive Sentiment] Error:', e.message);
        return {};
    }
}

async function getVolumeScores() {
    try {
        const raw = await redis.hgetall('VOLUME_SCORE');
        if (!raw || Object.keys(raw).length === 0) return {};
        const data = {};
        for (const [field, val] of Object.entries(raw)) {
            try {
                const parsed = JSON.parse(val);
                // Key by coin name without USDT (e.g. "KITE")
                const coinKey = field.replace('USDT', '');
                data[coinKey] = parsed;
            } catch { /* skip malformed entries */ }
        }
        return data;
    } catch (e) {
        console.error('[Volume Scores] Error:', e.message);
        return {};
    }
}

setInterval(tick, POLL_MS);

// Serve Pro Dashboard (Enterprise Terminal)
app.get('/pro', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pro.html')));

// Profit Analysis Endpoint
app.get('/api/profit-analysis', async (req, res) => {
    try {
        const data = await getAllHash(ANALYSIS_020_KEY);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch profit analysis' });
    }
});

// BTC Price Proxy (via Engine)
app.get('/api/btc-price', async (req, res) => {
    try {
        const response = await fetch(`${SPRING_BASE}/binance/btc-price`);
        const data = await response.json();
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Order History Proxy
app.get('/api/trade/order-history', async (req, res) => {
    try {
        const { symbol } = req.query;
        const response = await fetch(`${SPRING_BASE}/binance/trade/order-history?symbol=${symbol}`);
        const data = await response.json();
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Order List Proxy (OCO)
app.get('/api/trade/order-list', async (req, res) => {
    const limit = req.query.limit;
    console.log(`[Proxy] GET Order List: ${SPRING_BASE}/binance/trade/order-list?limit=${limit || 100}`);
    try {
        let url = `${SPRING_BASE}/binance/trade/order-list?limit=${limit || 500}`;
        const response = await fetch(url);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        console.error('[Proxy] Order List Error:', error.message);
        res.status(500).json({ error: 'Backend order list service unavailable' });
    }
});


// ─── Configuration API ────────────────────────────────────────────────────────
const CONFIG_KEY = 'TRADING_CONFIG';

// Authoritative defaults — must mirror booknow.config.trading_config.TradingConfig.
// Used as the merge target on POST so partial form submissions can never
// wipe knobs the form doesn't yet expose (falling-knife thresholds etc.).
// 2026-05-10: Option B sizing — $6 buys / +1% TP / -0.65% limit-buy /
// $0.06 stop. ≈$0.05 NET per win after Binance round-trip fees.
const DEFAULT_TRADING_CONFIG = {
    autoBuyEnabled: false,
    // 2026-05-12 iter 15: $48 default to match ladderBuy1/2SizeUsdt.
    buyAmountUsdt: 48.0,
    // 2026-05-11 iter 4: TP 1.0 → 0.6 % → net ~$0.05 per $12 leg.
    profitPct: 0.6,
    profitAmountUsdt: 0.0,
    // 2026-05-11 iter 3: tighter -0.30% offset (was 0.65) for higher fill rate.
    limitBuyOffsetPct: 0.30,
    tslPct: 2.0,
    stopLossUsdt: 0.0,    // 0 = disabled (Option B patient hold)
    limitBuyTimeoutSec: 3600,    // 60 min — full Option B fill window
    fastScalpMode: true,
    maxHoldSeconds: 3600,
    marketExitOnTimeout: true,
    // Trend-reversal exit: True default for safety on Redis wipe, but
    // operator runs with False (most "panic exits" hit TP later).
    trendReversalExitEnabled: true,
    // 2026-05-12 iter 15: default true (was false). Aligns with the backend
    // dataclass default. The dashboard form only POSTs a subset of fields,
    // so this default fills in for the rest when the Node frontend merges.
    // (Note: the live POST is actually served by the Python backend, which
    // now also merges over existing Redis state instead of overwriting.)
    virtualScalperLiveMode: true,
    minChange24hPct: -1.0,
    minRange24hPct: 5.0,
    minVol24hUsd: 5000000,
    // Falling-knife filter — added 2026-05-10 from XEC/LUNC/LUMIA backtest.
    // Iter 2 (2026-05-11): loosened after 58% false-positive rate on skips.
    fallingKnifeFilterEnabled: true,
    maxChange24hPct: 12.0,
    maxRange1hPct: 6.0,
    overboughtSkipEnabled: true,
    overbought60mPct: 2.5,
    // Fast-drop-without-volume filter (Pattern C, 2026-05-10 trajectory analysis).
    // Iter 2 (same day): threshold 0.5 → 0.7 after backtest showed 0.5 % was
    // catching shallow slow-drifters that eventually became winners.
    fastDropFilterEnabled: true,
    fastDropDetectMinutes: 3,
    fastDropThresholdPct: 0.7,
    volSurgeThresholdMultiplier: 2.0,
    // Laddered Recovery (2026-05-11 iter 2): multi-coin 3-tier averaging-down.
    // Default OFF in defaults so a Redis wipe stays on the simpler model.
    // Live Redis sets to true.
    ladderedRecoveryEnabled: false,
    maxConcurrentLadders: 1,
    singleCoinModeEnabled: false,   // legacy; superseded by maxConcurrentLadders
    // 2026-05-12 iter 15: $50 → $48/leg (operator request — $96/ladder
    // fits $100 wallet with 3% funds margin and ~$3 headroom).
    ladderBuy1SizeUsdt: 48.0,
    ladderBuy2SizeUsdt: 48.0,
    ladderBuy3SizeUsdt: 0.0,
    ladderBuy2OffsetPct: 0.5,
    ladderBuy3OffsetPct: 1.0,
    ladderTpFromAvgPct: 0.6,
    // 2026-05-11 iter 8: dollar-target wins when set; TP auto-computed.
    // 2026-05-13 iter 19: $0.15 → $0.20 (mirrors backend dataclass default).
    // 2026-05-15 iter 42: $0.20 → $0.15 (operator request — faster TP).
    ladderTargetNetProfitUsdt: 0.15,
    ladderFeeRatePerSide: 0.00075,  // 0.075 % (BNB-fees ON); set to 0.001 if OFF
    ladderHardStopBelowBuy3Pct: 1.0,
    ladderBuy1UseMarketOrder: true,
    ladderBuy1OffsetPct: 0.15,        // 0 = market; >0 = LIMIT at signal × (1-X%) — iter 12 default
    ladderCooldownSeconds: 14400,    // 4h per-coin cooldown after a ladder closes
    metricsEnabled: true,

    // iter 17 fe (2026-05-15): Pattern Bot config defaults.
    // 3rd auto-trader driven by Bounce Watch / Early Pump pattern
    // detectors. Paper-mode by default — flip to live after validation.
    patternBotEnabled: true,           // master switch
    patternBotPaperMode: true,         // true = log paper trades, no real orders
    patternBotAlgo: 'early_pump',      // 'bounce' | 'early_pump' | 'both'
    patternBotMinScore: 70,            // tighter than detector's 60 (no losses goal)
    patternBotStopPct: 1.5,            // -1.5% cat-stop (tighter than iter39's 2.5%)
    patternBotMaxFreshSec: 60,         // detection must be < 60s old to trade
    patternBotTimeoutMin: 240,         // 4h max hold then close at market
    // iter 24 fe (2026-05-16): Pending-order Auto-Cancel worker. Default OFF
    // for safety — operator must explicitly enable. When first enabled,
    // paperMode logs would-be cancels without hitting Binance so the
    // operator can audit a few cycles before going live.
    pendingAutoCancelEnabled: false,
    pendingAutoCancelPaperMode: true,
    pendingAutoCancelMaxPerHour: 10,   // soft ceiling on auto-cancels per hour
    pendingAutoCancelCooldownSec: 300, // skip a symbol for 5 min after cancel
    pendingAutoCancelAgeBufferSec: 60, // require staleMin + 60s before action

    // iter 25 fe (2026-05-16): Cancel-Recovery worker. Rescues orders that
    // the Python scalper's pending_pump_dump_cancel logic killed too early
    // (RENDER case: price came back to the limit within 50s of cancel).
    // Default OFF + paperMode ON — recovery is intrinsically riskier so
    // operator must audit a few cycles before going live.
    pendingRecoveryEnabled: false,
    pendingRecoveryPaperMode: true,
    pendingRecoveryMinTouchPct: 0.20,  // price came within 0.20% of limit
    pendingRecoveryMaxAbovePct: 0.30,  // current at most 0.30% above limit
    pendingRecoveryWindowSec: 300,     // only act within 5 min of cancel
    pendingRecoveryMaxPerHour: 3,      // strict ceiling — recovery is risky
    pendingRecoveryCooldownSec: 1800,  // 30 min symbol cooldown
};

app.get('/api/v1/config', async (req, res) => {
    try {
        const raw = await redis.get(CONFIG_KEY);
        const stored = raw ? JSON.parse(raw) : {};
        // Merge over defaults so the UI always sees every known field.
        const config = { ...DEFAULT_TRADING_CONFIG, ...stored };
        res.json(config);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch config' });
    }
});

// iter 44 (2026-05-15): Backtest report endpoint.
// Returns the latest backtest comparison (actual vs iter43+iter38+iter44+iter39
// simulated) for the dashboard /backtest.html page.
app.get('/api/backtest-report', async (req, res) => {
    try {
        const raw = await redis.get('REPORTS:BACKTEST:LATEST');
        if (!raw) return res.status(404).json({ error: 'No report stored — run the build_report script first.' });
        res.json(JSON.parse(raw));
    } catch (err) {
        res.status(500).json({ error: 'Failed to load report: ' + err.message });
    }
});

// iter 47 (2026-05-15): Trade Decision Trace endpoint.
// Runs the same 5 pre-buy filters + iter43 strategy chooser that the
// bot uses internally, against fresh Binance data. Returns a step-by-
// step pass/block verdict for the symbol — answers "why was this coin
// blocked?" / "would this coin pass right now?" / "what TP would the
// bot set?".
app.get('/api/check-coin', async (req, res) => {
    const sym = (req.query.symbol || '').toUpperCase().trim();
    if (!sym) return res.status(400).json({ error: 'symbol query param required, e.g. /api/check-coin?symbol=BTCUSDT' });
    const binanceSym = sym.includes('/') ? sym.replace('/', '') : sym;
    const ccxtSym = sym.includes('/') ? sym : (sym.endsWith('USDT') ? sym.slice(0, -4) + '/USDT' : sym);

    try {
        // Pull live config thresholds from Redis
        const rawCfg = await redis.get(CONFIG_KEY);
        const cfg = { ...DEFAULT_TRADING_CONFIG, ...(rawCfg ? JSON.parse(rawCfg) : {}) };

        // Fetch 24h ticker + daily klines (parallel)
        const [tickerRaw, dailyRaw, hourlyRaw] = await Promise.all([
            fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${binanceSym}`).then(r => r.json()),
            fetch(`https://api.binance.com/api/v3/klines?symbol=${binanceSym}&interval=1d&limit=31`).then(r => r.json()),
            fetch(`https://api.binance.com/api/v3/klines?symbol=${binanceSym}&interval=1h&limit=2`).then(r => r.json()),
        ]);

        if (tickerRaw.code) return res.status(404).json({ error: `Binance: ${tickerRaw.msg || JSON.stringify(tickerRaw)}` });

        const t = tickerRaw;
        const lastPrice  = parseFloat(t.lastPrice);
        const high24     = parseFloat(t.highPrice);
        const low24      = parseFloat(t.lowPrice);
        const chg24Pct   = parseFloat(t.priceChangePercent);
        const quoteVol24 = parseFloat(t.quoteVolume);
        const fromHigh24Pct = (lastPrice / high24 - 1) * 100;

        // 1h range from current hour candle
        let range1hPct = 0;
        if (Array.isArray(hourlyRaw) && hourlyRaw.length) {
            const last1h = hourlyRaw[hourlyRaw.length - 1];
            const h1h = parseFloat(last1h[2]); const l1h = parseFloat(last1h[3]);
            range1hPct = l1h > 0 ? (h1h - l1h) / l1h * 100 : 0;
        }

        // Daily klines (drop today's partial)
        const now = Date.now();
        const dayMs = 24 * 60 * 60 * 1000;
        const dayStart = now - (now % dayMs);
        const dailyDone = (Array.isArray(dailyRaw) ? dailyRaw : []).filter(k => k[0] < dayStart);
        const last30d = dailyDone.slice(-30);
        const last7d  = dailyDone.slice(-7);
        const last5d  = dailyDone.slice(-5);

        const filters = [];

        // ── Filter 1: falling_knife (24h pump, low volume, volatility, overbought) ──
        const fkChecks = [];
        if (chg24Pct >= cfg.maxChange24hPct) fkChecks.push(`24h +${chg24Pct.toFixed(2)}% ≥ ${cfg.maxChange24hPct}%`);
        if (quoteVol24 < cfg.minVol24hUsd) fkChecks.push(`vol $${(quoteVol24/1e6).toFixed(2)}M < $${(cfg.minVol24hUsd/1e6).toFixed(0)}M`);
        if (range1hPct > cfg.maxRange1hPct) fkChecks.push(`1h range ${range1hPct.toFixed(2)}% > ${cfg.maxRange1hPct}%`);
        filters.push({
            id: 'falling_knife',
            name: 'Falling-knife filter (built-in)',
            pass: fkChecks.length === 0,
            reason: fkChecks.length ? fkChecks.join(' AND ') : 'all checks passed',
            details: {
                change_24h_pct: +chg24Pct.toFixed(2),
                quote_vol_24h_usd: quoteVol24,
                range_1h_pct: +range1hPct.toFixed(2),
                limits: { maxChange24hPct: cfg.maxChange24hPct, minVol24hUsd: cfg.minVol24hUsd, maxRange1hPct: cfg.maxRange1hPct },
            },
        });

        // ── Filter 2: iter38 near-top pump ──
        const i38_blocked = chg24Pct >= cfg.nearTopPumpMin24hChangePct && fromHigh24Pct >= -cfg.nearTopPumpMaxFromHighPct;
        filters.push({
            id: 'iter38_near_top_pump',
            name: 'iter 38 — Near-top pump filter',
            pass: !i38_blocked && !!cfg.nearTopPumpFilterEnabled,
            blocked: i38_blocked && !!cfg.nearTopPumpFilterEnabled,
            enabled: !!cfg.nearTopPumpFilterEnabled,
            reason: i38_blocked
                ? `24h +${chg24Pct.toFixed(2)}% ≥ ${cfg.nearTopPumpMin24hChangePct}% AND within ${(-fromHigh24Pct).toFixed(2)}% of 24h high (≤ ${cfg.nearTopPumpMaxFromHighPct}%)`
                : `24h +${chg24Pct.toFixed(2)}% (need ≥${cfg.nearTopPumpMin24hChangePct}%) AND/OR from high ${fromHigh24Pct.toFixed(2)}% (need ≥-${cfg.nearTopPumpMaxFromHighPct}%) — at least one check fails the BLOCK condition`,
            details: {
                change_24h_pct: +chg24Pct.toFixed(2),
                from_24h_high_pct: +fromHigh24Pct.toFixed(2),
                limits: { min_24h_change: cfg.nearTopPumpMin24hChangePct, max_from_high: cfg.nearTopPumpMaxFromHighPct },
            },
        });

        // ── Filter 3: iter44 macro-top exhaustion ──
        let i44_blocked = false, i44_details = {};
        if (last30d.length >= 8) {
            const closes = last30d.map(k => parseFloat(k[4]));
            const opens  = last30d.map(k => parseFloat(k[1]));
            const highs  = last30d.map(k => parseFloat(k[2]));
            const lastC = closes[closes.length - 1];
            const ret30 = (lastC / closes[0] - 1) * 100;
            const h30 = Math.max(...highs);
            const withinHi = h30 > 0 ? (lastC / h30) * 100 : 0;
            const last7 = closes.slice(-7);
            const open7 = opens.slice(-7);
            const red7 = last7.reduce((s, c, i) => s + (c < open7[i] ? 1 : 0), 0);
            i44_blocked = ret30 >= cfg.macroTopMinReturnPct &&
                          withinHi >= cfg.macroTopWithinHighPct &&
                          red7 >= cfg.macroTopMinRedDaysIn7;
            i44_details = {
                return_30d_pct: +ret30.toFixed(2),
                within_30d_high_pct: +withinHi.toFixed(2),
                red_days_in_7: red7,
                limits: { min_return: cfg.macroTopMinReturnPct, within_high: cfg.macroTopWithinHighPct, min_red: cfg.macroTopMinRedDaysIn7 },
            };
        }
        filters.push({
            id: 'iter44_macro_top',
            name: 'iter 44 — Macro-top exhaustion filter',
            pass: !i44_blocked && !!cfg.macroTopFilterEnabled,
            blocked: i44_blocked && !!cfg.macroTopFilterEnabled,
            enabled: !!cfg.macroTopFilterEnabled,
            reason: i44_blocked
                ? `30d return +${i44_details.return_30d_pct}% (≥${cfg.macroTopMinReturnPct}%) AND within ${i44_details.within_30d_high_pct}% of 30d high (≥${cfg.macroTopWithinHighPct}%) AND red ${i44_details.red_days_in_7}/7 (≥${cfg.macroTopMinRedDaysIn7})`
                : (last30d.length >= 8 ? 'at least one of the 3 conditions fails the BLOCK threshold' : 'insufficient daily history → pass (fail-open)'),
            details: i44_details,
        });

        // ── Filter 4: iter45 vol_regime ──
        let i45_blocked = false, i45_details = {};
        if (last5d.length >= 3) {
            const ranges = last5d.map(k => {
                const h = parseFloat(k[2]), l = parseFloat(k[3]);
                return l > 0 ? (h - l) / l * 100 : 0;
            });
            const dailyChgs = last5d.map(k => {
                const o = parseFloat(k[1]), c = parseFloat(k[4]);
                return o > 0 ? (c - o) / o * 100 : 0;
            });
            const maxR = Math.max(...ranges);
            const worst = Math.min(...dailyChgs);
            i45_blocked = (maxR > cfg.volRegimeMaxDailyRangePct) || (worst <= -cfg.volRegimeBigCrashPct);
            i45_details = {
                max_5d_range_pct: +maxR.toFixed(2),
                worst_5d_day_pct: +worst.toFixed(2),
                limits: { max_range: cfg.volRegimeMaxDailyRangePct, big_crash: cfg.volRegimeBigCrashPct },
            };
        }
        filters.push({
            id: 'iter45_vol_regime',
            name: 'iter 45 — Volatility regime filter',
            pass: !i45_blocked && !!cfg.volRegimeFilterEnabled,
            blocked: i45_blocked && !!cfg.volRegimeFilterEnabled,
            enabled: !!cfg.volRegimeFilterEnabled,
            reason: i45_blocked
                ? (() => {
                    const parts = [];
                    if (i45_details.max_5d_range_pct > cfg.volRegimeMaxDailyRangePct) parts.push(`max 5d range ${i45_details.max_5d_range_pct}% > ${cfg.volRegimeMaxDailyRangePct}%`);
                    if (i45_details.worst_5d_day_pct <= -cfg.volRegimeBigCrashPct) parts.push(`worst day ${i45_details.worst_5d_day_pct}% ≤ -${cfg.volRegimeBigCrashPct}%`);
                    return parts.join(' AND ');
                })()
                : (last5d.length >= 3 ? `max range ${i45_details.max_5d_range_pct}% (limit ${cfg.volRegimeMaxDailyRangePct}%), worst day ${i45_details.worst_5d_day_pct}% (limit -${cfg.volRegimeBigCrashPct}%) — both within tolerance` : 'insufficient data → pass'),
            details: i45_details,
        });

        // ── Filter 5: post_pump_bleed (simplified — would need full kline scan; show config only) ──
        filters.push({
            id: 'post_pump_bleed',
            name: 'Post-pump bleed (multi-day)',
            pass: true,  // approximated as pass — full scan is server-side only
            note: 'Bot checks for +30% pump in last 15 days now off-peak by 10%. Full check runs in the scalper at signal time.',
            details: {
                limits: { threshold: cfg.postPumpThresholdPct, off_peak: cfg.postPumpOffPeakMinPct, lookback_days: cfg.postPumpLookbackDays },
            },
        });

        // Final verdict
        const blocker = filters.find(f => f.blocked);
        const wouldPass = filters.every(f => f.pass !== false);

        // ── iter43 strategy chooser (only relevant if would pass) ──
        let strategy = null;
        if (wouldPass) {
            const r1h = range1hPct;
            let tier, buy1Off, buy2Off, tpUsdt;
            if (r1h < cfg.adaptiveTierCalmMaxPct) {
                tier = 'CALM'; buy1Off = cfg.adaptiveBuy1OffsetCalm; buy2Off = cfg.adaptiveBuy2OffsetCalm; tpUsdt = cfg.adaptiveTpTargetCalm;
            } else if (r1h < cfg.adaptiveTierNormalMaxPct) {
                tier = 'NORMAL'; buy1Off = cfg.adaptiveBuy1OffsetNormal; buy2Off = cfg.adaptiveBuy2OffsetNormal; tpUsdt = cfg.adaptiveTpTargetNormal;
            } else if (r1h < cfg.adaptiveTierVolatileMaxPct) {
                tier = 'VOLATILE'; buy1Off = cfg.adaptiveBuy1OffsetVolatile; buy2Off = cfg.adaptiveBuy2OffsetVolatile; tpUsdt = cfg.adaptiveTpTargetVolatile;
            } else {
                tier = 'X_VOLATILE'; buy1Off = cfg.adaptiveBuy1OffsetXVolatile; buy2Off = cfg.adaptiveBuy2OffsetXVolatile; tpUsdt = cfg.adaptiveTpTargetXVolatile;
            }
            const buy1Price = lastPrice * (1 - buy1Off / 100);
            const buy2Price = lastPrice * (1 - buy2Off / 100);
            // TP math: tp_pct = (target_net / leg_size)*100 + 2*fee_rate*100
            const tpPct = (tpUsdt / cfg.ladderBuy1SizeUsdt) * 100 + 2 * cfg.ladderFeeRatePerSide * 100;
            const tpPrice = buy1Price * (1 + tpPct / 100);
            strategy = {
                tier,
                range_1h_pct: +r1h.toFixed(2),
                signal_price: +lastPrice.toFixed(8),
                buy_1: {
                    offset_pct: buy1Off,
                    price: +buy1Price.toFixed(8),
                    size_usdt: cfg.ladderBuy1SizeUsdt,
                },
                buy_2: {
                    offset_pct: buy2Off,
                    price: +buy2Price.toFixed(8),
                    size_usdt: cfg.ladderBuy2SizeUsdt,
                    note: 'placed as LIMIT after Buy 1 fills; cancelled if Buy 1 fills + 10min stale',
                },
                tp: {
                    target_net_usdt: tpUsdt,
                    tp_pct: +tpPct.toFixed(4),
                    tp_price: +tpPrice.toFixed(8),
                    formula: `tp_pct = (${tpUsdt}/${cfg.ladderBuy1SizeUsdt})×100 + 2×${cfg.ladderFeeRatePerSide}×100 = ${tpPct.toFixed(4)}%`,
                    explanation: `If Buy 1 fills at $${buy1Price.toFixed(6)} and Buy 2 doesn't fill, TP sell at $${tpPrice.toFixed(6)} = +$${tpUsdt} net (after both 0.075% fees)`,
                },
            };
        }

        res.json({
            symbol: ccxtSym,
            timestamp: new Date().toISOString(),
            market: {
                last_price: lastPrice,
                change_24h_pct: +chg24Pct.toFixed(2),
                high_24h: high24,
                low_24h: low24,
                from_24h_high_pct: +fromHigh24Pct.toFixed(2),
                quote_volume_24h_usd: quoteVol24,
                range_1h_pct: +range1hPct.toFixed(2),
            },
            filters,
            verdict: {
                would_buy: wouldPass && !blocker,
                blocked: !!blocker,
                blocker: blocker ? blocker.id : null,
                blocker_reason: blocker ? blocker.reason : null,
            },
            strategy,
            config_summary: {
                auto_buy_enabled: !!cfg.autoBuyEnabled,
                virtual_live_mode: !!cfg.virtualScalperLiveMode,
                ladder_enabled: !!cfg.ladderedRecoveryEnabled,
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Recent skip events from METRICS:SKIP:<today>
app.get('/api/recent-decisions', async (req, res) => {
    try {
        const date = new Date().toISOString().slice(0, 10);
        const limit = parseInt(req.query.limit || '30', 10);
        const raw = await redis.lrange(`METRICS:SKIP:${date}`, 0, limit - 1);
        const events = raw.map(r => { try { return JSON.parse(r); } catch (_) { return null; } }).filter(Boolean);
        res.json({ date, total: events.length, events });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// iter 14 fe (2026-05-15): Bounce Watch — score oversold coins for
// potential pump reversal. Scans top movers, picks the most-down ones
// with healthy volume, and computes a 0-100 "bounce score" from 1m
// klines (recovery momentum + volume surge + higher lows + MA cross +
// velocity flip). Detections are logged to Redis so we build a pattern
// library for prediction.
const _bounceKlinesCache = new Map();
const BOUNCE_KLINES_TTL_MS = 30 * 1000;  // 30s

async function fetchKlines1m(binanceSym, limit = 30) {
    const cached = _bounceKlinesCache.get(binanceSym);
    if (cached && Date.now() - cached.ts < BOUNCE_KLINES_TTL_MS) return cached.data;
    try {
        const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${binanceSym}&interval=1m&limit=${limit}`);
        if (!r.ok) return null;
        const data = await r.json();
        _bounceKlinesCache.set(binanceSym, { ts: Date.now(), data });
        return data;
    } catch (_) { return null; }
}

function computeBounceScore(klines) {
    // klines: array of [openTime, open, high, low, close, volume, ..., trades, takerBuyBase, takerBuyQuote]
    if (!klines || klines.length < 20) return null;
    const opens = klines.map(k => parseFloat(k[1]));
    const highs = klines.map(k => parseFloat(k[2]));
    const lows  = klines.map(k => parseFloat(k[3]));
    const closes= klines.map(k => parseFloat(k[4]));
    const vols  = klines.map(k => parseFloat(k[5]) * parseFloat(k[4]));   // quote-vol (USDT)
    const trades= klines.map(k => parseInt(k[8] || 0, 10));
    const tbQuote = klines.map(k => parseFloat(k[10] || 0));  // taker buy quote vol

    const n = klines.length;
    const last5 = closes.slice(-5);
    const prior25 = closes.slice(-30, -5);

    // F1: Recovery momentum — last 5min close vs 5min ago close
    const close_now = closes[n-1];
    const close_5min_ago = closes[Math.max(0, n-6)];
    const recovery_pct = (close_now / close_5min_ago - 1) * 100;
    let f1 = 0;
    if (recovery_pct >= 1.0) f1 = 35;
    else if (recovery_pct >= 0.5) f1 = 25;
    else if (recovery_pct >= 0.2) f1 = 15;
    else if (recovery_pct > 0) f1 = 5;

    // F2: Volume surge — last 5min vs prior 25min
    const vol5 = vols.slice(-5).reduce((s,v)=>s+v,0) / 5;
    const vol25 = vols.slice(-30,-5).reduce((s,v)=>s+v,0) / Math.max(1, vols.slice(-30,-5).length);
    const vol_ratio = vol25 > 0 ? vol5 / vol25 : 0;
    let f2 = 0;
    if (vol_ratio >= 3) f2 = 25;
    else if (vol_ratio >= 2) f2 = 18;
    else if (vol_ratio >= 1.5) f2 = 10;
    else if (vol_ratio >= 1.0) f2 = 5;

    // F3: Higher lows — last 10 candles
    const recent10 = lows.slice(-10);
    let hl_count = 0;
    for (let i = 1; i < recent10.length; i++) {
        if (recent10[i] > recent10[i-1]) hl_count++;
    }
    let f3 = 0;
    if (hl_count >= 6) f3 = 15;
    else if (hl_count >= 4) f3 = 8;
    else if (hl_count >= 3) f3 = 3;

    // F4: Above MA(7)
    const last7 = closes.slice(-7);
    const ma7 = last7.reduce((s,c)=>s+c,0) / 7;
    const f4 = close_now > ma7 ? 10 : 0;

    // F5: Velocity flip — was negative trend, now positive
    const mid = Math.floor(n/2);
    const drift_before = (closes[mid-1] - closes[0]) / closes[0] * 100;
    const drift_after  = (close_now - closes[mid]) / closes[mid] * 100;
    let f5 = 0;
    if (drift_before < -0.3 && drift_after > 0.3) f5 = 15;
    else if (drift_before < 0 && drift_after > 0) f5 = 8;
    else if (drift_after > drift_before) f5 = 3;

    // F6 (bonus): taker buy ratio in last 5min
    const tb5 = tbQuote.slice(-5).reduce((s,v)=>s+v,0);
    const tv5 = vols.slice(-5).reduce((s,v)=>s+v,0);
    const buy_ratio = tv5 > 0 ? (tb5 / tv5) : 0.5;
    // Higher buy ratio = more aggressive buying = bullish
    const buy_ratio_pct = buy_ratio * 100;

    const score = f1 + f2 + f3 + f4 + f5;

    return {
        score,
        factors: {
            recovery_5m_pct: +recovery_pct.toFixed(2),
            recovery_pts: f1,
            vol_surge_ratio: +vol_ratio.toFixed(2),
            vol_surge_pts: f2,
            higher_lows_10: hl_count,
            higher_lows_pts: f3,
            above_ma7: close_now > ma7,
            above_ma7_pts: f4,
            drift_before_pct: +drift_before.toFixed(2),
            drift_after_pct: +drift_after.toFixed(2),
            velocity_flip_pts: f5,
            taker_buy_ratio_pct: +buy_ratio_pct.toFixed(1),
        },
        last_close: close_now,
        last_5min_low: Math.min(...lows.slice(-5)),
        avg_trades_per_min: Math.round(trades.slice(-5).reduce((s,t)=>s+t,0)/5),
    };
}

app.get('/api/bounce-watch', async (req, res) => {
    try {
        const minDownPct  = parseFloat(req.query.min_down_pct  || '5');   // include coins down ≥ X%
        const minVolUsdM  = parseFloat(req.query.min_vol_m     || '2');   // ≥ X million USDT
        const limit       = parseInt(req.query.limit           || '30', 10);
        const scoreThresh = parseInt(req.query.score_threshold || '60', 10);

        // 1. Fetch all 24h tickers (single API call)
        const tickersRes = await fetch('https://api.binance.com/api/v3/ticker/24hr');
        if (!tickersRes.ok) return res.status(502).json({ error: 'Binance fetch failed' });
        const tickers = await tickersRes.json();

        // 2. Filter: USDT pairs, down >= minDownPct, vol >= minVolM
        const downMovers = tickers
            .filter(t => t.symbol.endsWith('USDT'))
            .filter(t => !t.symbol.includes('UPUSDT') && !t.symbol.includes('DOWNUSDT'))  // skip leveraged
            .map(t => ({
                symbol: t.symbol,
                last_price: parseFloat(t.lastPrice),
                change_24h_pct: parseFloat(t.priceChangePercent),
                high_24h: parseFloat(t.highPrice),
                low_24h: parseFloat(t.lowPrice),
                quote_volume_24h_usd: parseFloat(t.quoteVolume),
            }))
            .filter(t => t.change_24h_pct <= -minDownPct
                       && t.quote_volume_24h_usd >= minVolUsdM * 1e6)
            .sort((a, b) => a.change_24h_pct - b.change_24h_pct);  // most down first

        // 3. For top N down-movers, fetch klines + compute score (parallel)
        const top = downMovers.slice(0, limit);
        const scored = await Promise.all(top.map(async (m) => {
            const klines = await fetchKlines1m(m.symbol, 30);
            const bounce = computeBounceScore(klines);
            return { ...m, bounce };
        }));

        // 4. Filter to those with a valid bounce score, sort by score descending
        const ranked = scored
            .filter(s => s.bounce !== null)
            .sort((a, b) => b.bounce.score - a.bounce.score);

        // 5. Identify high-score candidates (score >= threshold)
        const hot = ranked.filter(s => s.bounce.score >= scoreThresh);

        // 6. Log new high-score detections to Redis (for pattern learning)
        const date = new Date().toISOString().slice(0, 10);
        for (const c of hot) {
            const event = {
                ts: Date.now(),
                symbol: c.symbol,
                score: c.bounce.score,
                change_24h_pct: c.change_24h_pct,
                last_price: c.last_price,
                factors: c.bounce.factors,
            };
            await redis.lpush(`BOUNCE:DETECTIONS:${date}`, JSON.stringify(event));
            await redis.ltrim(`BOUNCE:DETECTIONS:${date}`, 0, 999);
            await redis.expire(`BOUNCE:DETECTIONS:${date}`, 7 * 24 * 60 * 60);
        }

        res.json({
            timestamp: new Date().toISOString(),
            params: { minDownPct, minVolUsdM, limit, scoreThresh },
            total_down_movers: downMovers.length,
            scored: ranked.length,
            high_score: hot.length,
            ranked,
        });
    } catch (err) {
        res.status(500).json({ error: err.message, stack: err.stack });
    }
});

app.get('/api/bounce-detections', async (req, res) => {
    try {
        const date = req.query.date || new Date().toISOString().slice(0, 10);
        const limit = parseInt(req.query.limit || '50', 10);
        const raw = await redis.lrange(`BOUNCE:DETECTIONS:${date}`, 0, limit - 1);
        const events = raw.map(r => { try { return JSON.parse(r); } catch (_) { return null; } }).filter(Boolean);
        res.json({ date, total: events.length, events });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// iter 15 fe (2026-05-15): Early Pump Detector
// Catches coins JUST STARTING to move up (24h change between 0% and 1%)
// before they explode to +5%. Different from bounce-watch (which tracks
// oversold coins waiting for reversal) — this is for coins in stealth
// accumulation phase.
//
// Score 0-100 from 5 factors. Detections stored to booknow-redis-analyse
// (the pattern DB) as EARLY_PUMP:DETECTIONS:<date> for future pattern
// matching. Target TP per detection: +$0.15 (matches bot's iter42 target).
function computeEarlyPumpScore(klines) {
    if (!klines || klines.length < 20) return null;
    const opens = klines.map(k => parseFloat(k[1]));
    const highs = klines.map(k => parseFloat(k[2]));
    const lows  = klines.map(k => parseFloat(k[3]));
    const closes= klines.map(k => parseFloat(k[4]));
    const vols  = klines.map(k => parseFloat(k[5]) * parseFloat(k[4]));
    const trades= klines.map(k => parseInt(k[8] || 0, 10));
    const tbQuote = klines.map(k => parseFloat(k[10] || 0));
    const n = klines.length;

    // F1: Persistent positive drift — green candle share in last 10
    const last10open = opens.slice(-10);
    const last10close = closes.slice(-10);
    const greenCount = last10open.reduce((s, o, i) => s + (last10close[i] > o ? 1 : 0), 0);
    let f1 = 0;
    if (greenCount >= 7) f1 = 25;
    else if (greenCount >= 6) f1 = 18;
    else if (greenCount >= 5) f1 = 10;

    // F2: Volume building — last 5min vs prior 25min (gentler than bounce)
    const vol5 = vols.slice(-5).reduce((s, v) => s + v, 0) / 5;
    const vol25arr = vols.slice(-30, -5);
    const vol25 = vol25arr.length ? vol25arr.reduce((s, v) => s + v, 0) / vol25arr.length : 0;
    const vol_ratio = vol25 > 0 ? vol5 / vol25 : 0;
    let f2 = 0;
    if (vol_ratio >= 2.5) f2 = 25;
    else if (vol_ratio >= 2.0) f2 = 20;
    else if (vol_ratio >= 1.5) f2 = 12;
    else if (vol_ratio >= 1.2) f2 = 6;

    // F3: Higher highs AND higher lows in last 10
    const recent10highs = highs.slice(-10);
    const recent10lows = lows.slice(-10);
    let hh_count = 0, hl_count = 0;
    for (let i = 1; i < 10; i++) {
        if (recent10highs[i] > recent10highs[i-1]) hh_count++;
        if (recent10lows[i] > recent10lows[i-1]) hl_count++;
    }
    let f3 = 0;
    if (hh_count >= 6 && hl_count >= 6) f3 = 20;
    else if (hh_count >= 5 && hl_count >= 5) f3 = 14;
    else if (hh_count + hl_count >= 9) f3 = 7;

    // F4: Trade frequency surge — last 5min avg trades vs prior 25min avg
    const tr5 = trades.slice(-5).reduce((s, t) => s + t, 0) / 5;
    const tr25arr = trades.slice(-30, -5);
    const tr25 = tr25arr.length ? tr25arr.reduce((s, t) => s + t, 0) / tr25arr.length : 0;
    const tr_ratio = tr25 > 0 ? tr5 / tr25 : 0;
    let f4 = 0;
    if (tr_ratio >= 2.0) f4 = 15;
    else if (tr_ratio >= 1.5) f4 = 10;
    else if (tr_ratio >= 1.2) f4 = 5;

    // F5: Buy pressure
    const tb5 = tbQuote.slice(-5).reduce((s, v) => s + v, 0);
    const tv5 = vols.slice(-5).reduce((s, v) => s + v, 0);
    const buy_ratio = tv5 > 0 ? (tb5 / tv5) : 0.5;
    const buy_ratio_pct = buy_ratio * 100;
    let f5 = 0;
    if (buy_ratio_pct >= 65) f5 = 15;
    else if (buy_ratio_pct >= 60) f5 = 12;
    else if (buy_ratio_pct >= 55) f5 = 8;

    const score = f1 + f2 + f3 + f4 + f5;
    return {
        score,
        factors: {
            green_candles_10: greenCount,
            green_pts: f1,
            vol_surge_ratio: +vol_ratio.toFixed(2),
            vol_surge_pts: f2,
            higher_highs_9: hh_count,
            higher_lows_9: hl_count,
            structure_pts: f3,
            trade_freq_ratio: +tr_ratio.toFixed(2),
            trade_freq_pts: f4,
            taker_buy_ratio_pct: +buy_ratio_pct.toFixed(1),
            buy_pressure_pts: f5,
        },
        last_close: closes[n-1],
        avg_trades_per_min: Math.round(tr5),
        avg_vol_per_min_usdt: Math.round(vol5),
    };
}

app.get('/api/early-pump-watch', async (req, res) => {
    try {
        const minChg     = parseFloat(req.query.min_chg     || '0');
        const maxChg     = parseFloat(req.query.max_chg     || '1');
        const minVolUsdM = parseFloat(req.query.min_vol_m   || '2');
        const limit      = parseInt(req.query.limit         || '30', 10);
        const scoreTh    = parseInt(req.query.score_threshold || '60', 10);

        const tickersRes = await fetch('https://api.binance.com/api/v3/ticker/24hr');
        if (!tickersRes.ok) return res.status(502).json({ error: 'Binance fetch failed' });
        const tickers = await tickersRes.json();

        // Filter: USDT pairs, 24h change between minChg and maxChg, vol >= minVolM
        const candidates = tickers
            .filter(t => t.symbol.endsWith('USDT'))
            .filter(t => !t.symbol.includes('UPUSDT') && !t.symbol.includes('DOWNUSDT'))
            .map(t => ({
                symbol: t.symbol,
                last_price: parseFloat(t.lastPrice),
                change_24h_pct: parseFloat(t.priceChangePercent),
                quote_volume_24h_usd: parseFloat(t.quoteVolume),
            }))
            .filter(t => t.change_24h_pct >= minChg
                       && t.change_24h_pct <= maxChg
                       && t.quote_volume_24h_usd >= minVolUsdM * 1e6)
            .sort((a, b) => b.quote_volume_24h_usd - a.quote_volume_24h_usd);  // highest volume first

        const top = candidates.slice(0, limit);
        const scored = await Promise.all(top.map(async (m) => {
            const klines = await fetchKlines1m(m.symbol, 30);
            const ep = computeEarlyPumpScore(klines);
            return { ...m, early_pump: ep };
        }));
        const ranked = scored.filter(s => s.early_pump !== null)
                             .sort((a, b) => b.early_pump.score - a.early_pump.score);
        const hot = ranked.filter(s => s.early_pump.score >= scoreTh);

        // Log to analyse Redis — pattern DB
        const date = new Date().toISOString().slice(0, 10);
        for (const c of hot) {
            const event = {
                ts: Date.now(),
                symbol: c.symbol,
                score: c.early_pump.score,
                change_24h_pct: c.change_24h_pct,
                last_price: c.last_price,
                factors: c.early_pump.factors,
                target_tp_usdt: 0.15,  // matches bot's iter42 target
            };
            try {
                await redisAnalyse.lpush(`EARLY_PUMP:DETECTIONS:${date}`, JSON.stringify(event));
                await redisAnalyse.ltrim(`EARLY_PUMP:DETECTIONS:${date}`, 0, 999);
                await redisAnalyse.expire(`EARLY_PUMP:DETECTIONS:${date}`, 7 * 24 * 60 * 60);
                // Also store a per-symbol latest detection for quick lookup
                await redisAnalyse.hset('EARLY_PUMP:LATEST', c.symbol, JSON.stringify(event));
            } catch (e) {
                console.error('[early-pump] Redis analyse write failed:', e.message);
            }
        }

        res.json({
            timestamp: new Date().toISOString(),
            params: { minChg, maxChg, minVolUsdM, limit, scoreTh },
            total_candidates: candidates.length,
            scored: ranked.length,
            high_score: hot.length,
            ranked,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/early-pump-detections', async (req, res) => {
    try {
        const date = req.query.date || new Date().toISOString().slice(0, 10);
        const limit = parseInt(req.query.limit || '50', 10);
        const raw = await redisAnalyse.lrange(`EARLY_PUMP:DETECTIONS:${date}`, 0, limit - 1);
        const events = raw.map(r => { try { return JSON.parse(r); } catch (_) { return null; } }).filter(Boolean);
        res.json({ date, total: events.length, events, storage: 'booknow-redis-analyse' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// iter 16 fe (2026-05-15): Pattern Backtest
// Replays every detection from BOUNCE:DETECTIONS and EARLY_PUMP:DETECTIONS
// against actual 1m klines. Simulates the bot's iter43 strategy:
//   Buy at detection price
//   TP +0.567% (= +$0.15 net on $48 leg after 2× 0.075% fees, iter42)
//   Stop -2.5% (iter39 catastrophic)
//   Timeout 4h
// Shows per-detection outcome + per-algorithm hit rate, avg P&L, win rate.

const TP_PCT = 0.567;
const SL_PCT = 2.5;
const TIMEOUT_HOURS = 4;
const LEG_SIZE_USDT = 48;
const FEE_RATE = 0.00075;

async function replayDetection(symbol, buyTs, buyPrice) {
    // Fetch 1m klines from buyTs to buyTs + 4h
    const endTs = buyTs + TIMEOUT_HOURS * 60 * 60 * 1000;
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${buyTs}&endTime=${endTs}&limit=300`;
    try {
        const r = await fetch(url);
        if (!r.ok) return { outcome: 'fetch_error', exit_price: null };
        const k = await r.json();
        if (!Array.isArray(k) || k.length < 2) return { outcome: 'no_data', exit_price: null };

        const tpPrice = buyPrice * (1 + TP_PCT / 100);
        const slPrice = buyPrice * (1 - SL_PCT / 100);

        let maxHigh = 0, minLow = Infinity;
        let outcome = 'timeout';
        let exitPrice = parseFloat(k[k.length - 1][4]);  // last close
        let resolveT = k.length;

        for (let i = 0; i < k.length; i++) {
            const high = parseFloat(k[i][2]);
            const low = parseFloat(k[i][3]);
            if (high > maxHigh) maxHigh = high;
            if (low < minLow) minLow = low;

            // Check TP first (we use limit-sell at TP price)
            if (high >= tpPrice) {
                outcome = 'tp_hit';
                exitPrice = tpPrice;
                resolveT = i + 1;
                break;
            }
            // Then stop loss
            if (low <= slPrice) {
                outcome = 'stop_loss';
                exitPrice = slPrice;
                resolveT = i + 1;
                break;
            }
        }

        // Compute P&L
        const qty = LEG_SIZE_USDT / buyPrice;
        const gross = (exitPrice - buyPrice) * qty;
        const fees = 2 * FEE_RATE * LEG_SIZE_USDT;
        const net = gross - fees;

        return {
            outcome,
            exit_price: +exitPrice.toFixed(8),
            resolve_min: resolveT,
            max_high: +maxHigh.toFixed(8),
            max_high_pct: +((maxHigh / buyPrice - 1) * 100).toFixed(2),
            min_low: minLow === Infinity ? null : +minLow.toFixed(8),
            min_low_pct: minLow === Infinity ? null : +((minLow / buyPrice - 1) * 100).toFixed(2),
            net_pnl: +net.toFixed(4),
        };
    } catch (e) {
        return { outcome: 'error', error: e.message, exit_price: null };
    }
}

async function backtestDetections(detections) {
    // Sort by timestamp ascending
    const sorted = detections.slice().sort((a, b) => a.ts - b.ts);
    const results = [];
    // Run in parallel batches of 5 to be nice to Binance
    for (let i = 0; i < sorted.length; i += 5) {
        const batch = sorted.slice(i, i + 5);
        const batchResults = await Promise.all(batch.map(async (d) => {
            const r = await replayDetection(d.symbol, d.ts, d.last_price);
            return { ...d, replay: r };
        }));
        results.push(...batchResults);
    }
    return results;
}

function summariseResults(results) {
    const total = results.length;
    if (total === 0) return { total: 0 };
    const tpHits   = results.filter(r => r.replay.outcome === 'tp_hit');
    const stops    = results.filter(r => r.replay.outcome === 'stop_loss');
    const timeouts = results.filter(r => r.replay.outcome === 'timeout');
    const errors   = results.filter(r => ['fetch_error','no_data','error'].includes(r.replay.outcome));
    const valid = results.filter(r => r.replay.outcome !== 'fetch_error' && r.replay.outcome !== 'no_data' && r.replay.outcome !== 'error');
    const totalPnl = valid.reduce((s, r) => s + (r.replay.net_pnl || 0), 0);
    const winRate = valid.length > 0 ? (tpHits.length / valid.length * 100) : 0;
    const avgTpMin = tpHits.length ? (tpHits.reduce((s, r) => s + r.replay.resolve_min, 0) / tpHits.length) : null;
    const avgWinPnl = tpHits.length ? (tpHits.reduce((s, r) => s + r.replay.net_pnl, 0) / tpHits.length) : null;
    const avgLossPnl = stops.length ? (stops.reduce((s, r) => s + r.replay.net_pnl, 0) / stops.length) : null;
    const avgTimeoutPnl = timeouts.length ? (timeouts.reduce((s, r) => s + r.replay.net_pnl, 0) / timeouts.length) : null;
    return {
        total, tp_hits: tpHits.length, stops: stops.length, timeouts: timeouts.length, errors: errors.length,
        win_rate_pct: +winRate.toFixed(1),
        total_pnl_usdt: +totalPnl.toFixed(4),
        avg_win_pnl: avgWinPnl !== null ? +avgWinPnl.toFixed(4) : null,
        avg_loss_pnl: avgLossPnl !== null ? +avgLossPnl.toFixed(4) : null,
        avg_timeout_pnl: avgTimeoutPnl !== null ? +avgTimeoutPnl.toFixed(4) : null,
        avg_tp_resolve_min: avgTpMin !== null ? +avgTpMin.toFixed(1) : null,
    };
}

// iter 21 fe (2026-05-16): Filter Candidate Tester
// Replay a CANDIDATE pre-buy filter against historical OUTCOME records
// to see whether it would have helped (blocking losses) or hurt (blocking
// winners). Used to validate filter ideas BEFORE shipping them.
//
// The candidate filter has three knobs:
//   withinHighPct   — "block when price is within X% of 30d high"
//   redDaysIn7      — "AND at least Y red daily candles in last 7"
//   maxReturn30dPct — "AND 30d return is BELOW Z% (i.e. not a strong uptrend)"

app.get('/api/filter-candidate-test', async (req, res) => {
    try {
        const dateFrom = req.query.date_from || new Date(Date.now() - 7*24*60*60*1000).toISOString().slice(0,10);
        const dateTo   = req.query.date_to   || new Date().toISOString().slice(0,10);
        const withinHi = parseFloat(req.query.within_high_pct || '90');
        const redDays  = parseInt(req.query.red_days_min    || '4', 10);
        const maxRet30 = parseFloat(req.query.max_30d_return_pct || '30');

        // Build date list
        const dates = [];
        const dFrom = new Date(dateFrom);
        const dTo   = new Date(dateTo);
        for (let d = new Date(dFrom); d <= dTo; d.setDate(d.getDate() + 1)) {
            dates.push(d.toISOString().slice(0,10));
        }

        // Collect all outcome records across the date range
        const allTrades = [];
        for (const date of dates) {
            const pattern = `METRICS:OUTCOME:${date}:*`;
            const stream = redis.scanStream({ match: pattern, count: 100 });
            const keys = [];
            stream.on('data', (b) => keys.push(...b));
            await new Promise(r => stream.on('end', r));
            for (const k of keys) {
                const h = await redis.hgetall(k);
                if (!h || !h.symbol || !h.buy_ts) continue;
                allTrades.push({
                    date,
                    symbol: h.symbol,
                    buy_ts: parseInt(h.buy_ts, 10),
                    filled: parseInt(h.filled || '0', 10),
                    exit_reason: h.exit_reason || '',
                    pnl_usdt: parseFloat(h.pnl_usdt || '0'),
                });
            }
        }

        // De-dupe by symbol+date (keep most recent)
        allTrades.sort((a, b) => b.buy_ts - a.buy_ts);
        const seen = new Set();
        const uniq = allTrades.filter(t => {
            const k = `${t.date}:${t.symbol}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });

        // For each trade, fetch 30 daily klines ending before buy_ts and compute the metrics
        const results = [];
        for (let i = 0; i < uniq.length; i += 5) {
            const batch = uniq.slice(i, i + 5);
            const batchResults = await Promise.all(batch.map(async (t) => {
                const sym = t.symbol.replace('/', '');
                const start = t.buy_ts - 31 * 24 * 60 * 60 * 1000;
                const end   = t.buy_ts;
                try {
                    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1d&startTime=${start}&endTime=${end}&limit=31`);
                    if (!r.ok) return { ...t, error: 'kline_fetch' };
                    const c1d = (await r.json()).filter(k => k[0] < t.buy_ts).slice(-30);
                    if (c1d.length < 8) return { ...t, error: 'insufficient_data' };
                    const closes = c1d.map(k => parseFloat(k[4]));
                    const opens  = c1d.map(k => parseFloat(k[1]));
                    const highs  = c1d.map(k => parseFloat(k[2]));
                    const last_close = closes[closes.length - 1];
                    const h30 = Math.max(...highs);
                    const ret30 = (last_close / closes[0] - 1) * 100;
                    const within = h30 > 0 ? (last_close / h30) * 100 : 0;
                    const last7open = opens.slice(-7);
                    const last7close = closes.slice(-7);
                    const red7 = last7close.reduce((s, cl, i) => s + (cl < last7open[i] ? 1 : 0), 0);
                    const blocked = within >= withinHi && red7 >= redDays && ret30 < maxRet30;
                    return {
                        ...t,
                        within_30d_high_pct: +within.toFixed(2),
                        red_days_in_7: red7,
                        ret_30d_pct: +ret30.toFixed(2),
                        blocked,
                    };
                } catch (e) {
                    return { ...t, error: e.message };
                }
            }));
            results.push(...batchResults);
        }

        // Classify outcomes
        const valid = results.filter(r => !r.error);
        const isWin = (t) => t.pnl_usdt > 0.005;
        const isLoss = (t) => t.pnl_usdt < -0.005;
        const isOpenOrZero = (t) => Math.abs(t.pnl_usdt) <= 0.005;

        const losses_caught   = valid.filter(t => t.blocked && isLoss(t));
        const wins_blocked    = valid.filter(t => t.blocked && isWin(t));
        const neutral_blocked = valid.filter(t => t.blocked && isOpenOrZero(t));
        const losses_missed   = valid.filter(t => !t.blocked && isLoss(t));
        const wins_kept       = valid.filter(t => !t.blocked && isWin(t));

        const sumPnl = (arr) => +arr.reduce((s, t) => s + t.pnl_usdt, 0).toFixed(4);
        const summary = {
            total_trades: valid.length,
            blocked_total: valid.filter(t => t.blocked).length,
            losses_caught: losses_caught.length,
            losses_caught_pnl_saved: -sumPnl(losses_caught),  // negative -> positive savings
            wins_blocked: wins_blocked.length,
            wins_blocked_pnl_lost: sumPnl(wins_blocked),       // positive -> lost opportunity
            neutral_blocked: neutral_blocked.length,
            losses_missed: losses_missed.length,
            wins_kept: wins_kept.length,
            actual_total_pnl: sumPnl(valid),
            simulated_total_pnl: sumPnl(valid.filter(t => !t.blocked)),
        };
        summary.net_impact = +(summary.simulated_total_pnl - summary.actual_total_pnl).toFixed(4);
        summary.verdict = summary.net_impact > 0.05 ? 'ACCEPT' : summary.net_impact < -0.05 ? 'REJECT' : 'NEUTRAL';

        res.json({
            params: { dateFrom, dateTo, withinHi, redDays, maxRet30 },
            summary,
            trades: results.sort((a, b) => b.buy_ts - a.buy_ts),
        });
    } catch (err) {
        res.status(500).json({ error: err.message, stack: err.stack });
    }
});

// iter 19 fe (2026-05-15): Limit-Buy Replay
// For every unfilled Buy 1 LIMIT (filled=0 in METRICS:OUTCOME), replays
// the trade two ways:
//   1. STATIC — would the original iter43-chosen limit price have filled
//      within 60 min if the bot's pending_pump_dump_cancel hadn't fired?
//   2. ADAPTIVE — what offset would the Adaptive Offset Predictor have
//      recommended, and would IT have filled?
// Answers: "does the new algorithm break existing auto-buy, or fix it?"

async function fetchKlinesRange(binanceSym, startMs, endMs) {
    try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${binanceSym}&interval=1m&startTime=${startMs}&endTime=${endMs}&limit=200`;
        const r = await fetch(url);
        if (!r.ok) return null;
        return await r.json();
    } catch (_) { return null; }
}

function computeAdaptiveFromKlines(klines, signalPrice) {
    if (!klines || klines.length < 10) return null;
    const opens  = klines.map(k => parseFloat(k[1]));
    const lows   = klines.map(k => parseFloat(k[3]));
    const closes = klines.map(k => parseFloat(k[4]));
    const n = klines.length;
    const dips = opens.map((o, i) => Math.max(0, (o - lows[i]) / o * 100));
    const p25 = percentile([...dips].sort((a,b)=>a-b), 25);
    const p50 = percentile([...dips].sort((a,b)=>a-b), 50);
    const p75 = percentile([...dips].sort((a,b)=>a-b), 75);
    const momentum5 = (closes[n-1] / closes[Math.max(0, n-6)] - 1) * 100;
    let rec;
    if (momentum5 <= -0.5) rec = p75;
    else if (momentum5 >= 0.5) rec = p25;
    else rec = p50;
    rec = Math.max(0.10, Math.min(2.0, rec));
    return {
        offset_pct: +rec.toFixed(3),
        buy_price: +(signalPrice * (1 - rec/100)).toFixed(10),
        p25: +p25.toFixed(3),
        p50: +p50.toFixed(3),
        p75: +p75.toFixed(3),
        momentum_5m: +momentum5.toFixed(2),
    };
}

function checkFill(klines, limitPrice) {
    if (!klines) return { filled: false, time_min: null, min_low: null };
    let minLow = Infinity;
    for (let i = 0; i < klines.length; i++) {
        const low = parseFloat(klines[i][3]);
        if (low < minLow) minLow = low;
        if (low <= limitPrice) return { filled: true, time_min: i+1, min_low: +low.toFixed(10) };
    }
    return { filled: false, time_min: null, min_low: minLow === Infinity ? null : +minLow.toFixed(10) };
}

// iter 20 fe (2026-05-16): full trade simulation after limit fill.
// Given the fill candle index, walks forward checking TP / stop / timeout.
// Matches the bot's iter43 strategy + iter42 TP target + iter39 catastrophic.
function simulateExit(klines, fillIdx, buyPrice, tpPct = 0.567, slPct = 2.5, timeoutMin = 240) {
    if (!klines || fillIdx == null || fillIdx >= klines.length) {
        return { outcome: 'no_data', exit_price: null };
    }
    const tpPrice = buyPrice * (1 + tpPct / 100);
    const slPrice = buyPrice * (1 - slPct / 100);
    const LEG_USDT = 48;
    const FEE = 0.00075;
    const qty = LEG_USDT / buyPrice;

    let outcome = 'timeout';
    let exitPrice = parseFloat(klines[klines.length - 1][4]);
    let resolveMin = (klines.length - fillIdx);
    let maxHigh = 0, minLow = Infinity;

    for (let i = fillIdx; i < klines.length && (i - fillIdx) < timeoutMin; i++) {
        const high = parseFloat(klines[i][2]);
        const low  = parseFloat(klines[i][3]);
        if (high > maxHigh) maxHigh = high;
        if (low < minLow) minLow = low;
        if (high >= tpPrice) {
            outcome = 'tp_hit';
            exitPrice = tpPrice;
            resolveMin = i - fillIdx + 1;
            break;
        }
        if (low <= slPrice) {
            outcome = 'stop_loss';
            exitPrice = slPrice;
            resolveMin = i - fillIdx + 1;
            break;
        }
    }

    const grossPnl = (exitPrice - buyPrice) * qty;
    const fees = 2 * FEE * LEG_USDT;
    const netPnl = grossPnl - fees;

    return {
        outcome,
        tp_price: +tpPrice.toFixed(10),
        sl_price: +slPrice.toFixed(10),
        exit_price: +exitPrice.toFixed(10),
        resolve_min: resolveMin,
        max_high: +maxHigh.toFixed(10),
        max_high_pct: +((maxHigh / buyPrice - 1) * 100).toFixed(2),
        min_low: minLow === Infinity ? null : +minLow.toFixed(10),
        min_low_pct: minLow === Infinity ? null : +((minLow / buyPrice - 1) * 100).toFixed(2),
        gross_pnl: +grossPnl.toFixed(4),
        net_pnl: +netPnl.toFixed(4),
    };
}

app.get('/api/limit-buy-replay', async (req, res) => {
    try {
        const date = req.query.date || new Date().toISOString().slice(0, 10);
        const lookbackMin = parseInt(req.query.lookback_min || '30', 10);
        const checkMin = parseInt(req.query.check_min || '60', 10);

        // Scan all OUTCOME keys for the date
        const pattern = `METRICS:OUTCOME:${date}:*`;
        const stream = redis.scanStream({ match: pattern, count: 100 });
        const keys = [];
        stream.on('data', (batch) => keys.push(...batch));
        await new Promise((resolve) => stream.on('end', resolve));

        // Pull each outcome record
        const trades = [];
        for (const k of keys) {
            const h = await redis.hgetall(k);
            if (!h || !h.symbol || !h.buy_ts) continue;
            const filled = parseInt(h.filled || '0', 10);
            if (filled !== 0) continue;  // only unfilled trades
            const buy_ts = parseInt(h.buy_ts, 10);
            const buy_1_limit_price = parseFloat(h.buy_1_limit_price);
            const signal_price_raw = h.signal_price || '';
            // Strip np.float64(...) wrapper if present
            let signal_price = parseFloat(signal_price_raw.replace(/np\.float64\(/, '').replace(/\)$/, ''));
            if (isNaN(signal_price) || isNaN(buy_1_limit_price)) continue;
            trades.push({
                symbol: h.symbol,
                buy_ts,
                signal_price,
                static_buy_price: buy_1_limit_price,
                exit_reason: h.exit_reason || '',
                origin: h.scalper_origin || '?',
            });
        }
        // De-dupe by symbol (keep most recent)
        trades.sort((a, b) => b.buy_ts - a.buy_ts);
        const seen = new Set();
        const uniqTrades = trades.filter(t => {
            if (seen.has(t.symbol)) return false;
            seen.add(t.symbol);
            return true;
        });

        // Extend fill check window for trade simulation (4h after fill)
        const TRADE_HORIZON_MIN = 240;

        // Replay each — in parallel batches of 3
        const results = [];
        for (let i = 0; i < uniqTrades.length; i += 3) {
            const batch = uniqTrades.slice(i, i + 3);
            const batchResults = await Promise.all(batch.map(async (t) => {
                const binanceSym = t.symbol.replace('/', '');
                // Pre-signal klines (for adaptive)
                const preStart = t.buy_ts - lookbackMin * 60 * 1000;
                const preEnd   = t.buy_ts;
                const preKl = await fetchKlinesRange(binanceSym, preStart, preEnd);
                // Post-signal klines: fetch enough for fill (60min) + trade horizon (4h after fill)
                // = 60 + 240 = 300 min total
                const postStart = t.buy_ts;
                const postEnd   = t.buy_ts + (checkMin + TRADE_HORIZON_MIN) * 60 * 1000;
                const postKl = await fetchKlinesRange(binanceSym, postStart, postEnd);

                const adaptive = computeAdaptiveFromKlines(preKl, t.signal_price);
                if (!adaptive) {
                    return { ...t, error: 'insufficient pre-signal klines' };
                }
                const staticFill = checkFill(postKl, t.static_buy_price);
                const adaptiveFill = checkFill(postKl, adaptive.buy_price);

                let winner;
                if (staticFill.filled && adaptiveFill.filled) winner = 'both';
                else if (adaptiveFill.filled && !staticFill.filled) winner = 'adaptive';
                else if (staticFill.filled && !adaptiveFill.filled) winner = 'static';
                else winner = 'neither';

                const staticOffsetPct = +(((1 - t.static_buy_price / t.signal_price) * 100).toFixed(3));

                // iter 20 fe: simulate the FULL TRADE for each scenario
                // (TP / stop / timeout after fill).
                let staticTrade = null, adaptiveTrade = null;
                if (staticFill.filled) {
                    staticTrade = simulateExit(postKl, staticFill.time_min - 1, t.static_buy_price);
                }
                if (adaptiveFill.filled) {
                    adaptiveTrade = simulateExit(postKl, adaptiveFill.time_min - 1, adaptive.buy_price);
                }

                return {
                    ...t,
                    static_offset_pct: staticOffsetPct,
                    adaptive,
                    static_fill: staticFill,
                    adaptive_fill: adaptiveFill,
                    static_trade: staticTrade,
                    adaptive_trade: adaptiveTrade,
                    winner,
                };
            }));
            results.push(...batchResults);
        }

        // Aggregate
        const summary = {
            total_unfilled: results.length,
            both_filled: results.filter(r => r.winner === 'both').length,
            adaptive_only: results.filter(r => r.winner === 'adaptive').length,
            static_only: results.filter(r => r.winner === 'static').length,
            neither: results.filter(r => r.winner === 'neither').length,
            errors: results.filter(r => r.error).length,
        };
        summary.adaptive_advantage = summary.adaptive_only - summary.static_only;

        // P&L summaries — what would each strategy have netted if traded fully
        const staticTrades = results.filter(r => r.static_trade);
        const adaptiveTrades = results.filter(r => r.adaptive_trade);
        const sumPnl = (arr, key) => +arr.reduce((s, r) => s + (r[key]?.net_pnl || 0), 0).toFixed(4);
        summary.static_total_pnl = sumPnl(staticTrades, 'static_trade');
        summary.adaptive_total_pnl = sumPnl(adaptiveTrades, 'adaptive_trade');
        summary.static_tp_hits = staticTrades.filter(r => r.static_trade.outcome === 'tp_hit').length;
        summary.static_stops   = staticTrades.filter(r => r.static_trade.outcome === 'stop_loss').length;
        summary.static_timeouts= staticTrades.filter(r => r.static_trade.outcome === 'timeout').length;
        summary.adaptive_tp_hits = adaptiveTrades.filter(r => r.adaptive_trade.outcome === 'tp_hit').length;
        summary.adaptive_stops   = adaptiveTrades.filter(r => r.adaptive_trade.outcome === 'stop_loss').length;
        summary.adaptive_timeouts= adaptiveTrades.filter(r => r.adaptive_trade.outcome === 'timeout').length;
        summary.pnl_advantage = +(summary.adaptive_total_pnl - summary.static_total_pnl).toFixed(4);

        res.json({
            date,
            params: { lookback_min: lookbackMin, check_min: checkMin },
            summary,
            trades: results,
        });
    } catch (err) {
        res.status(500).json({ error: err.message, stack: err.stack });
    }
});

// iter 18 fe (2026-05-15): Adaptive Offset Predictor
// Analyzes a coin's last 30× 1m candles to recommend the best limit-buy
// offset. iter43 uses fixed offsets (-0.15% CALM / -0.30% NORMAL /
// -0.70% VOLATILE / -1.50% X_VOLATILE) which can miss fills on calm
// coins or give up edge on choppy ones. This predictor returns the
// offset with ~50% historical fill probability.

function percentile(sortedArr, p) {
    if (!sortedArr.length) return 0;
    const idx = (sortedArr.length - 1) * (p / 100);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return sortedArr[lo];
    return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

function computeAdaptiveOffset(klines, current_price) {
    if (!klines || klines.length < 10) return null;
    const opens = klines.map(k => parseFloat(k[1]));
    const highs = klines.map(k => parseFloat(k[2]));
    const lows  = klines.map(k => parseFloat(k[3]));
    const closes= klines.map(k => parseFloat(k[4]));
    const vols  = klines.map(k => parseFloat(k[5]) * parseFloat(k[4]));   // USDT vol
    const n = klines.length;

    // Dip from open of each candle: (open - low) / open * 100
    // Only positive dips count (when low < open)
    const dipsFromOpen = opens.map((o, i) => Math.max(0, (o - lows[i]) / o * 100));
    const sortedDips = [...dipsFromOpen].sort((a, b) => a - b);
    const p25 = +percentile(sortedDips, 25).toFixed(4);
    const p50 = +percentile(sortedDips, 50).toFixed(4);
    const p75 = +percentile(sortedDips, 75).toFixed(4);
    const maxDip = +Math.max(...dipsFromOpen).toFixed(4);

    // Volume-weighted median dip (weight each dip by its candle's volume)
    const totalVol = vols.reduce((s, v) => s + v, 0);
    let cumVol = 0, vwMedian = p50;
    if (totalVol > 0) {
        const pairs = dipsFromOpen.map((d, i) => ({ d, v: vols[i] })).sort((a, b) => a.d - b.d);
        for (const { d, v } of pairs) {
            cumVol += v;
            if (cumVol >= totalVol / 2) { vwMedian = +d.toFixed(4); break; }
        }
    }

    // Fill probability at each iter43 static offset
    const fillProb = (offsetPct) => {
        let hits = 0;
        for (let i = 0; i < n; i++) {
            if (lows[i] <= opens[i] * (1 - offsetPct / 100)) hits++;
        }
        return +(hits / n).toFixed(3);
    };
    const fillProbabilities = {
        '0.15': fillProb(0.15),
        '0.30': fillProb(0.30),
        '0.70': fillProb(0.70),
        '1.50': fillProb(1.50),
    };

    // Recent momentum — last 5min drift
    const recent5_close = closes[n-1];
    const recent5_open  = closes[Math.max(0, n-6)];
    const momentum_5m_pct = +((recent5_close / recent5_open - 1) * 100).toFixed(2);

    // Spread proxy — last 5min high-low range
    const recent5_high = Math.max(...highs.slice(-5));
    const recent5_low  = Math.min(...lows.slice(-5));
    const spread_5m_pct = recent5_low > 0 ? +((recent5_high - recent5_low) / recent5_low * 100).toFixed(2) : 0;

    // Recommended adaptive offset:
    // Base = p50 (median dip)
    // Floor = 0.10% (don't go tighter than this)
    // Ceiling = 2.0% (don't go deeper than this)
    // If momentum is strongly negative, allow deeper (price is dropping)
    // If momentum strongly positive, tighter (price is rising, less dip)
    let recommended = p50;
    if (momentum_5m_pct <= -0.5) recommended = p75;       // dropping → use deeper offset
    else if (momentum_5m_pct >= 0.5) recommended = p25;   // rising → use shallower
    recommended = Math.max(0.10, Math.min(2.0, recommended));
    recommended = +recommended.toFixed(3);

    // Compute expected fill probability for the recommended offset
    const recFillProb = fillProb(recommended);

    return {
        n_candles: n,
        dip_stats: { p25, p50, p75, max_pct: maxDip, vw_median: vwMedian },
        fill_probabilities: fillProbabilities,
        momentum_5m_pct,
        spread_5m_pct,
        recommended: {
            offset_pct: recommended,
            buy_price: +(current_price * (1 - recommended / 100)).toFixed(8),
            expected_fill_prob: recFillProb,
            reason: momentum_5m_pct <= -0.5
                ? `Momentum negative (${momentum_5m_pct}% in 5m) — use p75 dip = ${p75}% for higher fill rate.`
                : momentum_5m_pct >= 0.5
                ? `Momentum positive (${momentum_5m_pct}% in 5m) — use p25 dip = ${p25}% (price rising, smaller dips).`
                : `Neutral momentum — use p50 dip = ${p50}% (50% historical fill).`,
        },
    };
}

app.get('/api/adaptive-offset', async (req, res) => {
    const sym = (req.query.symbol || '').toUpperCase().trim();
    if (!sym) return res.status(400).json({ error: 'symbol query param required' });
    const binanceSym = sym.includes('/') ? sym.replace('/', '') : sym;
    const ccxtSym = sym.includes('/') ? sym : (sym.endsWith('USDT') ? sym.slice(0, -4) + '/USDT' : sym);

    try {
        const cfgRaw = await redis.get(CONFIG_KEY);
        const cfg = { ...DEFAULT_TRADING_CONFIG, ...(cfgRaw ? JSON.parse(cfgRaw) : {}) };

        // Fetch ticker + 30× 1m klines + 1× 1h kline (for tier classification)
        const [tickerRes, klinesRes, hourlyRes] = await Promise.all([
            fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${binanceSym}`).then(r => r.json()),
            fetch(`https://api.binance.com/api/v3/klines?symbol=${binanceSym}&interval=1m&limit=30`).then(r => r.json()),
            fetch(`https://api.binance.com/api/v3/klines?symbol=${binanceSym}&interval=1h&limit=2`).then(r => r.json()),
        ]);
        if (tickerRes.code) return res.status(404).json({ error: tickerRes.msg || 'binance error' });
        if (!Array.isArray(klinesRes)) return res.status(502).json({ error: 'klines fetch failed' });

        const lastPrice = parseFloat(tickerRes.lastPrice);
        const change24 = parseFloat(tickerRes.priceChangePercent);

        // 1h range → iter43 tier
        const last1h = hourlyRes[hourlyRes.length - 1];
        const h1 = parseFloat(last1h[2]); const l1 = parseFloat(last1h[3]);
        const range1h = l1 > 0 ? (h1 - l1) / l1 * 100 : 0;

        let tier, staticOffset;
        if (range1h < cfg.adaptiveTierCalmMaxPct) { tier = 'CALM'; staticOffset = cfg.adaptiveBuy1OffsetCalm; }
        else if (range1h < cfg.adaptiveTierNormalMaxPct) { tier = 'NORMAL'; staticOffset = cfg.adaptiveBuy1OffsetNormal; }
        else if (range1h < cfg.adaptiveTierVolatileMaxPct) { tier = 'VOLATILE'; staticOffset = cfg.adaptiveBuy1OffsetVolatile; }
        else { tier = 'X_VOLATILE'; staticOffset = cfg.adaptiveBuy1OffsetXVolatile; }

        const adaptive = computeAdaptiveOffset(klinesRes, lastPrice);
        if (!adaptive) return res.status(500).json({ error: 'insufficient klines' });

        // Static iter43 fill probability
        const staticFillProb = adaptive.fill_probabilities[staticOffset.toFixed(2)]
                            ?? adaptive.fill_probabilities[String(staticOffset)] ?? null;

        // Verdict
        let verdict;
        if (staticFillProb !== null && staticFillProb < 0.20) {
            verdict = {
                recommendation: 'USE_ADAPTIVE',
                reason: `iter43 static -${staticOffset}% has only ${(staticFillProb*100).toFixed(0)}% fill probability. Adaptive -${adaptive.recommended.offset_pct}% has ${(adaptive.recommended.expected_fill_prob*100).toFixed(0)}%.`,
            };
        } else if (staticFillProb !== null && staticFillProb >= 0.50) {
            verdict = {
                recommendation: 'KEEP_STATIC',
                reason: `iter43 static -${staticOffset}% already has ${(staticFillProb*100).toFixed(0)}% fill probability — no need to change.`,
            };
        } else {
            verdict = {
                recommendation: 'CONSIDER_ADAPTIVE',
                reason: `iter43 static fill prob = ${(staticFillProb*100).toFixed(0)}%, adaptive = ${(adaptive.recommended.expected_fill_prob*100).toFixed(0)}%. Either is reasonable.`,
            };
        }

        res.json({
            symbol: ccxtSym,
            timestamp: new Date().toISOString(),
            market: {
                last_price: lastPrice,
                change_24h_pct: +change24.toFixed(2),
                range_1h_pct: +range1h.toFixed(2),
            },
            iter43: {
                tier,
                static_offset_pct: staticOffset,
                static_buy_price: +(lastPrice * (1 - staticOffset / 100)).toFixed(8),
                static_fill_prob: staticFillProb,
            },
            adaptive,
            verdict,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// iter 21 fe (2026-05-16): Adaptive Offset Eligibility Filter
// User asked: "if we will find the exact pattern we can apply [adaptive],
// otherwise we dont want use adaptive off set limit order price we can use
// the previous limit order offset price."
//
// 4-day replay showed Adaptive alone is LOSS-MAKING (-$1.70). The losers
// (MLN -$1.27, LINK -$1.27) share signatures we can detect BEFORE pulling
// the trigger. This endpoint gates each coin GREEN / YELLOW / RED:
//   GREEN  → safe to use adaptive offset (passes all gates)
//   YELLOW → either static fills fine, or adaptive offset is impractical
//   RED    → coin fails a safety filter; do NOT use adaptive (or static)
//
// Gates applied (ALL must pass for GREEN):
//   G1  iter38 near-top pump        — block QNT-style entries
//   G2  iter44 macro-top exhaustion — block PENDLE-style entries
//   G3  iter45 vol regime           — block MLN/LINK-style chaos
//   G4  iter46 not in extreme down  — recent 5m momentum > -0.8%
//   G5  static fill prob low        — only adapt when static would miss
//   G6  recommended offset modest   — adaptive ≤ 1.0% (deeper = risk)
//   G7  spread is sane              — 5m spread < 1.5%
function evaluateAdaptiveEligibility({ cfg, ticker, dailyKl, hourlyKl, oneMinKl, adaptive }) {
    const lastPrice = parseFloat(ticker.lastPrice);
    const chg24Pct  = parseFloat(ticker.priceChangePercent);
    const high24    = parseFloat(ticker.highPrice);
    const fromHigh24Pct = (lastPrice / high24 - 1) * 100;

    // 1h range
    let range1hPct = 0;
    if (Array.isArray(hourlyKl) && hourlyKl.length) {
        const k = hourlyKl[hourlyKl.length - 1];
        const h = parseFloat(k[2]); const l = parseFloat(k[3]);
        range1hPct = l > 0 ? (h - l) / l * 100 : 0;
    }

    // iter43 tier → static offset
    let tier, staticOffset;
    if (range1hPct < cfg.adaptiveTierCalmMaxPct)         { tier = 'CALM';        staticOffset = cfg.adaptiveBuy1OffsetCalm; }
    else if (range1hPct < cfg.adaptiveTierNormalMaxPct)  { tier = 'NORMAL';      staticOffset = cfg.adaptiveBuy1OffsetNormal; }
    else if (range1hPct < cfg.adaptiveTierVolatileMaxPct){ tier = 'VOLATILE';    staticOffset = cfg.adaptiveBuy1OffsetVolatile; }
    else                                                 { tier = 'X_VOLATILE';  staticOffset = cfg.adaptiveBuy1OffsetXVolatile; }
    // fill_probabilities keys are "0.15"/"0.30"/"0.70"/"1.50". String(0.7) → "0.7"
    // so normalise to two decimals before lookup.
    const staticFillProb = adaptive.fill_probabilities[staticOffset.toFixed(2)]
                        ?? adaptive.fill_probabilities[String(staticOffset)] ?? null;
    const staticFillProbForCompare = staticFillProb ?? 0;

    // Daily klines processing (drop today's partial)
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const dayStart = now - (now % dayMs);
    const dailyDone = (Array.isArray(dailyKl) ? dailyKl : []).filter(k => k[0] < dayStart);
    const last30d = dailyDone.slice(-30);
    const last5d  = dailyDone.slice(-5);

    const gates = [];

    // G1: iter38 near-top pump
    const g1Block = cfg.nearTopPumpFilterEnabled &&
                    chg24Pct >= cfg.nearTopPumpMin24hChangePct &&
                    fromHigh24Pct >= -cfg.nearTopPumpMaxFromHighPct;
    gates.push({
        id: 'g1_near_top_pump', name: 'iter38 — Near-top pump', pass: !g1Block, blocking: !!g1Block,
        detail: `24h +${chg24Pct.toFixed(2)}% / from high ${fromHigh24Pct.toFixed(2)}%`,
        reason: g1Block ? `pumped +${chg24Pct.toFixed(2)}% AND within ${(-fromHigh24Pct).toFixed(2)}% of 24h high — likely top-buy` : 'ok',
    });

    // G2: iter44 macro-top exhaustion
    let g2Block = false, g2Detail = 'insufficient data';
    if (last30d.length >= 8) {
        const closes = last30d.map(k => parseFloat(k[4]));
        const opens  = last30d.map(k => parseFloat(k[1]));
        const highs  = last30d.map(k => parseFloat(k[2]));
        const lastC = closes[closes.length - 1];
        const ret30 = (lastC / closes[0] - 1) * 100;
        const h30 = Math.max(...highs);
        const withinHi = h30 > 0 ? (lastC / h30) * 100 : 0;
        const last7 = closes.slice(-7);
        const open7 = opens.slice(-7);
        const red7 = last7.reduce((s, c, i) => s + (c < open7[i] ? 1 : 0), 0);
        g2Block = cfg.macroTopFilterEnabled &&
                  ret30 >= cfg.macroTopMinReturnPct &&
                  withinHi >= cfg.macroTopWithinHighPct &&
                  red7 >= cfg.macroTopMinRedDaysIn7;
        g2Detail = `30d +${ret30.toFixed(1)}% / within ${withinHi.toFixed(1)}% of high / red ${red7}/7`;
    }
    gates.push({
        id: 'g2_macro_top', name: 'iter44 — Macro-top exhaustion', pass: !g2Block, blocking: !!g2Block,
        detail: g2Detail,
        reason: g2Block ? 'pumped high + near top + already bleeding → expect more pain' : 'ok',
    });

    // G3: iter45 vol regime
    let g3Block = false, g3Detail = 'insufficient data';
    if (last5d.length >= 3) {
        const ranges = last5d.map(k => {
            const h = parseFloat(k[2]), l = parseFloat(k[3]);
            return l > 0 ? (h - l) / l * 100 : 0;
        });
        const dailyChgs = last5d.map(k => {
            const o = parseFloat(k[1]), c = parseFloat(k[4]);
            return o > 0 ? (c - o) / o * 100 : 0;
        });
        const maxR = Math.max(...ranges);
        const worst = Math.min(...dailyChgs);
        g3Block = cfg.volRegimeFilterEnabled &&
                  ((maxR > cfg.volRegimeMaxDailyRangePct) || (worst <= -cfg.volRegimeBigCrashPct));
        g3Detail = `max 5d range ${maxR.toFixed(1)}% / worst day ${worst.toFixed(1)}%`;
    }
    gates.push({
        id: 'g3_vol_regime', name: 'iter45 — Vol regime chaos', pass: !g3Block, blocking: !!g3Block,
        detail: g3Detail,
        reason: g3Block ? 'recent days have wild ranges or big crashes → chaos regime' : 'ok',
    });

    // G4: recent momentum not in freefall
    const momentum5 = adaptive.momentum_5m_pct;
    const g4Block = momentum5 <= -0.8;
    gates.push({
        id: 'g4_momentum', name: 'Recent 5m momentum not in freefall', pass: !g4Block, blocking: !!g4Block,
        detail: `5m drift ${momentum5.toFixed(2)}%`,
        reason: g4Block ? `falling ${momentum5.toFixed(2)}% in last 5m — catching a falling knife` : 'ok',
    });

    // G5: static fill probability LOW (only useful when static would miss)
    const g5Block = staticFillProb !== null && staticFillProb >= 0.30;
    gates.push({
        id: 'g5_static_too_likely', name: 'Static fill prob low (< 30%)',
        pass: !g5Block, blocking: !!g5Block,
        detail: `static -${staticOffset}% fill prob = ${staticFillProb !== null ? (staticFillProb*100).toFixed(0) + '%' : 'n/a'}`,
        reason: g5Block ? 'static already likely to fill — no benefit from adaptive, just risk' : 'ok',
    });

    // G6: recommended adaptive offset modest (don't go too deep)
    const recOff = adaptive.recommended.offset_pct;
    const g6Block = recOff > 1.0;
    gates.push({
        id: 'g6_offset_modest', name: 'Adaptive offset ≤ 1.0%', pass: !g6Block, blocking: !!g6Block,
        detail: `recommended -${recOff}%`,
        reason: g6Block ? `adaptive wants -${recOff}% which is too deep — coin is in a dump` : 'ok',
    });

    // G7: spread sanity
    const spread5m = adaptive.spread_5m_pct ?? 0;
    const g7Block = spread5m > 1.5;
    gates.push({
        id: 'g7_spread_sane', name: '5m spread < 1.5%', pass: !g7Block, blocking: !!g7Block,
        detail: `5m spread ${spread5m.toFixed(2)}%`,
        reason: g7Block ? 'wide spread implies thin book — adaptive limit may sit forever' : 'ok',
    });

    // G8: adaptive is MEANINGFULLY better than static (the whole point of using it).
    // Two failure modes we want to catch:
    //   (a) Adaptive fill prob is itself tiny (< 20%) — neither approach will fill,
    //       so picking adaptive over static buys nothing and adds risk if it does.
    //   (b) Adaptive only matches static — no real fill-rate uplift, just a deeper
    //       buy price = worse R/R on the trades that do fill.
    const adaFillProb = adaptive.recommended.expected_fill_prob ?? 0;
    const minAdaProb = 0.20;          // 20% — must fill at least sometimes
    const minDelta = 0.05;            // 5pp — must materially beat static
    const g8Block = !(adaFillProb >= minAdaProb && (adaFillProb - staticFillProbForCompare) >= minDelta);
    gates.push({
        id: 'g8_adaptive_uplift',
        name: 'Adaptive uplift meaningful (fill ≥ 20% AND > static + 5pp)',
        pass: !g8Block, blocking: !!g8Block,
        detail: `adaptive ${(adaFillProb*100).toFixed(0)}% vs static ${(staticFillProbForCompare*100).toFixed(0)}% (delta ${((adaFillProb - staticFillProbForCompare)*100).toFixed(0)}pp)`,
        reason: g8Block ? (adaFillProb < minAdaProb
            ? `adaptive fill prob only ${(adaFillProb*100).toFixed(0)}% — won’t fill often enough to justify the risk`
            : `adaptive only ${((adaFillProb - staticFillProbForCompare)*100).toFixed(0)}pp better than static — not worth the deeper buy price`) : 'ok',
    });

    // Verdict
    const safetyFail = gates.slice(0, 3).find(g => g.blocking);  // G1-G3: hard safety
    const utilityFail = gates.slice(3).find(g => g.blocking);    // G4-G8: adaptive usefulness
    let level, recommendation, headline;
    if (safetyFail) {
        level = 'RED';
        recommendation = 'BLOCK';
        headline = `Coin fails safety gate: ${safetyFail.name}. Do not use adaptive (and bot likely won’t enter at all).`;
    } else if (utilityFail) {
        level = 'YELLOW';
        recommendation = 'KEEP_STATIC';
        headline = `Safety OK but adaptive is not the right tool here: ${utilityFail.name}. Use iter43 static -${staticOffset}%.`;
    } else {
        level = 'GREEN';
        recommendation = 'USE_ADAPTIVE';
        headline = `All gates pass. Adaptive -${recOff}% is preferred over static -${staticOffset}% (static fill prob only ${staticFillProb !== null ? (staticFillProb*100).toFixed(0) + '%' : 'n/a'}).`;
    }

    return {
        level, recommendation, headline,
        tier, static_offset_pct: staticOffset, static_fill_prob: staticFillProb,
        adaptive_offset_pct: recOff, adaptive_fill_prob: adaptive.recommended.expected_fill_prob,
        gates,
    };
}

app.get('/api/adaptive-eligibility', async (req, res) => {
    const sym = (req.query.symbol || '').toUpperCase().trim();
    if (!sym) return res.status(400).json({ error: 'symbol query param required' });
    const binanceSym = sym.includes('/') ? sym.replace('/', '') : sym;
    const ccxtSym = sym.includes('/') ? sym : (sym.endsWith('USDT') ? sym.slice(0, -4) + '/USDT' : sym);

    try {
        const cfgRaw = await redis.get(CONFIG_KEY);
        const cfg = { ...DEFAULT_TRADING_CONFIG, ...(cfgRaw ? JSON.parse(cfgRaw) : {}) };

        const [tickerRes, klinesRes, hourlyRes, dailyRes] = await Promise.all([
            fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${binanceSym}`).then(r => r.json()),
            fetch(`https://api.binance.com/api/v3/klines?symbol=${binanceSym}&interval=1m&limit=30`).then(r => r.json()),
            fetch(`https://api.binance.com/api/v3/klines?symbol=${binanceSym}&interval=1h&limit=2`).then(r => r.json()),
            fetch(`https://api.binance.com/api/v3/klines?symbol=${binanceSym}&interval=1d&limit=31`).then(r => r.json()),
        ]);
        if (tickerRes.code) return res.status(404).json({ error: tickerRes.msg || 'binance error' });
        if (!Array.isArray(klinesRes)) return res.status(502).json({ error: 'klines fetch failed' });

        const lastPrice = parseFloat(tickerRes.lastPrice);
        const adaptive = computeAdaptiveOffset(klinesRes, lastPrice);
        if (!adaptive) return res.status(500).json({ error: 'insufficient klines' });

        const eligibility = evaluateAdaptiveEligibility({
            cfg, ticker: tickerRes, dailyKl: dailyRes, hourlyKl: hourlyRes, oneMinKl: klinesRes, adaptive,
        });

        res.json({
            symbol: ccxtSym,
            timestamp: new Date().toISOString(),
            market: {
                last_price: lastPrice,
                change_24h_pct: +parseFloat(tickerRes.priceChangePercent).toFixed(2),
                from_24h_high_pct: +((lastPrice / parseFloat(tickerRes.highPrice) - 1) * 100).toFixed(2),
            },
            eligibility,
            adaptive,
        });
    } catch (err) {
        res.status(500).json({ error: err.message, stack: err.stack });
    }
});

// iter 21 fe: Historical eligibility replay — for each unfilled trade on the
// given date, decide what the eligibility gate WOULD HAVE said, then simulate
// the chosen strategy (GREEN → adaptive, anything else → static) and aggregate
// P&L. This is the proof that selective adaptive beats blanket adaptive.
app.get('/api/adaptive-eligibility-replay', async (req, res) => {
    try {
        const date = req.query.date || new Date().toISOString().slice(0, 10);
        const lookbackMin = parseInt(req.query.lookback_min || '30', 10);
        const checkMin = parseInt(req.query.check_min || '60', 10);
        const TRADE_HORIZON_MIN = 240;

        const cfgRaw = await redis.get(CONFIG_KEY);
        const cfg = { ...DEFAULT_TRADING_CONFIG, ...(cfgRaw ? JSON.parse(cfgRaw) : {}) };

        // Scan OUTCOME records for the date — unfilled trades only
        const pattern = `METRICS:OUTCOME:${date}:*`;
        const stream = redis.scanStream({ match: pattern, count: 100 });
        const keys = [];
        stream.on('data', (batch) => keys.push(...batch));
        await new Promise((resolve) => stream.on('end', resolve));

        const trades = [];
        for (const k of keys) {
            const h = await redis.hgetall(k);
            if (!h || !h.symbol || !h.buy_ts) continue;
            if (parseInt(h.filled || '0', 10) !== 0) continue;
            const buy_ts = parseInt(h.buy_ts, 10);
            const buy_1_limit_price = parseFloat(h.buy_1_limit_price);
            let signal_price = parseFloat((h.signal_price || '').replace(/np\.float64\(/, '').replace(/\)$/, ''));
            if (isNaN(signal_price) || isNaN(buy_1_limit_price)) continue;
            trades.push({ symbol: h.symbol, buy_ts, signal_price, static_buy_price: buy_1_limit_price });
        }
        trades.sort((a, b) => b.buy_ts - a.buy_ts);
        const seen = new Set();
        const uniq = trades.filter(t => { if (seen.has(t.symbol)) return false; seen.add(t.symbol); return true; });

        const results = [];
        for (let i = 0; i < uniq.length; i += 3) {
            const batch = uniq.slice(i, i + 3);
            const br = await Promise.all(batch.map(async (t) => {
                const binanceSym = t.symbol.replace('/', '');
                const preStart = t.buy_ts - lookbackMin * 60 * 1000;
                const preEnd   = t.buy_ts;
                const postStart= t.buy_ts;
                const postEnd  = t.buy_ts + (checkMin + TRADE_HORIZON_MIN) * 60 * 1000;
                // Snapshot pre-signal market state (ticker/daily/hourly closest to signal)
                const [preKl, postKl, dailyRes, hourlyRes, tickerRes] = await Promise.all([
                    fetchKlinesRange(binanceSym, preStart, preEnd),
                    fetchKlinesRange(binanceSym, postStart, postEnd),
                    fetch(`https://api.binance.com/api/v3/klines?symbol=${binanceSym}&interval=1d&limit=31&endTime=${t.buy_ts}`).then(r => r.json()).catch(() => null),
                    fetch(`https://api.binance.com/api/v3/klines?symbol=${binanceSym}&interval=1h&limit=2&endTime=${t.buy_ts}`).then(r => r.json()).catch(() => null),
                    fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${binanceSym}`).then(r => r.json()).catch(() => null),
                ]);
                if (!preKl || preKl.length < 10) return { ...t, error: 'insufficient pre klines' };

                const adaptive = computeAdaptiveOffset(preKl, t.signal_price);
                if (!adaptive) return { ...t, error: 'adaptive compute failed' };

                // Build synthetic ticker from snapshot (use buy_ts as anchor)
                // We use real ticker as best-effort (24h window slides) — good enough for gates.
                const synthTicker = tickerRes && !tickerRes.code ? tickerRes : {
                    lastPrice: t.signal_price.toString(),
                    priceChangePercent: '0',
                    highPrice: t.signal_price.toString(),
                };

                const eligibility = evaluateAdaptiveEligibility({
                    cfg, ticker: synthTicker, dailyKl: dailyRes, hourlyKl: hourlyRes,
                    oneMinKl: preKl, adaptive,
                });

                // Simulate STATIC trade (always)
                const staticFill = checkFill(postKl, t.static_buy_price);
                const staticTrade = staticFill.filled ? simulateExit(postKl, staticFill.time_min - 1, t.static_buy_price) : null;

                // Simulate ADAPTIVE trade
                const adaptivePrice = adaptive.recommended.buy_price;
                const adaptiveFill = checkFill(postKl, adaptivePrice);
                const adaptiveTrade = adaptiveFill.filled ? simulateExit(postKl, adaptiveFill.time_min - 1, adaptivePrice) : null;

                // SELECTIVE: use adaptive only if GREEN, else fall back to static
                const useAdaptive = eligibility.level === 'GREEN';
                const selectiveTrade = useAdaptive ? adaptiveTrade : staticTrade;
                const selectiveFilled = useAdaptive ? adaptiveFill.filled : staticFill.filled;
                const selectiveStrategy = useAdaptive ? 'adaptive' : 'static';

                return {
                    ...t,
                    eligibility_level: eligibility.level,
                    eligibility_reco: eligibility.recommendation,
                    eligibility_headline: eligibility.headline,
                    blocking_gate: eligibility.gates.find(g => g.blocking)?.name || null,
                    static_offset_pct: +(((1 - t.static_buy_price / t.signal_price) * 100).toFixed(3)),
                    adaptive_offset_pct: adaptive.recommended.offset_pct,
                    adaptive_buy_price: adaptivePrice,
                    static_filled: staticFill.filled,
                    adaptive_filled: adaptiveFill.filled,
                    static_trade: staticTrade,
                    adaptive_trade: adaptiveTrade,
                    selective_strategy: selectiveStrategy,
                    selective_filled: selectiveFilled,
                    selective_trade: selectiveTrade,
                };
            }));
            results.push(...br);
        }

        // Aggregate
        const sumPnl = arr => +arr.reduce((s, r) => s + (r.net_pnl || 0), 0).toFixed(4);
        const staticTrades   = results.filter(r => r.static_trade).map(r => r.static_trade);
        const adaptiveTrades = results.filter(r => r.adaptive_trade).map(r => r.adaptive_trade);
        const selectiveTrades= results.filter(r => r.selective_trade).map(r => r.selective_trade);

        const greenTrades  = results.filter(r => r.eligibility_level === 'GREEN');
        const yellowTrades = results.filter(r => r.eligibility_level === 'YELLOW');
        const redTrades    = results.filter(r => r.eligibility_level === 'RED');

        const summary = {
            total_unfilled: results.length,
            errors: results.filter(r => r.error).length,
            level_counts: {
                green: greenTrades.length, yellow: yellowTrades.length, red: redTrades.length,
            },

            // Pure-static (baseline)
            static_filled: results.filter(r => r.static_filled).length,
            static_total_pnl: sumPnl(staticTrades),
            static_tp: staticTrades.filter(t => t.outcome === 'tp_hit').length,
            static_sl: staticTrades.filter(t => t.outcome === 'stop_loss').length,
            static_to: staticTrades.filter(t => t.outcome === 'timeout').length,

            // Pure-adaptive (what we proved was loss-making)
            adaptive_filled: results.filter(r => r.adaptive_filled).length,
            adaptive_total_pnl: sumPnl(adaptiveTrades),
            adaptive_tp: adaptiveTrades.filter(t => t.outcome === 'tp_hit').length,
            adaptive_sl: adaptiveTrades.filter(t => t.outcome === 'stop_loss').length,
            adaptive_to: adaptiveTrades.filter(t => t.outcome === 'timeout').length,

            // Selective (adaptive ONLY for GREEN, static otherwise)
            selective_filled: results.filter(r => r.selective_filled).length,
            selective_total_pnl: sumPnl(selectiveTrades),
            selective_tp: selectiveTrades.filter(t => t.outcome === 'tp_hit').length,
            selective_sl: selectiveTrades.filter(t => t.outcome === 'stop_loss').length,
            selective_to: selectiveTrades.filter(t => t.outcome === 'timeout').length,
        };
        summary.selective_vs_static_gain   = +(summary.selective_total_pnl - summary.static_total_pnl).toFixed(4);
        summary.selective_vs_adaptive_gain = +(summary.selective_total_pnl - summary.adaptive_total_pnl).toFixed(4);

        res.json({ date, params: { lookback_min: lookbackMin, check_min: checkMin }, summary, trades: results });
    } catch (err) {
        res.status(500).json({ error: err.message, stack: err.stack });
    }
});

// iter 23 fe (2026-05-16): Pending-Buy Health Analyzer
//
// User story: bot placed a Buy 1 LIMIT for ZAMA at -0.15% offset; price never
// dipped, it drifted up, the limit just sat there. User manually cancelled
// because they couldn't tell whether price would come back to fill or fade.
//
// "instead of manual cancel, we need to analyse that coin how much percentage
//  it went up and how much percentage it is coming down, it will increase
//  again or not, so based on we can cancell the buy order or we can cancell
//  and can limit buy 1 order offset can adjust."
//
// Classification (priority order, first match wins) — all thresholds scale
// with the iter43 volatility tier so a 0.3% drift means very different things
// in CALM vs X_VOLATILE coins:
//
//   1. AT_LIMIT          current ≤ limit            → WAIT (will fill)
//   2. MISSED_BOAT       pumped ≥ missPeak rising   → CANCEL
//   3. PUMP_AND_DUMP     pumped + crash + falling   → CANCEL
//   4. DRIFTED_REPRICE   drift up + healthy pullback→ REPRICE at new offset
//   5. DRIFTED_UP        drift up, no real pullback → CANCEL (signal faded)
//   6. STALE_FLAT        ~no movement after staleMin→ CANCEL (free the slot)
//   7. HEALTHY_WAIT      nothing alarming           → RIDE

function classifyPendingBuy({ signalPrice, limitPrice, signalTs, klines, currentPrice, tier, now }) {
    now = now || Date.now();
    const ageSec = Math.max(0, (now - signalTs) / 1000);
    const ageMin = ageSec / 60;

    // Walk klines: find peak high, peak index, and the lowest low AFTER the peak.
    let peakHigh = signalPrice;
    let peakIdx = -1;
    klines.forEach((k, i) => {
        const high = parseFloat(k[2]);
        if (high > peakHigh) { peakHigh = high; peakIdx = i; }
    });
    let troughLow = peakHigh;
    if (peakIdx >= 0) {
        klines.slice(peakIdx).forEach(k => {
            const low = parseFloat(k[3]);
            if (low < troughLow) troughLow = low;
        });
    }

    // Recent 3m momentum (close-vs-close)
    const tail = klines.slice(-3);
    let m3pct = 0;
    if (tail.length >= 2) {
        const lastClose  = parseFloat(tail[tail.length - 1][4]);
        const firstClose = parseFloat(tail[0][1]);
        if (firstClose > 0) m3pct = (lastClose / firstClose - 1) * 100;
    }

    // Volume decay: last 3m vs prior 3m
    const sumQv = arr => arr.reduce((s, k) => s + parseFloat(k[7] || 0), 0);
    const last3v = sumQv(klines.slice(-3));
    const prev3v = sumQv(klines.slice(-6, -3));
    const volDecay = prev3v > 0 ? last3v / prev3v : 1;

    // Trend counts (last 5 candles)
    const tailHL = klines.slice(-5);
    let hh = 0, ll = 0;
    for (let i = 1; i < tailHL.length; i++) {
        if (parseFloat(tailHL[i][2]) > parseFloat(tailHL[i-1][2])) hh++;
        if (parseFloat(tailHL[i][3]) < parseFloat(tailHL[i-1][3])) ll++;
    }

    const peakPct    = signalPrice > 0 ? (peakHigh - signalPrice) / signalPrice * 100 : 0;
    const pullbackPct= peakHigh > 0 ? (peakHigh - currentPrice) / peakHigh * 100 : 0;
    const peakToTroughPct = peakHigh > 0 ? (peakHigh - troughLow) / peakHigh * 100 : 0;
    const limitDistPct = limitPrice > 0 ? (currentPrice - limitPrice) / limitPrice * 100 : 0;

    // Tier-aware thresholds. Tuned from ZAMA-class CALM behavior (0.18% pump
    // over 14 min IS the missed-boat pattern at this tier).
    const TIER_TH = {
        CALM:       { staleMin:  8, staleMaxPeak: 0.10, repriceMinPeak: 0.15, missPeak: 0.40, dumpPeak: 0.30, dumpPullback: 0.30 },
        NORMAL:     { staleMin: 10, staleMaxPeak: 0.25, repriceMinPeak: 0.35, missPeak: 0.80, dumpPeak: 0.50, dumpPullback: 0.50 },
        VOLATILE:   { staleMin: 15, staleMaxPeak: 0.50, repriceMinPeak: 0.70, missPeak: 1.50, dumpPeak: 1.00, dumpPullback: 0.80 },
        X_VOLATILE: { staleMin: 20, staleMaxPeak: 1.00, repriceMinPeak: 1.40, missPeak: 3.00, dumpPeak: 2.00, dumpPullback: 1.50 },
    };
    const TH = TIER_TH[tier] || TIER_TH.NORMAL;

    // The offset we originally used (sign-positive %). Used for REPRICE suggestion.
    const originalOffsetPct = signalPrice > 0 ? Math.abs((signalPrice - limitPrice) / signalPrice * 100) : 0.15;

    let classification, action, headline, suggested = null;

    if (currentPrice <= limitPrice) {
        classification = 'AT_LIMIT';
        action = 'WAIT';
        headline = `Price has hit the limit ($${currentPrice.toFixed(8)} ≤ $${limitPrice.toFixed(8)}). Will fill on next tick.`;
    } else if (peakPct >= TH.missPeak && pullbackPct < 0.30 && m3pct > 0) {
        classification = 'MISSED_BOAT';
        action = 'CANCEL';
        headline = `Coin pumped +${peakPct.toFixed(2)}% (≥${TH.missPeak}% for ${tier}) and is still rising (${m3pct.toFixed(2)}% in 3m). The dip-buy at $${limitPrice.toFixed(8)} won’t hit. Cancel and look for a fresh signal.`;
    } else if (peakPct >= TH.dumpPeak && pullbackPct >= TH.dumpPullback && m3pct <= -0.20 && ll >= 2) {
        classification = 'PUMP_AND_DUMP';
        action = 'CANCEL';
        headline = `Pump-and-dump pattern: +${peakPct.toFixed(2)}% pump then −${pullbackPct.toFixed(2)}% pullback from peak, momentum ${m3pct.toFixed(2)}%/3m, ${ll} lower lows in last 5m. If this fills the limit, expect further losses. Cancel.`;
    } else if (
        ageMin >= TH.staleMin &&
        peakPct >= TH.repriceMinPeak &&
        pullbackPct >= 0.10 && pullbackPct <= 0.50 &&
        // Only suggest reprice if current is meaningfully farther above limit
        // than the original offset — otherwise the new limit price would equal
        // the old one (no-op). This filters out cases where pullback already
        // brought price back near signal.
        limitDistPct > originalOffsetPct * 1.4
    ) {
        const newLimit = +(currentPrice * (1 - originalOffsetPct / 100)).toFixed(10);
        classification = 'DRIFTED_REPRICE';
        action = 'REPRICE';
        suggested = { new_offset_pct: +originalOffsetPct.toFixed(3), new_limit_price: newLimit };
        headline = `Coin drifted +${peakPct.toFixed(2)}% then started a healthy pullback (${pullbackPct.toFixed(2)}% from peak). Current is ${limitDistPct.toFixed(2)}% above limit — original $${limitPrice.toFixed(8)} is now too far below. Reprice to $${newLimit.toFixed(8)} (−${originalOffsetPct.toFixed(2)}% from current $${currentPrice.toFixed(8)}).`;
    } else if (ageMin >= TH.staleMin && peakPct >= TH.staleMaxPeak && pullbackPct < 0.10 && m3pct >= -0.10) {
        classification = 'DRIFTED_UP';
        action = 'CANCEL';
        headline = `Coin drifted up +${peakPct.toFixed(2)}% but no real pullback (${pullbackPct.toFixed(2)}% from peak). After ${ageMin.toFixed(0)}m the signal is fading — the price is unlikely to come back ${limitDistPct.toFixed(2)}% lower to fill at $${limitPrice.toFixed(8)}. Cancel.`;
    } else if (ageMin >= TH.staleMin && peakPct < TH.staleMaxPeak) {
        classification = 'STALE_FLAT';
        action = 'CANCEL';
        headline = `Order has been pending ${ageMin.toFixed(0)}m. Coin barely moved (peak +${peakPct.toFixed(2)}%, range ${peakToTroughPct.toFixed(2)}%). Signal is dead — cancel and free the slot.`;
    } else if (
        // Active-pullback hold: price is actively heading toward the limit
        // (negative momentum AND we're closer to limit than to signal).
        m3pct < 0 && limitDistPct < originalOffsetPct * 0.6
    ) {
        classification = 'PULLBACK_INCOMING';
        action = 'RIDE';
        headline = `Active pullback toward limit: 3m momentum ${m3pct.toFixed(2)}%, only ${limitDistPct.toFixed(2)}% above limit. Fill likely on the next dip — let it ride.`;
    } else if (ageMin < TH.staleMin) {
        classification = 'HEALTHY_WAIT';
        action = 'RIDE';
        headline = `Order is fresh (${ageMin.toFixed(0)}m of ${TH.staleMin}m staleness budget). Peak +${peakPct.toFixed(2)}%, current ${limitDistPct.toFixed(2)}% above limit. Give it time.`;
    } else {
        // Default for "old enough but ambiguous" — coin moved a bit, then
        // returned, no clear pullback toward limit. ZAMA-class scenario.
        // User's preference is to cancel and chase a fresher signal rather
        // than let a slot sit idle waiting on stale interest.
        classification = 'DRIFTED_NO_DIP';
        action = 'CANCEL';
        headline = `Coin moved +${peakPct.toFixed(2)}% then mostly returned (pullback ${pullbackPct.toFixed(2)}%), and the limit at $${limitPrice.toFixed(8)} has not been touched in ${ageMin.toFixed(0)}m. 3m momentum ${m3pct.toFixed(2)}% — no clear dip incoming. Cancel and free the slot for a fresher signal.`;
    }

    return {
        tier,
        age_min: +ageMin.toFixed(1),
        signal_price: +signalPrice.toFixed(10),
        limit_price: +limitPrice.toFixed(10),
        current_price: +currentPrice.toFixed(10),
        peak_high: +peakHigh.toFixed(10),
        peak_pct_from_signal: +peakPct.toFixed(3),
        trough_low: +troughLow.toFixed(10),
        pullback_from_peak_pct: +pullbackPct.toFixed(3),
        peak_to_trough_pct: +peakToTroughPct.toFixed(3),
        current_vs_limit_pct: +limitDistPct.toFixed(3),
        momentum_3m_pct: +m3pct.toFixed(3),
        volume_decay_ratio: +volDecay.toFixed(2),
        higher_highs_5m: hh,
        lower_lows_5m: ll,
        classification,
        action,
        headline,
        suggested,
        thresholds: TH,
    };
}

// Strip "np.float64(...)" wrappers that the Python backend sometimes leaks.
function _stripNp(s) {
    return parseFloat(String(s || '').replace(/np\.float64\(/, '').replace(/\)$/, ''));
}

// Find the live Binance open BUY LIMIT for a symbol. The bot reliably
// populates BINANCE:OPEN_ORDERS:ALL; per-symbol keys are not always set.
// Try per-symbol first, fall back to ALL filtered.
async function findOpenBuyLimit(binanceSym) {
    try {
        const symRaw = await redis.get(`BINANCE:OPEN_ORDERS:${binanceSym}`);
        const symArr = symRaw ? JSON.parse(symRaw) : [];
        const fromSym = symArr.find(x => x.side === 'BUY' && x.type === 'LIMIT');
        if (fromSym) return fromSym;
    } catch (_) {}
    try {
        const allRaw = await redis.get('BINANCE:OPEN_ORDERS:ALL');
        const allArr = allRaw ? JSON.parse(allRaw) : [];
        return allArr.find(x => (x.symbol === binanceSym) && x.side === 'BUY' && x.type === 'LIMIT') || null;
    } catch (_) {}
    return null;
}

// Locate the most recent OUTCOME record across the last 2 days that matches
// the given binance symbol — used as fallback when no order_id is supplied.
async function findRecentOutcomeForSymbol(binanceSym) {
    const now = Date.now();
    for (const off of [0, 86400000]) {
        const date = new Date(now - off).toISOString().slice(0, 10);
        const o = await redis.hgetall(`METRICS:OUTCOME:${date}:${binanceSym}`);
        if (o && o.symbol) return { date, outcome: o };
    }
    return null;
}

// Determine the iter43 tier from the current 1h range. Returns the tier name
// plus the static offset that would have been used.
async function classifyTierFromBinance(binanceSym, cfg) {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${binanceSym}&interval=1h&limit=2`).then(x => x.json()).catch(() => null);
    let range1hPct = 1.0;
    if (Array.isArray(r) && r.length) {
        const k = r[r.length - 1];
        const h = parseFloat(k[2]); const l = parseFloat(k[3]);
        range1hPct = l > 0 ? (h - l) / l * 100 : 0;
    }
    let tier;
    if (range1hPct < cfg.adaptiveTierCalmMaxPct) tier = 'CALM';
    else if (range1hPct < cfg.adaptiveTierNormalMaxPct) tier = 'NORMAL';
    else if (range1hPct < cfg.adaptiveTierVolatileMaxPct) tier = 'VOLATILE';
    else tier = 'X_VOLATILE';
    return { tier, range_1h_pct: +range1hPct.toFixed(2) };
}

app.get('/api/pending-buy-analysis', async (req, res) => {
    const sym = (req.query.symbol || '').toUpperCase().trim();
    if (!sym) return res.status(400).json({ error: 'symbol query param required' });
    const binanceSym = sym.includes('/') ? sym.replace('/', '') : sym;
    const ccxtSym = sym.includes('/') ? sym : (sym.endsWith('USDT') ? sym.slice(0, -4) + '/USDT' : sym);

    try {
        // Optional manual override params for replay / what-if. If provided, we
        // skip Redis lookup and use these directly. Useful for ZAMA-style
        // regression testing against historical incidents.
        let signalPrice = req.query.signal_price ? parseFloat(req.query.signal_price) : null;
        let limitPrice  = req.query.limit_price  ? parseFloat(req.query.limit_price)  : null;
        let signalTs    = req.query.signal_ts    ? parseInt(req.query.signal_ts, 10)  : null;
        // 'now' lets us replay historic state — pretend "now" is the cancel time.
        const now = req.query.now ? parseInt(req.query.now, 10) : Date.now();

        let source = 'manual_params';
        let outcomeMeta = null;
        let isLive = false;
        let outcomeDate = null;

        if (!signalPrice || !limitPrice || !signalTs) {
            const found = await findRecentOutcomeForSymbol(binanceSym);
            if (!found) return res.status(404).json({ error: `No OUTCOME record for ${ccxtSym} today or yesterday. Provide signal_price/limit_price/signal_ts as query params for what-if.` });
            const o = found.outcome;
            outcomeDate = found.date;
            const filled = parseInt(o.filled || '0', 10);
            const exited = parseInt(o.exited || '0', 10);
            if (filled === 1) return res.status(400).json({ error: `Order already filled. exit_price=$${o.exit_price}, pnl=$${o.pnl_usdt}` });
            signalPrice = _stripNp(o.signal_price);
            limitPrice  = parseFloat(o.buy_1_limit_price);
            signalTs    = parseInt(o.buy_ts, 10);
            isLive = exited === 0;
            source = isLive ? 'live_pending_outcome' : 'historic_cancelled_outcome';
            outcomeMeta = {
                date: found.date,
                buy_ts: signalTs,
                exit_ts: o.exit_ts ? parseInt(o.exit_ts, 10) : null,
                exit_reason: o.exit_reason || null,
                offset_pct: parseFloat(o.offset_pct || '0'),
                size_usdt: parseFloat(o.size_usdt || '0'),
                origin: o.scalper_origin || null,
            };
        }
        if (!signalPrice || !limitPrice || !signalTs) {
            return res.status(400).json({ error: 'signal_price, limit_price, signal_ts all required (manual mode)' });
        }

        const cfgRaw = await redis.get(CONFIG_KEY);
        const cfg = { ...DEFAULT_TRADING_CONFIG, ...(cfgRaw ? JSON.parse(cfgRaw) : {}) };

        // Fetch 1m klines covering signal → now. Pad +60s on each end.
        const klines = await fetchKlinesRange(binanceSym, signalTs - 60000, now + 60000);
        if (!klines || klines.length === 0) return res.status(502).json({ error: 'klines fetch failed' });

        // Current price = close of last kline whose openTime ≤ now.
        let currentPrice = parseFloat(klines[klines.length - 1][4]);

        // For LIVE mode also fetch the real-time ticker (klines lag a few sec).
        if (isLive) {
            const t = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${binanceSym}`).then(r => r.json()).catch(() => null);
            if (t && t.price) currentPrice = parseFloat(t.price);
        }

        const tierInfo = await classifyTierFromBinance(binanceSym, cfg);
        const analysis = classifyPendingBuy({
            signalPrice, limitPrice, signalTs, klines, currentPrice,
            tier: tierInfo.tier, now,
        });

        // Look up the matching Binance open order id for one-click cancel.
        // The bot only reliably populates BINANCE:OPEN_ORDERS:ALL; per-symbol
        // keys can be empty. Try per-symbol first, fall back to ALL filtered.
        let openOrder = null;
        if (isLive) {
            openOrder = await findOpenBuyLimit(binanceSym);
        }

        res.json({
            symbol: ccxtSym,
            source, is_live: isLive, outcome_date: outcomeDate, outcome: outcomeMeta,
            tier_info: tierInfo,
            analysis,
            open_order: openOrder ? { orderId: openOrder.orderId, price: openOrder.price, qty: openOrder.origQty, time: openOrder.time } : null,
            timestamp: new Date(now).toISOString(),
        });
    } catch (err) {
        res.status(500).json({ error: err.message, stack: err.stack });
    }
});

// List all currently-active pending Buy 1 LIMITs, with analyzer applied to each.
// Sources:
//   1. BINANCE:OPEN_ORDERS:ALL — authoritative live order list
//   2. METRICS:OUTCOME:<date>:<symbol> records where filled=0 AND exited=0
//
// We use the OUTCOME records as the primary source (they have signal_price +
// buy_ts), and enrich with open-order data when available.
app.get('/api/pending-orders', async (req, res) => {
    try {
        const today = new Date().toISOString().slice(0, 10);
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        const cfgRaw = await redis.get(CONFIG_KEY);
        const cfg = { ...DEFAULT_TRADING_CONFIG, ...(cfgRaw ? JSON.parse(cfgRaw) : {}) };

        // Pull all outcome records for both days; keep those that are still pending.
        const orders = [];
        const seen = new Set();
        for (const date of [today, yesterday]) {
            const stream = redis.scanStream({ match: `METRICS:OUTCOME:${date}:*`, count: 100 });
            const keys = [];
            stream.on('data', b => keys.push(...b));
            await new Promise(r => stream.on('end', r));
            for (const k of keys) {
                const o = await redis.hgetall(k);
                if (!o || !o.symbol) continue;
                if (parseInt(o.filled || '0', 10) !== 0) continue;
                if (parseInt(o.exited || '0', 10) !== 0) continue;
                const sym = o.symbol;
                if (seen.has(sym)) continue;
                seen.add(sym);
                orders.push({
                    date,
                    symbol: sym,
                    signal_price: _stripNp(o.signal_price),
                    limit_price: parseFloat(o.buy_1_limit_price),
                    offset_pct: parseFloat(o.offset_pct || '0'),
                    signal_ts: parseInt(o.buy_ts, 10),
                    size_usdt: parseFloat(o.size_usdt || '0'),
                    origin: o.scalper_origin || null,
                });
            }
        }
        if (orders.length === 0) {
            return res.json({ count: 0, orders: [], note: 'No pending Buy 1 LIMIT orders right now.' });
        }
        orders.sort((a, b) => b.signal_ts - a.signal_ts);

        // For each pending order: fetch 1m klines + ticker + run classifier.
        const now = Date.now();
        const enriched = [];
        for (let i = 0; i < orders.length; i += 3) {
            const batch = orders.slice(i, i + 3);
            const br = await Promise.all(batch.map(async (o) => {
                const binanceSym = o.symbol.replace('/', '');
                try {
                    const [klines, tickerJson, tierInfo] = await Promise.all([
                        fetchKlinesRange(binanceSym, o.signal_ts - 60000, now + 60000),
                        fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${binanceSym}`).then(r => r.json()).catch(() => null),
                        classifyTierFromBinance(binanceSym, cfg),
                    ]);
                    const currentPrice = tickerJson && tickerJson.price ? parseFloat(tickerJson.price)
                                       : (klines && klines.length ? parseFloat(klines[klines.length - 1][4]) : o.limit_price);
                    const analysis = classifyPendingBuy({
                        signalPrice: o.signal_price, limitPrice: o.limit_price, signalTs: o.signal_ts,
                        klines: klines || [], currentPrice, tier: tierInfo.tier, now,
                    });
                    // Match to live open order (per-symbol then ALL fallback)
                    const openOrder = await findOpenBuyLimit(binanceSym);
                    return {
                        ...o,
                        tier: tierInfo.tier,
                        analysis,
                        open_order: openOrder ? { orderId: openOrder.orderId, price: openOrder.price, qty: openOrder.origQty } : null,
                    };
                } catch (e) {
                    return { ...o, error: e.message };
                }
            }));
            enriched.push(...br);
        }

        // Summary counts per recommendation
        const counts = {};
        enriched.forEach(o => {
            const a = o.analysis?.action || 'UNKNOWN';
            counts[a] = (counts[a] || 0) + 1;
        });

        res.json({ count: enriched.length, counts, orders: enriched });
    } catch (err) {
        res.status(500).json({ error: err.message, stack: err.stack });
    }
});

// iter 24 fe (2026-05-16): Auto-cancel worker control endpoints.
// User wants the bot to cancel stale pending orders without manual
// intervention. The worker (pending-monitor-worker.js) handles execution;
// these endpoints expose status / toggle / audit log to the dashboard.
app.get('/api/auto-cancel/status', async (req, res) => {
    try {
        const cfgRaw = await redis.get(CONFIG_KEY);
        const cfg = { ...DEFAULT_TRADING_CONFIG, ...(cfgRaw ? JSON.parse(cfgRaw) : {}) };
        const status = await redis.hgetall('PENDING_AUTO_CANCEL:STATUS') || {};
        // Current-hour usage
        const bucket = Math.floor(Date.now() / 3600000);
        const used = parseInt((await redis.get(`PENDING_AUTO_CANCEL:HOUR_BUCKET:${bucket}`)) || '0', 10);
        // Active per-symbol cooldowns
        const cdKeys = await redis.keys('PENDING_AUTO_CANCEL:COOLDOWN:*');
        const cooldowns = await Promise.all(cdKeys.map(async (k) => ({
            symbol: k.replace('PENDING_AUTO_CANCEL:COOLDOWN:', ''),
            ttl_sec: await redis.ttl(k),
        })));
        res.json({
            config: {
                enabled: !!cfg.pendingAutoCancelEnabled,
                paper_mode: cfg.pendingAutoCancelPaperMode ?? true,
                max_per_hour: cfg.pendingAutoCancelMaxPerHour ?? 10,
                cooldown_sec: cfg.pendingAutoCancelCooldownSec ?? 300,
                age_buffer_sec: cfg.pendingAutoCancelAgeBufferSec ?? 60,
            },
            status: {
                last_poll_ts: status.last_poll_ts ? +status.last_poll_ts : null,
                last_run_count: status.last_run_count ? +status.last_run_count : 0,
                last_cancel_count: status.last_cancel_count ? +status.last_cancel_count : 0,
                last_action_ts: status.last_action_ts ? +status.last_action_ts : null,
                last_error: status.last_error || null,
            },
            quota: {
                used_this_hour: used,
                limit_per_hour: cfg.pendingAutoCancelMaxPerHour ?? 10,
            },
            cooldowns,
            whitelist: ['MISSED_BOAT', 'PUMP_AND_DUMP', 'DRIFTED_UP', 'STALE_FLAT', 'DRIFTED_NO_DIP'],
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auto-cancel/toggle', async (req, res) => {
    try {
        const { enabled, paper_mode, max_per_hour, cooldown_sec } = req.body || {};
        const existingRaw = await redis.get(CONFIG_KEY);
        const existing = existingRaw ? JSON.parse(existingRaw) : {};
        const merged = { ...DEFAULT_TRADING_CONFIG, ...existing };
        if (typeof enabled === 'boolean') merged.pendingAutoCancelEnabled = enabled;
        if (typeof paper_mode === 'boolean') merged.pendingAutoCancelPaperMode = paper_mode;
        if (typeof max_per_hour === 'number' && max_per_hour > 0) merged.pendingAutoCancelMaxPerHour = max_per_hour;
        if (typeof cooldown_sec === 'number' && cooldown_sec >= 0) merged.pendingAutoCancelCooldownSec = cooldown_sec;
        await redis.set(CONFIG_KEY, JSON.stringify(merged));
        res.json({
            success: true,
            enabled: merged.pendingAutoCancelEnabled,
            paper_mode: merged.pendingAutoCancelPaperMode,
            max_per_hour: merged.pendingAutoCancelMaxPerHour,
            cooldown_sec: merged.pendingAutoCancelCooldownSec,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/auto-cancel/log', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit || '50', 10);
        const raw = await redis.lrange('PENDING_AUTO_CANCEL:LOG', 0, limit - 1);
        const entries = raw.map(r => { try { return JSON.parse(r); } catch (_) { return null; } }).filter(Boolean);
        // Quick summary
        const today = new Date().toISOString().slice(0, 10);
        const todayEntries = entries.filter(e => new Date(e.ts).toISOString().slice(0, 10) === today);
        const summary = {
            total: entries.length,
            today: todayEntries.length,
            paper: todayEntries.filter(e => e.mode === 'paper').length,
            live: todayEntries.filter(e => e.mode === 'live' && e.outcome === 'cancelled').length,
            failed: todayEntries.filter(e => e.outcome === 'cancel_failed' || e.outcome === 'error').length,
            by_classification: {},
        };
        todayEntries.forEach(e => {
            summary.by_classification[e.classification] = (summary.by_classification[e.classification] || 0) + 1;
        });
        res.json({ summary, entries });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// iter 25 fe (2026-05-16): Cancel-Recovery worker control endpoints.
// Surfaces config / status / quota / cooldowns / audit log for the
// pending-recovery-worker. User journey: turn enabled=true while
// paperMode=true, let it observe RENDER-style cancels for a day, audit the
// "would have recovered" entries, then flip paperMode off to go live.
app.get('/api/recovery/status', async (req, res) => {
    try {
        const cfgRaw = await redis.get(CONFIG_KEY);
        const cfg = { ...DEFAULT_TRADING_CONFIG, ...(cfgRaw ? JSON.parse(cfgRaw) : {}) };
        const status = await redis.hgetall('PENDING_RECOVERY:STATUS') || {};
        const bucket = Math.floor(Date.now() / 3600000);
        const used = parseInt((await redis.get(`PENDING_RECOVERY:HOUR_BUCKET:${bucket}`)) || '0', 10);
        const cdKeys = await redis.keys('PENDING_RECOVERY:COOLDOWN:*');
        const cooldowns = await Promise.all(cdKeys.map(async (k) => ({
            symbol: k.replace('PENDING_RECOVERY:COOLDOWN:', ''),
            ttl_sec: await redis.ttl(k),
        })));
        res.json({
            config: {
                enabled: !!cfg.pendingRecoveryEnabled,
                paper_mode: cfg.pendingRecoveryPaperMode ?? true,
                min_touch_pct: cfg.pendingRecoveryMinTouchPct ?? 0.20,
                max_above_pct: cfg.pendingRecoveryMaxAbovePct ?? 0.30,
                window_sec: cfg.pendingRecoveryWindowSec ?? 300,
                max_per_hour: cfg.pendingRecoveryMaxPerHour ?? 3,
                cooldown_sec: cfg.pendingRecoveryCooldownSec ?? 1800,
            },
            status: {
                last_poll_ts: status.last_poll_ts ? +status.last_poll_ts : null,
                last_candidates: status.last_candidates ? +status.last_candidates : 0,
                last_recover_count: status.last_recover_count ? +status.last_recover_count : 0,
                last_action_ts: status.last_action_ts ? +status.last_action_ts : null,
                last_error: status.last_error || null,
            },
            quota: {
                used_this_hour: used,
                limit_per_hour: cfg.pendingRecoveryMaxPerHour ?? 3,
            },
            cooldowns,
            recoverable_reasons: ['pending_pump_dump_cancel', 'manual_cancel'],
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/recovery/toggle', async (req, res) => {
    try {
        const { enabled, paper_mode, min_touch_pct, max_above_pct, max_per_hour, cooldown_sec } = req.body || {};
        const existingRaw = await redis.get(CONFIG_KEY);
        const existing = existingRaw ? JSON.parse(existingRaw) : {};
        const merged = { ...DEFAULT_TRADING_CONFIG, ...existing };
        if (typeof enabled === 'boolean') merged.pendingRecoveryEnabled = enabled;
        if (typeof paper_mode === 'boolean') merged.pendingRecoveryPaperMode = paper_mode;
        if (typeof min_touch_pct === 'number' && min_touch_pct >= 0) merged.pendingRecoveryMinTouchPct = min_touch_pct;
        if (typeof max_above_pct === 'number' && max_above_pct >= 0) merged.pendingRecoveryMaxAbovePct = max_above_pct;
        if (typeof max_per_hour === 'number' && max_per_hour > 0) merged.pendingRecoveryMaxPerHour = max_per_hour;
        if (typeof cooldown_sec === 'number' && cooldown_sec >= 0) merged.pendingRecoveryCooldownSec = cooldown_sec;
        await redis.set(CONFIG_KEY, JSON.stringify(merged));
        res.json({
            success: true,
            enabled: merged.pendingRecoveryEnabled,
            paper_mode: merged.pendingRecoveryPaperMode,
            min_touch_pct: merged.pendingRecoveryMinTouchPct,
            max_above_pct: merged.pendingRecoveryMaxAbovePct,
            max_per_hour: merged.pendingRecoveryMaxPerHour,
            cooldown_sec: merged.pendingRecoveryCooldownSec,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/recovery/log', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit || '50', 10);
        const raw = await redis.lrange('PENDING_RECOVERY:LOG', 0, limit - 1);
        const entries = raw.map(r => { try { return JSON.parse(r); } catch (_) { return null; } }).filter(Boolean);
        const today = new Date().toISOString().slice(0, 10);
        const todayEntries = entries.filter(e => new Date(e.ts).toISOString().slice(0, 10) === today);
        const summary = {
            total: entries.length,
            today: todayEntries.length,
            paper_recovered: todayEntries.filter(e => e.outcome === 'paper_recovered').length,
            live_recovered: todayEntries.filter(e => e.outcome === 'recovered').length,
            skip_no_near_miss: todayEntries.filter(e => e.outcome === 'skip_no_near_miss').length,
            skip_too_far_above: todayEntries.filter(e => e.outcome === 'skip_too_far_above').length,
            skip_eligibility_red: todayEntries.filter(e => e.outcome === 'skip_eligibility_red').length,
            skip_cooldown: todayEntries.filter(e => e.outcome === 'skip_cooldown').length,
            failed: todayEntries.filter(e => e.outcome === 'recovery_failed' || e.outcome === 'error').length,
        };
        res.json({ summary, entries });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// iter 26 fe (2026-05-16): Active-Position Monitors
//
// User: "i need to see the 9 monitors run on every filled position in the
// UI, so easily i can see it in front end what is happening"
//
// Pulls SCALPER:LADDER_STATES + VIRTUAL:LADDER_STATES, enriches each with
// live price + BTC trend + cfg, then computes the state of every monitor
// the Python scalper runs on a filled position:
//
//   PRE-FILL (state == PENDING_BUY_1):
//     P1  pending pump/dump cancel       (Python bot built-in)
//     P2  limit-buy timeout              (60-min hard ceiling)
//     P3  iter23 classifier verdict      (FE auto-cancel input)
//
//   POST-FILL (state == BUY_1_FILLED / ACTIVE / ACTIVE_2):
//     M1  TP at avg                      (target hit → market sell)
//     M2  Trailing TP                    (peak-trailing tighter exit)
//     M3  Breakeven exit                 (post-profit retrace guard)
//     M4  Time exit                      (max-hold ceiling, 4h default)
//     M5  Hard stop                      (catastrophic price stop)
//     M6  Liquidity death                (volume collapse + lower-lows)
//     M7  Active2 monitor                (post-Buy-2 strict grace + tight stops)
//     M8  Market stress exit             (BTC weakness + vol spike)
//     M9  Buy 2 staleness                (cancel Buy 2 if stale)

async function fetchBtcTrend(lookbackMin) {
    // Pulls last lookbackMin × 1m BTC klines, returns drift% from first open
    // to last close. Used by iter46 market-stress monitor.
    try {
        const limit = Math.max(2, Math.min(lookbackMin + 2, 120));
        const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=${limit}`);
        if (!r.ok) return null;
        const ks = await r.json();
        if (!Array.isArray(ks) || ks.length < 2) return null;
        const firstOpen = parseFloat(ks[0][1]);
        const lastClose = parseFloat(ks[ks.length - 1][4]);
        if (firstOpen <= 0) return null;
        return {
            drift_pct: +((lastClose / firstOpen - 1) * 100).toFixed(3),
            last_price: lastClose,
            window_min: ks.length,
        };
    } catch (_) { return null; }
}

function computeMonitorStates({ ladder, cfg, currentPrice, btcTrend, klinesRecent, now }) {
    const out = { phase: 'unknown', monitors: [] };
    const state = ladder.state || 'UNKNOWN';
    const symbol = ladder.symbol;
    const signalPrice = ladder.signal_price || 0;
    const signalTs = ladder.signal_ts || 0;
    const ageMin = signalTs ? (now - signalTs) / 60000 : 0;
    const tier = ladder.dyn_strategy || 'NORMAL';

    // ── Compute filled-position core values ──
    const fills = [];
    for (const leg of ['buy_1', 'buy_2', 'buy_3']) {
        const b = ladder[leg];
        if (b && b.status === 'filled' && b.fill_price > 0 && b.qty_filled > 0) {
            fills.push({ label: leg, price: b.fill_price, qty: b.qty_filled, ts: b.fill_ts || 0 });
        }
    }
    const totalQty = fills.reduce((s, f) => s + f.qty, 0);
    const totalCost = fills.reduce((s, f) => s + f.price * f.qty, 0);
    const avgBuyPrice = totalQty > 0 ? totalCost / totalQty : 0;
    const sizeUsdt = totalQty * (avgBuyPrice || 1);

    // Buy 1 fill time for hold-time calculations
    const buy1Fill = fills.find(f => f.label === 'buy_1');
    const firstFillTs = buy1Fill ? buy1Fill.ts : 0;
    const holdMs = firstFillTs ? now - firstFillTs : 0;
    const holdMin = holdMs / 60000;

    // Unrealized P&L (rough — fees not yet subtracted)
    const FEE_PER_SIDE = cfg.ladderFeeRatePerSide ?? 0.00075;
    const grossPnl = avgBuyPrice > 0 ? (currentPrice - avgBuyPrice) * totalQty : 0;
    const fees = 2 * FEE_PER_SIDE * sizeUsdt;
    const netPnl = grossPnl - fees;
    const pnlPct = avgBuyPrice > 0 ? (currentPrice / avgBuyPrice - 1) * 100 : 0;

    out.summary = {
        symbol, tier, state,
        signal_price: signalPrice,
        signal_ts: signalTs,
        age_min: +ageMin.toFixed(1),
        avg_buy_price: +avgBuyPrice.toFixed(10),
        total_qty: +totalQty.toFixed(8),
        size_usdt: +sizeUsdt.toFixed(2),
        current_price: +currentPrice.toFixed(10),
        unrealized_gross_pnl: +grossPnl.toFixed(4),
        unrealized_net_pnl: +netPnl.toFixed(4),
        unrealized_pnl_pct: +pnlPct.toFixed(3),
        hold_min: +holdMin.toFixed(1),
        fills,
        peak_since_signal: ladder.peak_since_signal || signalPrice,
        peak_since_tp: ladder.peak_since_tp || 0,
        trailing_active: !!ladder.trailing_active,
        recovered_to_break_even: !!ladder.recovered_to_break_even,
        below_avg_started_ts: ladder.below_avg_started_ts || 0,
        total_underwater_ms: ladder.total_underwater_ms || 0,
    };

    // Phase
    const filledCount = fills.length;
    if (state === 'PENDING_BUY_1') out.phase = 'pending_buy_1';
    else if (state === 'BUY_1_FILLED' || filledCount === 1) out.phase = 'buy_1_filled';
    else if (state === 'ACTIVE_2' || filledCount === 2) out.phase = 'active_2';
    else if (state === 'ACTIVE' || filledCount >= 2) out.phase = 'active';
    else out.phase = state.toLowerCase();

    const mk = (id, name, iter, state_, badge, key_metric, detail) => {
        out.monitors.push({ id, name, iter, state: state_, badge, key_metric, detail });
    };

    // ── PRE-FILL phase ──
    if (out.phase === 'pending_buy_1') {
        const buy1 = ladder.buy_1 || {};
        const limitPrice = buy1.target_price || 0;
        const peak = ladder.peak_since_signal || signalPrice;

        // P1: pending pump/dump cancel (Python bot built-in)
        const pumpPct = signalPrice > 0 ? (currentPrice - signalPrice) / signalPrice * 100 : 0;
        const dumpFromPeakPct = peak > 0 ? (peak - currentPrice) / peak * 100 : 0;
        const pumpTh = cfg.pendingPumpThresholdPct ?? 0.5;
        const dumpTh = cfg.pendingDumpFromPeakPct ?? 0.5;
        const minAge = (cfg.pendingMinAgeSeconds ?? 60) / 60;
        const pumpHit = pumpPct >= pumpTh;
        const dumpHit = dumpFromPeakPct >= dumpTh;
        const ageOk = ageMin >= minAge;
        const wouldFire = ageOk && (pumpHit || dumpHit);
        mk('p1_pending_pump_dump',
           'Pending pump/dump cancel',
           'bot',
           wouldFire ? 'WOULD_FIRE' : (ageOk ? 'ARMED' : 'WARMING'),
           wouldFire ? (dumpHit ? 'DUMP TRIGGER' : 'PUMP TRIGGER') : 'OK',
           `pump ${pumpPct.toFixed(2)}% (≥${pumpTh}%) / dump from peak ${dumpFromPeakPct.toFixed(2)}% (≥${dumpTh}%)`,
           `Python scalper cancels the limit if either threshold crosses. Age ${ageMin.toFixed(0)}m of ${minAge.toFixed(0)}m warmup.`);

        // P2: limit-buy timeout
        const timeoutMin = (cfg.limitBuyTimeoutSec ?? 3600) / 60;
        const remaining = Math.max(0, timeoutMin - ageMin);
        mk('p2_limit_timeout',
           'Limit-buy timeout',
           'bot',
           remaining <= 0 ? 'EXPIRED' : (remaining < 5 ? 'NEAR_EXPIRY' : 'COUNTING'),
           remaining <= 0 ? 'EXPIRED' : `${remaining.toFixed(0)}m left`,
           `age ${ageMin.toFixed(0)}m / max ${timeoutMin.toFixed(0)}m`,
           'Hard 60-min ceiling — if Buy 1 doesn’t fill, Python bot cancels.');

        // P3: iter23 classifier — caller can fetch separately, here we just stub
        mk('p3_iter23_classifier',
           'iter23 classifier verdict',
           'fe-23',
           'EXTERNAL',
           '(see /api/pending-buy-analysis)',
           'fetched on dashboard',
           'Live RIDE/CANCEL/REPRICE label that feeds iter24 auto-cancel.');

        return out;
    }

    // ── POST-FILL phase ──
    // M1: TP at avg
    const targetNet = ladder.dyn_tp_target_usdt ?? cfg.ladderTargetNetProfitUsdt ?? 0.15;
    const tpPct = sizeUsdt > 0 ? (targetNet / sizeUsdt) * 100 + 2 * FEE_PER_SIDE * 100 : 0;
    const tpPrice = ladder.tp_target_price || (avgBuyPrice > 0 ? avgBuyPrice * (1 + tpPct / 100) : 0);
    const distToTpPct = tpPrice > 0 ? (tpPrice - currentPrice) / tpPrice * 100 : 0;
    const tpProgress = tpPrice > avgBuyPrice ? Math.max(0, Math.min(100, (currentPrice - avgBuyPrice) / (tpPrice - avgBuyPrice) * 100)) : 0;
    mk('m1_tp_at_avg',
       'Take-profit at average',
       'iter14',
       distToTpPct <= 0 ? 'TRIGGERED' : (tpProgress >= 80 ? 'CLOSE' : 'ARMED'),
       distToTpPct <= 0 ? 'TP HIT' : `${distToTpPct.toFixed(2)}% away`,
       `target $${tpPrice.toFixed(8)}  (need +$${targetNet.toFixed(2)} net = +${tpPct.toFixed(3)}%)  progress ${tpProgress.toFixed(0)}%`,
       'Closes the position at market when current price ≥ target.');

    // M2: Trailing TP
    const trailingEnabled = !!(cfg.ladderTrailingTpEnabled ?? true);
    const trailingPct = cfg.ladderTrailingTpPct ?? 0.5;
    const peakSinceTp = ladder.peak_since_tp || 0;
    const trailingArmed = !!ladder.trailing_active;
    const trailingStop = peakSinceTp > 0 ? peakSinceTp * (1 - trailingPct / 100) : 0;
    const trailingDistPct = trailingStop > 0 ? (currentPrice - trailingStop) / trailingStop * 100 : 0;
    mk('m2_trailing_tp',
       'Trailing take-profit',
       'iter14',
       !trailingEnabled ? 'DISABLED'
         : trailingArmed
           ? (trailingDistPct <= 0 ? 'TRIGGERED' : 'TRACKING')
           : 'STANDBY',
       trailingArmed
         ? (trailingDistPct <= 0 ? 'TRAIL HIT' : `${trailingDistPct.toFixed(2)}% above trail`)
         : 'waiting for TP threshold',
       `arm: price hits TP; then trails ${trailingPct}% below peak ($${peakSinceTp.toFixed(8)} → stop $${trailingStop.toFixed(8)})`,
       'Once price reaches TP, switches to trailing mode. Locks gains as price climbs.');

    // M3: Breakeven exit
    const beEnabled = !!(cfg.ladderBreakevenExitEnabled ?? true);
    const beBufferPct = cfg.ladderBreakevenBufferPct ?? 0.5;
    const recovered = !!ladder.recovered_to_break_even;
    const bePrice = avgBuyPrice > 0 ? avgBuyPrice * (1 + beBufferPct / 100) : 0;
    const beDistPct = bePrice > 0 ? (currentPrice - bePrice) / bePrice * 100 : 0;
    mk('m3_breakeven_exit',
       'Breakeven exit',
       'iter14',
       !beEnabled ? 'DISABLED'
         : recovered
           ? (beDistPct < 0 ? 'TRIGGERED' : 'ARMED')
           : 'STANDBY',
       recovered
         ? (beDistPct < 0 ? 'BE HIT' : `${beDistPct.toFixed(2)}% above BE`)
         : 'waiting for profit',
       `arm: price > avg + ${beBufferPct}%; then sell if price retraces back to $${bePrice.toFixed(8)}`,
       'After being profitable, exits if price retraces back through breakeven + buffer.');

    // M4: Time exit
    const teEnabled = !!(cfg.ladderTimeExitEnabled ?? true);
    const maxHoldSec = cfg.ladderMaxHoldSeconds ?? 14400;
    const maxHoldMin = maxHoldSec / 60;
    const remainingMin = Math.max(0, maxHoldMin - holdMin);
    mk('m4_time_exit',
       'Time exit',
       'iter14',
       !teEnabled ? 'DISABLED'
         : remainingMin <= 0 ? 'TRIGGERED'
         : remainingMin < 30 ? 'CLOSE'
         : 'COUNTING',
       remainingMin <= 0 ? 'EXPIRED' : `${(remainingMin/60).toFixed(1)}h left`,
       `held ${holdMin.toFixed(0)}m / max ${maxHoldMin.toFixed(0)}m (${(maxHoldMin/60).toFixed(0)}h)`,
       'Closes at market if hold time exceeds max. Default 4h.');

    // M5: Hard stop
    const hsEnabled = !!(cfg.ladderHardStopFromAvgEnabled ?? true);
    const hsPct = cfg.ladderHardStopFromAvgPct ?? 1.5;
    const hsPrice = ladder.hard_stop_price || (avgBuyPrice > 0 ? avgBuyPrice * (1 - hsPct / 100) : 0);
    const hsDistPct = hsPrice > 0 ? (currentPrice - hsPrice) / hsPrice * 100 : 0;
    mk('m5_hard_stop',
       'Hard stop',
       'iter37',
       !hsEnabled ? 'DISABLED'
         : hsDistPct <= 0 ? 'TRIGGERED'
         : hsDistPct < 0.30 ? 'DANGER'
         : 'ARMED',
       hsDistPct <= 0 ? 'STOP HIT' : `${hsDistPct.toFixed(2)}% above stop`,
       `stop $${hsPrice.toFixed(8)} = avg − ${hsPct}%`,
       'Catastrophic stop. Closes at market if price ≤ avg × (1 − 1.5%).');

    // M6: Liquidity death — partial: we score recent kline behaviour
    let m6_state = cfg.liquidityDeathExitEnabled ? 'ARMED' : 'DISABLED';
    let m6_badge = 'OK', m6_detail = '5-factor score evaluated by Python bot every tick';
    if (klinesRecent && klinesRecent.length >= 5 && cfg.liquidityDeathExitEnabled) {
        const lookback = klinesRecent.slice(-Math.min(klinesRecent.length, cfg.liquidityDeathLookbackMin ?? 10));
        const lows = lookback.map(k => parseFloat(k[3]));
        const closes = lookback.map(k => parseFloat(k[4]));
        const opens = lookback.map(k => parseFloat(k[1]));
        const vols = lookback.map(k => parseFloat(k[7] || 0));
        // lower-lows share
        let llCount = 0;
        for (let i = 1; i < lows.length; i++) if (lows[i] < lows[i-1]) llCount++;
        const llShare = (lookback.length - 1) > 0 ? llCount / (lookback.length - 1) : 0;
        // red-share
        const redCount = closes.reduce((s, c, i) => s + (c < opens[i] ? 1 : 0), 0);
        const redShare = redCount / lookback.length;
        // vol collapse vs pre_vol_baseline
        const baseline = ladder.pre_vol_baseline_usdt || 1;
        const recentAvgVol = vols.reduce((a, b) => a + b, 0) / vols.length;
        const volRatio = baseline > 0 ? recentAvgVol / baseline : 1;
        // drop from avg
        const dropFromAvgPct = avgBuyPrice > 0 ? (avgBuyPrice - currentPrice) / avgBuyPrice * 100 : 0;
        // catastrophic immediate
        const catastrophic = dropFromAvgPct >= (cfg.liquidityDeathCatastrophicDropPct ?? 2.5);
        // stagnation
        const stagnation = holdMin >= (cfg.liquidityDeathStagnationHoldMin ?? 60) &&
                           dropFromAvgPct >= 0 &&
                           dropFromAvgPct <= (cfg.liquidityDeathStagnationMaxDropPct ?? 1);
        // composite score (mirrors Python heuristic — approximate)
        let score = 0;
        if (llShare >= (cfg.liquidityDeathLowerLowsThreshold ?? 0.55)) score += 2;
        if (redShare >= (cfg.liquidityDeathRedShareThreshold ?? 0.6)) score += 2;
        if (volRatio <= (cfg.liquidityDeathVolCollapseThreshold ?? 0.7)) score += 2;
        if (dropFromAvgPct >= (cfg.liquidityDeathMinDropPct ?? 0.3) && holdMin >= (cfg.liquidityDeathMinHoldMin ?? 10)) score += 2;
        const threshold = cfg.liquidityDeathExitScoreThreshold ?? 6;
        const fires = catastrophic || stagnation || score >= threshold;
        if (fires) m6_state = 'WOULD_FIRE';
        m6_badge = fires ? (catastrophic ? 'CATASTROPHIC' : (stagnation ? 'STAGNATION' : `SCORE ${score}/${threshold}`)) : `score ${score}/${threshold}`;
        m6_detail = `drop ${dropFromAvgPct.toFixed(2)}% / LL share ${(llShare*100).toFixed(0)}% / red share ${(redShare*100).toFixed(0)}% / vol ratio ${volRatio.toFixed(2)}× / hold ${holdMin.toFixed(0)}m`;
    }
    mk('m6_liquidity_death', 'Liquidity-death exit', 'iter39', m6_state, m6_badge, m6_detail,
       'Multi-factor catastrophic exit: drop% + lower-lows + red candles + vol collapse. Score ≥6/8 fires.');

    // M7: Active2 monitor
    const active2On = !!cfg.active2MonitorEnabled;
    const isActive2 = out.phase === 'active_2' || fills.length >= 2;
    if (!active2On) {
        mk('m7_active2', 'Active2 monitor', 'iter41', 'DISABLED', 'OFF', 'feature disabled', 'Post-Buy-2 grace + tight breakeven monitor.');
    } else if (!isActive2) {
        mk('m7_active2', 'Active2 monitor', 'iter41', 'IDLE', 'waiting Buy 2', 'only activates after Buy 2 fills', 'Becomes active once both Buy 1 and Buy 2 are filled.');
    } else {
        const a2GraceMin = cfg.active2GracePeriodMinutes ?? 5;
        const a2QuickProfit = cfg.active2QuickProfitPct ?? 0.2;
        const a2TightBuf = cfg.active2TightBreakevenBufferPct ?? 0.15;
        const a2NoRecov = cfg.active2NoRecoveryDropPct ?? 0.5;
        const a2HardStop = cfg.active2HardStopPct ?? 1.5;
        const buy2 = fills.find(f => f.label === 'buy_2');
        const buy2HoldMin = buy2 ? (now - buy2.ts) / 60000 : 0;
        const inGrace = buy2HoldMin < a2GraceMin;
        const profitPct = (currentPrice / avgBuyPrice - 1) * 100;
        const quickProfitHit = profitPct >= a2QuickProfit;
        const beAtPrice = avgBuyPrice * (1 + a2TightBuf / 100);
        const beHit = currentPrice >= beAtPrice;
        const a2StopPrice = avgBuyPrice * (1 - a2HardStop / 100);
        const stopHit = currentPrice <= a2StopPrice;
        const wouldFire = !inGrace && (quickProfitHit || beHit || stopHit);
        mk('m7_active2', 'Active2 monitor', 'iter41',
           wouldFire ? 'WOULD_FIRE' : (inGrace ? 'GRACE' : 'TRACKING'),
           wouldFire
             ? (stopHit ? 'A2 STOP' : quickProfitHit ? 'QUICK PROFIT' : 'TIGHT BE')
             : inGrace ? `${(a2GraceMin - buy2HoldMin).toFixed(0)}m grace left` : `+${profitPct.toFixed(2)}%`,
           `quick-profit +${a2QuickProfit}% / tight-BE +${a2TightBuf}% / hard stop −${a2HardStop}%`,
           `Only fires post-Buy-2 + grace ${a2GraceMin}m. Tighter exits to reduce DCA-then-bleed losses.`);
    }

    // M8: Market stress (iter46)
    const msOn = !!cfg.marketStressExitEnabled;
    const msMinHold = cfg.marketStressMinHoldMin ?? 30;
    const msMinDrop = cfg.marketStressMinDropPct ?? 1;
    const msBtcWeak = cfg.marketStressBtcWeaknessPct ?? 0.5;
    let m8_state = 'DISABLED', m8_badge = 'OFF', m8_detail = 'feature disabled';
    if (msOn) {
        const btcDrift = btcTrend ? btcTrend.drift_pct : null;
        const positionDropPct = (avgBuyPrice - currentPrice) / avgBuyPrice * 100;
        const holdOk = holdMin >= msMinHold;
        const btcWeak = btcDrift !== null && btcDrift <= -msBtcWeak;
        const positionDown = positionDropPct >= msMinDrop;
        const wouldFire = holdOk && btcWeak && positionDown;
        m8_state = wouldFire ? 'WOULD_FIRE' : holdOk ? 'TRACKING' : 'WARMING';
        m8_badge = wouldFire ? 'STRESS EXIT' :
                   btcDrift === null ? 'NO BTC DATA' :
                   `BTC ${btcDrift >= 0 ? '+' : ''}${btcDrift}%`;
        m8_detail = `BTC ${(cfg.marketStressBtcLookbackMin || 30)}m drift ${btcDrift === null ? '?' : btcDrift + '%'} (need ≤ −${msBtcWeak}%) / position −${positionDropPct.toFixed(2)}% (need ≥ ${msMinDrop}%) / hold ${holdMin.toFixed(0)}m (need ≥ ${msMinHold}m)`;
    }
    mk('m8_market_stress', 'Market stress exit', 'iter46', m8_state, m8_badge, m8_detail,
       'Exits if BTC weakens AND position drops AND we’ve held long enough.');

    // M9: Buy 2 staleness
    const b2Enabled = !!(cfg.ladderBuy2StalenessEnabled ?? true);
    const b2StaleMin = cfg.ladderBuy2StalenessMinutes ?? 10;
    const hasBuy2Filled = fills.find(f => f.label === 'buy_2');
    const buy2Order = ladder.buy_2;
    const buy2Pending = !!buy2Order && buy2Order.status === 'pending';
    if (!b2Enabled) {
        mk('m9_buy2_stale', 'Buy 2 staleness', 'iter37', 'DISABLED', 'OFF', 'feature disabled', 'Cancels Buy 2 LIMIT if it hasn’t filled within N minutes of Buy 1.');
    } else if (!buy2Pending) {
        const status = hasBuy2Filled ? 'Buy 2 filled' : 'no Buy 2';
        mk('m9_buy2_stale', 'Buy 2 staleness', 'iter37', 'IDLE', status, 'no pending Buy 2', 'Only relevant while Buy 2 is pending.');
    } else {
        const sinceBuy1 = buy1Fill ? (now - buy1Fill.ts) / 60000 : 0;
        const wouldFire = sinceBuy1 >= b2StaleMin;
        mk('m9_buy2_stale', 'Buy 2 staleness', 'iter37',
           wouldFire ? 'WOULD_FIRE' : 'COUNTING',
           wouldFire ? 'STALE' : `${(b2StaleMin - sinceBuy1).toFixed(0)}m left`,
           `Buy 2 pending ${sinceBuy1.toFixed(0)}m of ${b2StaleMin}m limit`,
           'Cancels Buy 2 if it sits unfilled too long after Buy 1 fills.');
    }

    return out;
}

app.get('/api/active-positions', async (req, res) => {
    try {
        const cfgRaw = await redis.get(CONFIG_KEY);
        const cfg = { ...DEFAULT_TRADING_CONFIG, ...(cfgRaw ? JSON.parse(cfgRaw) : {}) };
        const [fastRaw, virtualRaw] = await Promise.all([
            redis.hgetall('SCALPER:LADDER_STATES'),
            redis.hgetall('VIRTUAL:LADDER_STATES'),
        ]);
        const parseLadders = (raw, origin) => Object.entries(raw || {}).map(([sym, v]) => {
            try { const obj = JSON.parse(v); obj.__origin = origin; return obj; } catch (_) { return null; }
        }).filter(Boolean);
        const ladders = [
            ...parseLadders(fastRaw, 'FAST'),
            ...parseLadders(virtualRaw, 'VIRTUAL'),
        ].filter(l => l.state && l.state !== 'CLOSED');

        // Fetch BTC trend once (used by iter46 for all positions)
        const btcTrend = await fetchBtcTrend(cfg.marketStressBtcLookbackMin || 30);

        const now = Date.now();
        const out = [];
        for (let i = 0; i < ladders.length; i += 3) {
            const batch = ladders.slice(i, i + 3);
            const br = await Promise.all(batch.map(async (l) => {
                const binanceSym = (l.symbol || '').replace('/', '');
                try {
                    const [tickerJson, klines] = await Promise.all([
                        fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${binanceSym}`).then(r => r.json()).catch(() => null),
                        fetch(`https://api.binance.com/api/v3/klines?symbol=${binanceSym}&interval=1m&limit=15`).then(r => r.json()).catch(() => null),
                    ]);
                    const currentPrice = tickerJson && tickerJson.price ? parseFloat(tickerJson.price) : (l.signal_price || 0);
                    const mon = computeMonitorStates({
                        ladder: l, cfg, currentPrice,
                        btcTrend, klinesRecent: Array.isArray(klines) ? klines : [],
                        now,
                    });
                    mon.origin = l.__origin;
                    return mon;
                } catch (e) {
                    return { error: e.message, summary: { symbol: l.symbol, state: l.state }, origin: l.__origin };
                }
            }));
            out.push(...br);
        }
        // Sort: pending first (urgent), then by hold time desc
        out.sort((a, b) => {
            const phaseRank = { pending_buy_1: 0, buy_1_filled: 1, active: 2, active_2: 3 };
            const ra = phaseRank[a.phase] ?? 9;
            const rb = phaseRank[b.phase] ?? 9;
            if (ra !== rb) return ra - rb;
            return (b.summary?.hold_min || 0) - (a.summary?.hold_min || 0);
        });

        res.json({
            ts: now,
            count: out.length,
            btc_trend: btcTrend,
            positions: out,
        });
    } catch (err) {
        res.status(500).json({ error: err.message, stack: err.stack });
    }
});

// iter 29 fe (2026-05-16): Scalper Health Monitor
//
// User: "kindly check why virtual scalper is not buying any coin"
//
// Diagnosis: Virtual Scalper container is up + heartbeating, but the buy
// pipeline has been dead for hours. Frontend can't fix the Python issue,
// but it can surface the broken state immediately so the operator sees it.
//
// Health = freshness of activity per scalper:
//   - Active positions count (from ladder state hashes)
//   - Today's outcomes (filled + unfilled, by scalper_origin)
//   - Time since last outcome (in minutes — if > 6h, alert)
//   - Container heartbeat inferred via "is there any state at all?"
async function gatherScalperOutcomes(date) {
    const stream = redis.scanStream({ match: `METRICS:OUTCOME:${date}:*`, count: 100 });
    const keys = [];
    stream.on('data', (b) => keys.push(...b));
    await new Promise(r => stream.on('end', r));
    const byOrigin = { FAST: [], VIRTUAL: [] };
    for (const k of keys) {
        const o = await redis.hgetall(k);
        if (!o || !o.symbol) continue;
        const origin = (o.scalper_origin || '').toUpperCase();
        if (!byOrigin[origin]) continue;
        byOrigin[origin].push({
            symbol: o.symbol,
            buy_ts: parseInt(o.buy_ts || '0', 10),
            exit_ts: parseInt(o.exit_ts || '0', 10),
            filled: parseInt(o.filled || '0', 10),
            exited: parseInt(o.exited || '0', 10),
            tp_hit: parseInt(o.tp_hit || '0', 10),
            pnl: parseFloat(o.pnl_usdt || '0'),
            exit_reason: o.exit_reason || null,
        });
    }
    return byOrigin;
}

function summariseScalper(outcomes, activePositions) {
    const fills = outcomes.filter(o => o.filled === 1);
    const wins = fills.filter(o => o.tp_hit === 1);
    const losses = fills.filter(o => o.exit_reason === 'stop_loss' || o.exit_reason === 'hard_stop');
    const cancels = outcomes.filter(o => o.filled === 0 && o.exited === 1);
    const pnl = fills.reduce((s, o) => s + (o.pnl || 0), 0);
    const lastBuy = outcomes.reduce((m, o) => Math.max(m, o.buy_ts || 0), 0);
    const lastExit = outcomes.reduce((m, o) => Math.max(m, o.exit_ts || 0), 0);
    const lastTs = Math.max(lastBuy, lastExit);
    return {
        active_positions: activePositions,
        today_total_outcomes: outcomes.length,
        today_fills: fills.length,
        today_wins: wins.length,
        today_losses: losses.length,
        today_cancels: cancels.length,
        today_total_pnl_usdt: +pnl.toFixed(4),
        last_activity_ts: lastTs || null,
        last_activity_age_min: lastTs ? Math.round((Date.now() - lastTs) / 60000) : null,
    };
}

app.get('/api/scalper-health', async (req, res) => {
    try {
        const today = new Date().toISOString().slice(0, 10);
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

        // Today's outcomes per scalper
        const todayOutcomes = await gatherScalperOutcomes(today);
        // Yesterday's last activity (fallback for "long quiet day")
        const yesterdayOutcomes = await gatherScalperOutcomes(yesterday);

        // Active ladders per scalper
        const [fastLadders, virtualLadders] = await Promise.all([
            redis.hgetall('SCALPER:LADDER_STATES'),
            redis.hgetall('VIRTUAL:LADDER_STATES'),
        ]);
        const fastActive = Object.keys(fastLadders || {}).length;
        const virtualActive = Object.keys(virtualLadders || {}).length;

        const fastSummary = summariseScalper(todayOutcomes.FAST, fastActive);
        const virtualSummary = summariseScalper(todayOutcomes.VIRTUAL, virtualActive);

        // For Virtual: if no activity today, find last yesterday activity
        if (!virtualSummary.last_activity_ts && yesterdayOutcomes.VIRTUAL.length > 0) {
            const lastY = yesterdayOutcomes.VIRTUAL.reduce((m, o) =>
                Math.max(m, o.buy_ts || 0, o.exit_ts || 0), 0);
            virtualSummary.last_activity_ts = lastY || null;
            virtualSummary.last_activity_age_min = lastY ? Math.round((Date.now() - lastY) / 60000) : null;
        }
        if (!fastSummary.last_activity_ts && yesterdayOutcomes.FAST.length > 0) {
            const lastY = yesterdayOutcomes.FAST.reduce((m, o) =>
                Math.max(m, o.buy_ts || 0, o.exit_ts || 0), 0);
            fastSummary.last_activity_ts = lastY || null;
            fastSummary.last_activity_age_min = lastY ? Math.round((Date.now() - lastY) / 60000) : null;
        }

        // Alert logic per scalper
        // Critical: no outcomes in 6+ hours (360 min) AND there ARE signals today
        const signalsTodayCount = await redis.llen(`METRICS:SIGNAL:${today}`).catch(() => 0);
        const annotate = (s, name) => {
            const alerts = [];
            if (signalsTodayCount > 0 && s.today_total_outcomes === 0) {
                alerts.push({
                    level: 'critical',
                    code: 'no_outcomes_with_signals',
                    text: `${signalsTodayCount} signals fired today but ${name} has 0 outcomes — buy pipeline broken`,
                });
            }
            if (s.last_activity_age_min !== null && s.last_activity_age_min > 360) {
                alerts.push({
                    level: 'warn',
                    code: 'stale_activity',
                    text: `Last activity ${(s.last_activity_age_min/60).toFixed(1)}h ago`,
                });
            }
            if (s.last_activity_age_min === null) {
                alerts.push({
                    level: 'critical',
                    code: 'never_active',
                    text: 'No activity in any window — scalper may be dead',
                });
            }
            // Health score: 0-100
            let score = 100;
            if (alerts.some(a => a.level === 'critical')) score = 20;
            else if (alerts.some(a => a.level === 'warn')) score = 60;
            return { ...s, alerts, health_score: score };
        };

        // Pattern Bot data
        const patternCfg = JSON.parse((await redis.get(CONFIG_KEY)) || '{}');
        const patternStatus = await redis.hgetall('PATTERN_BOT:STATUS') || {};
        const patternOpenRaw = await redis.hgetall('PATTERN_BOT:OPEN') || {};
        const patternActive = Object.keys(patternOpenRaw).length;
        const patternBot = {
            enabled: !!patternCfg.patternBotEnabled,
            paper_mode: !!patternCfg.patternBotPaperMode,
            active_positions: patternActive,
            last_poll_ts: patternStatus.last_poll_ts ? +patternStatus.last_poll_ts : null,
            last_poll_age_min: patternStatus.last_poll_ts ? Math.round((Date.now() - +patternStatus.last_poll_ts) / 60000) : null,
            last_executed: patternStatus.last_executed ? +patternStatus.last_executed : 0,
        };

        // iter30 fix: surface the REAL bug source — supervisor crashes
        // captured by the host log-tailer script. These count occurrences
        // of "supervisor stopped" in last 24h, which is the ACTUAL reason
        // Virtual Scalper never completes a buy cycle.
        const [supCrashes24h, vsRestarts24h] = await Promise.all([
            redis.get('VIRTUAL:SUPERVISOR_CRASHES_24H').catch(() => null),
            redis.get('VIRTUAL:RESTARTS_24H').catch(() => null),
        ]);
        const lastRestartTs = parseInt((await redis.get('VIRTUAL:LAST_RESTART_TS').catch(() => null)) || '0', 10);
        const supCrashesN = parseInt(supCrashes24h || '0', 10);

        // Apply annotate first so we have base alerts, then append supervisor
        // root-cause alert. Must mutate AFTER annotate returns the new object.
        const fastAnnotated = annotate(fastSummary, 'Fast Scalper');
        const virtualAnnotated = annotate(virtualSummary, 'Virtual Scalper');
        if (supCrashesN >= 3) {
            virtualAnnotated.alerts = virtualAnnotated.alerts || [];
            virtualAnnotated.alerts.unshift({
                level: 'critical',
                code: 'supervisor_unstable',
                text: `🚨 ROOT CAUSE: Python supervisor crashed ${supCrashesN}× in 24h (supervisor.py:236 — UnboundLocalError on 'rc'). Kills Virtual Scalper mid-buy every ~3 min.`,
            });
            virtualAnnotated.health_score = 10;
        }

        res.json({
            ts: Date.now(),
            date: today,
            signals_today: signalsTodayCount,
            fast_scalper: fastAnnotated,
            virtual_scalper: virtualAnnotated,
            pattern_bot: patternBot,
            supervisor: {
                crashes_24h: parseInt(supCrashes24h || '0', 10),
                virtual_scalper_restarts_24h: parseInt(vsRestarts24h || '0', 10),
                last_backend_restart_ts: lastRestartTs || null,
                last_backend_restart_age_min: lastRestartTs ? Math.round((Date.now()/1000 - lastRestartTs) / 60) : null,
                root_cause: parseInt(supCrashes24h || '0', 10) >= 3
                    ? 'Python bug: supervisor.py line 236 — UnboundLocalError: cannot access local variable \'rc\' before assignment. Cascades errors across all 12 tasks, supervisor self-stops + restarts, killing Virtual Scalper mid-buy-cycle every ~3 min.'
                    : null,
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message, stack: err.stack });
    }
});

// iter 30 fe (2026-05-16): Virtual Scalper diagnostics + safe restart
//
// User: "kindly add proper logs for easy trace the virtual scalper down …
// we need avoid 4 hours restart, we can hold 4 hours restart as of now,
// we will find the exact fix"
//
// Host scripts in ~/booknow-cron/ feed:
//   • VIRTUAL:LOG_TAIL          last 200 non-heartbeat Virtual log lines
//   • VIRTUAL:RESTART_HISTORY   last 50 smart-restart decisions
//   • VIRTUAL:LAST_RESTART_TS   epoch of last successful restart (cooldown)
//
// These endpoints surface them + add JSON-validation/purge for the
// suspect signal-source hashes (FAST_MOVE, RW_BASE_PRICE, BASE_CURRENT_INC_%).

app.get('/api/scalper-logs', async (req, res) => {
    try {
        const scalper = (req.query.scalper || 'virtual').toLowerCase();
        const limit = Math.min(parseInt(req.query.limit || '100', 10), 200);
        const key = scalper === 'virtual' ? 'VIRTUAL:LOG_TAIL'
                  : scalper === 'fast'    ? 'FAST:LOG_TAIL'
                  : null;
        if (!key) return res.status(400).json({ error: 'scalper must be virtual or fast' });
        const lines = await redis.lrange(key, 0, limit - 1);
        // Quick categorisation
        const tracebacks = lines.filter(l => /Traceback|Error|Exception/i.test(l)).length;
        const skips = lines.filter(l => /skipped by filter|🔪/i.test(l)).length;

        // iter30 v4 (2026-05-16): per-line age + freshness summary
        // Parse "HH:MM:SS" prefix on each line, compute age assuming UTC today.
        const now = new Date();
        const nowSecOfDay = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
        const enrichedLines = lines.map((l, i) => {
            const m = l.match(/^(\d{2}):(\d{2}):(\d{2})/) || l.match(/(\d{2}):(\d{2}):(\d{2})/);
            let ageSec = null;
            if (m) {
                const lineSecOfDay = +m[1] * 3600 + +m[2] * 60 + +m[3];
                // If line time > now, it's likely from yesterday (clock wraparound)
                ageSec = lineSecOfDay <= nowSecOfDay
                    ? nowSecOfDay - lineSecOfDay
                    : (86400 - lineSecOfDay) + nowSecOfDay;
            }
            return { idx: i, text: l, age_sec: ageSec };
        });

        // "Last event" freshness — use the newest line's parsed age
        const lastEventEpochRaw = await redis.get('VIRTUAL:LOG_LAST_EVENT_EPOCH').catch(() => null);
        const lastEventEpoch = lastEventEpochRaw ? parseInt(lastEventEpochRaw, 10) : null;
        const lastEventAgeSec = lastEventEpoch ? Math.round(Date.now() / 1000 - lastEventEpoch) : null;

        res.json({
            scalper, count: lines.length, tracebacks, skips,
            last_event_age_sec: lastEventAgeSec,
            last_event_age_label: lastEventAgeSec == null ? 'no events yet'
                : lastEventAgeSec < 60 ? `${lastEventAgeSec}s ago`
                : lastEventAgeSec < 3600 ? `${Math.round(lastEventAgeSec / 60)}m ago`
                : `${(lastEventAgeSec / 3600).toFixed(1)}h ago`,
            stability_note: lastEventAgeSec == null ? null
                : lastEventAgeSec < 300 ? `🔴 New activity ${lastEventAgeSec}s ago`
                : lastEventAgeSec < 3600 ? `🟡 Last event ${Math.round(lastEventAgeSec/60)}m ago`
                : `🟢 Stable for ${(lastEventAgeSec/3600).toFixed(1)}h — no recent events`,
            lines: enrichedLines,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// iter30 v3 (2026-05-16): Micro-signal distribution.
// Surfaces the REAL reason Virtual Scalper isn't buying: ALL coins in
// the ANALYSIS_020_TIMELINE hash report micro_signal=NEUTRAL most of
// the time. If we see 100% NEUTRAL, that's an upstream analyzer issue,
// not a Virtual Scalper bug.
app.get('/api/micro-signal-distribution', async (req, res) => {
    try {
        const all = await redis.hgetall('ANALYSIS_020_TIMELINE');
        const counts = {};
        const sample = { non_neutral: [], stable_only: [] };
        let parseErrors = 0, total = 0, withSignal = 0;
        const now = Date.now() / 1000;
        let freshCount = 0;
        let oldest_age_sec = 0;

        for (const [sym, json] of Object.entries(all || {})) {
            total++;
            let timeline;
            try { timeline = JSON.parse(json); } catch (_) { parseErrors++; continue; }
            if (!Array.isArray(timeline) || timeline.length === 0) continue;
            const last = timeline[timeline.length - 1];
            const sig = last?.micro_signal || 'UNKNOWN';
            counts[sig] = (counts[sig] || 0) + 1;
            if (sig !== 'NEUTRAL' && sample.non_neutral.length < 20) {
                sample.non_neutral.push({
                    symbol: sym,
                    micro_signal: sig,
                    price: last.price,
                    status: last.status,
                    prediction_confidence: last.prediction_confidence,
                    time: last.time,
                });
                withSignal++;
            }
            // Freshness check
            const ts = last.timestamp || 0;
            const age = ts > 0 ? now - ts : Infinity;
            if (age < 120) freshCount++;
            if (age > oldest_age_sec) oldest_age_sec = age;
        }

        res.json({
            ts: Date.now(),
            total_coins: total,
            parse_errors: parseErrors,
            fresh_coins: freshCount,
            oldest_age_sec: Math.round(oldest_age_sec),
            signal_distribution: counts,
            non_neutral_samples: sample.non_neutral,
            interpretation: counts.NEUTRAL === total
                ? `🚨 All ${total} coins are NEUTRAL — upstream analyzer is not finding any signals. Virtual Scalper has nothing to buy. Check the micro_signal analyzer process.`
                : withSignal > 0
                    ? `✓ ${withSignal} coins have non-NEUTRAL signals. Virtual Scalper has buy candidates to evaluate.`
                    : `⚠ Mostly NEUTRAL with no clear buy candidates right now (normal during quiet market hours).`,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/scalper-restart-history', async (req, res) => {
    try {
        const raw = await redis.lrange('VIRTUAL:RESTART_HISTORY', 0, 49);
        const entries = raw.map(r => {
            // Format: "ts|action|reason"
            const [ts, action, reason] = r.split('|');
            return { ts, action, reason };
        });
        // Stats
        const summary = {
            total: entries.length,
            restarts: entries.filter(e => e.action === 'restart').length,
            skip_healthy: entries.filter(e => e.action === 'skip_healthy').length,
            skip_positions: entries.filter(e => e.action === 'skip_positions_open').length,
            skip_cooldown: entries.filter(e => e.action === 'skip_cooldown').length,
        };
        res.json({ summary, entries });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Validate JSON in every entry of a Redis hash. Used to find malformed
// entries that crash the Python json.loads() call in virtual_scalp_executor.
app.get('/api/redis-validate', async (req, res) => {
    const key = req.query.key;
    if (!key) return res.status(400).json({ error: 'key required' });
    // Whitelist to prevent abuse (only inspect known-relevant keys)
    const ALLOWED = new Set([
        'FAST_MOVE', 'RW_BASE_PRICE', 'BASE_CURRENT_INC_%',
        'SCALPER:LADDER_STATES', 'VIRTUAL:LADDER_STATES', 'PATTERN_BOT:OPEN',
        'BINANCE:OPEN_ORDERS:ALL',
        // iter30 fix: the ACTUAL Virtual Scalper signal source
        'ANALYSIS_020_TIMELINE', 'VIRTUAL_POSITIONS:MICRO', 'VIRTUAL_HISTORY:MICRO',
    ]);
    if (!ALLOWED.has(key)) return res.status(400).json({ error: `key not in whitelist: ${[...ALLOWED].join(', ')}` });

    try {
        const type = await redis.type(key);
        const out = { key, type, malformed: [], total: 0, valid: 0 };
        if (type === 'hash') {
            const fields = await redis.hkeys(key);
            out.total = fields.length;
            for (const f of fields) {
                const v = await redis.hget(key, f);
                if (v == null) continue;
                try {
                    JSON.parse(v);
                    out.valid++;
                } catch (e) {
                    out.malformed.push({
                        field: f,
                        sample: String(v).slice(0, 200),
                        error: e.message,
                    });
                }
            }
        } else if (type === 'string') {
            out.total = 1;
            const v = await redis.get(key);
            try { JSON.parse(v); out.valid++; }
            catch (e) { out.malformed.push({ field: '(root)', sample: String(v).slice(0, 200), error: e.message }); }
        } else if (type === 'list') {
            const len = await redis.llen(key);
            out.total = len;
            const sample = await redis.lrange(key, 0, Math.min(len, 100) - 1);
            sample.forEach((v, i) => {
                try { JSON.parse(v); out.valid++; }
                catch (e) { out.malformed.push({ field: `[${i}]`, sample: String(v).slice(0, 200), error: e.message }); }
            });
        }
        res.json(out);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Safely purge a single hash field (or list index) that was identified as
// malformed. Required because the JSON crash will recur on every restart
// until the bad entry is removed from the source.
app.post('/api/redis-purge', async (req, res) => {
    const { key, field, list_index } = req.body || {};
    const ALLOWED = new Set(['FAST_MOVE', 'RW_BASE_PRICE', 'BASE_CURRENT_INC_%']);
    if (!key || !ALLOWED.has(key)) {
        return res.status(400).json({ error: `key must be one of: ${[...ALLOWED].join(', ')}` });
    }
    if (!field && list_index === undefined) {
        return res.status(400).json({ error: 'field (for hash) or list_index (for list) required' });
    }
    try {
        const type = await redis.type(key);
        if (type === 'hash') {
            const existed = await redis.hexists(key, field);
            if (!existed) return res.status(404).json({ error: `field ${field} not found in ${key}` });
            await redis.hdel(key, field);
            return res.json({ success: true, key, field, removed: true });
        } else if (type === 'list') {
            // Set the offending index to a tombstone, then LREM
            // (Redis can't directly delete by index; use a unique tombstone)
            const tombstone = `__PURGED_${Date.now()}__`;
            await redis.lset(key, list_index, tombstone);
            await redis.lrem(key, 1, tombstone);
            return res.json({ success: true, key, list_index, removed: true });
        }
        res.status(400).json({ error: `unsupported type: ${type}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Manual safe-restart endpoint (mirrors the smart-restart script logic but
// callable from the dashboard).
app.post('/api/manual-restart', async (req, res) => {
    const force = !!req.body?.force;
    try {
        const [fastPos, virtPos, ptrnPos] = await Promise.all([
            redis.hlen('SCALPER:LADDER_STATES'),
            redis.hlen('VIRTUAL:LADDER_STATES'),
            redis.hlen('PATTERN_BOT:OPEN'),
        ]);
        const totalOpen = fastPos + virtPos + ptrnPos;
        if (totalOpen > 0 && !force) {
            return res.status(409).json({
                error: 'positions_open',
                detail: `${totalOpen} positions open (${fastPos}F + ${virtPos}V + ${ptrnPos}P). Pass force=true to override.`,
                fast: fastPos, virtual: virtPos, pattern: ptrnPos,
            });
        }
        // Write request marker — the host smart-restart cron will pick it up
        // on its next 5-min run, OR the operator can SSH and run it. Without
        // host shell access we can't actually restart booknow-backend from
        // inside the frontend container.
        const ts = Date.now();
        await redis.set('VIRTUAL:MANUAL_RESTART_REQUEST', String(ts), 'EX', 300);
        res.json({
            success: true,
            note: 'Manual restart requested. The host smart-restart watcher (every 5min) will execute on next tick. To restart immediately, SSH to the host and run: ~/booknow-cron/smart-restart.sh',
            positions_at_request: { fast: fastPos, virtual: virtPos, pattern: ptrnPos },
            requested_at: ts,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// iter 27 fe (2026-05-16): Limit-Offset Strategy editor
//
// User: "today we can enable limit order buy 1 off set -0.01% and -0.02%
// and -0.03%, please add the existing limit order buy off set logic,
// which scenario we can buy the coin with -0.03% and the new logic"
//
// Surfaces the iter43 tier config (CALM/NORMAL/VOLATILE/X_VOLATILE) as
// editable, with presets + live per-coin preview. Saves to TRADING_CONFIG;
// the Python scalper picks up new values on its next signal evaluation.

function classifyTier(range1hPct, settings) {
    if (range1hPct < (settings.adaptiveTierCalmMaxPct ?? 1)) return 'CALM';
    if (range1hPct < (settings.adaptiveTierNormalMaxPct ?? 2)) return 'NORMAL';
    if (range1hPct < (settings.adaptiveTierVolatileMaxPct ?? 4)) return 'VOLATILE';
    return 'X_VOLATILE';
}

function offsetForTier(tier, settings) {
    switch (tier) {
        case 'CALM':       return {
            buy1: settings.adaptiveBuy1OffsetCalm ?? 0.15,
            buy2: settings.adaptiveBuy2OffsetCalm ?? 0.50,
            tp:   settings.adaptiveTpTargetCalm ?? 0.15,
        };
        case 'NORMAL':     return {
            buy1: settings.adaptiveBuy1OffsetNormal ?? 0.30,
            buy2: settings.adaptiveBuy2OffsetNormal ?? 0.80,
            tp:   settings.adaptiveTpTargetNormal ?? 0.20,
        };
        case 'VOLATILE':   return {
            buy1: settings.adaptiveBuy1OffsetVolatile ?? 0.70,
            buy2: settings.adaptiveBuy2OffsetVolatile ?? 1.50,
            tp:   settings.adaptiveTpTargetVolatile ?? 0.30,
        };
        case 'X_VOLATILE': return {
            buy1: settings.adaptiveBuy1OffsetXVolatile ?? 1.50,
            buy2: settings.adaptiveBuy2OffsetXVolatile ?? 2.50,
            tp:   settings.adaptiveTpTargetXVolatile ?? 0.50,
        };
    }
}

// Allowed keys for the strategy editor — guards POST against arbitrary writes.
const STRATEGY_KEYS = [
    'adaptiveTierCalmMaxPct', 'adaptiveTierNormalMaxPct', 'adaptiveTierVolatileMaxPct',
    'adaptiveBuy1OffsetCalm', 'adaptiveBuy1OffsetNormal', 'adaptiveBuy1OffsetVolatile', 'adaptiveBuy1OffsetXVolatile',
    'adaptiveBuy2OffsetCalm', 'adaptiveBuy2OffsetNormal', 'adaptiveBuy2OffsetVolatile', 'adaptiveBuy2OffsetXVolatile',
    'adaptiveTpTargetCalm', 'adaptiveTpTargetNormal', 'adaptiveTpTargetVolatile', 'adaptiveTpTargetXVolatile',
];

app.get('/api/offset-strategy/current', async (req, res) => {
    try {
        const cfgRaw = await redis.get(CONFIG_KEY);
        const cfg = { ...DEFAULT_TRADING_CONFIG, ...(cfgRaw ? JSON.parse(cfgRaw) : {}) };
        const out = {};
        STRATEGY_KEYS.forEach(k => { out[k] = cfg[k]; });
        out.adaptiveEntryEnabled = !!cfg.adaptiveEntryEnabled;
        res.json({ config: out });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Preview what the offset strategy WOULD do for a set of symbols given
// candidate settings (without saving). Helps the operator see the impact
// before committing.
app.get('/api/offset-strategy/preview', async (req, res) => {
    try {
        const cfgRaw = await redis.get(CONFIG_KEY);
        const live = { ...DEFAULT_TRADING_CONFIG, ...(cfgRaw ? JSON.parse(cfgRaw) : {}) };
        // Read optional override settings from query (JSON-encoded)
        let candidate = { ...live };
        if (req.query.settings) {
            try {
                const overrides = JSON.parse(req.query.settings);
                for (const k of STRATEGY_KEYS) {
                    if (overrides[k] !== undefined) candidate[k] = parseFloat(overrides[k]);
                }
            } catch (_) {}
        }
        // Symbols: explicit list, or sensible default mix
        const symbolsParam = (req.query.symbols || 'BTCUSDT,ETHUSDT,SOLUSDT,DOGEUSDT,SUIUSDT,CHZUSDT,DEXEUSDT,RENDERUSDT,PENDLEUSDT,LINKUSDT').split(',').map(s => s.trim()).filter(Boolean);

        // Fetch ticker + 1h kline (range) per symbol in parallel
        const rows = await Promise.all(symbolsParam.map(async (sym) => {
            try {
                const [t, kl] = await Promise.all([
                    fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`).then(r => r.json()).catch(() => null),
                    fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1h&limit=2`).then(r => r.json()).catch(() => null),
                ]);
                if (!t || !t.price) return { symbol: sym, error: 'ticker fetch failed' };
                const price = parseFloat(t.price);
                let range1hPct = 0;
                if (Array.isArray(kl) && kl.length) {
                    const k = kl[kl.length - 1];
                    const h = parseFloat(k[2]), l = parseFloat(k[3]);
                    range1hPct = l > 0 ? (h - l) / l * 100 : 0;
                }
                const liveTier = classifyTier(range1hPct, live);
                const liveOff  = offsetForTier(liveTier, live);
                const newTier  = classifyTier(range1hPct, candidate);
                const newOff   = offsetForTier(newTier, candidate);
                return {
                    symbol: sym,
                    current_price: price,
                    range_1h_pct: +range1hPct.toFixed(2),
                    live: {
                        tier: liveTier,
                        buy1_offset_pct: liveOff.buy1,
                        buy1_price: +(price * (1 - liveOff.buy1 / 100)).toFixed(10),
                        tp_target_usdt: liveOff.tp,
                    },
                    candidate: {
                        tier: newTier,
                        buy1_offset_pct: newOff.buy1,
                        buy1_price: +(price * (1 - newOff.buy1 / 100)).toFixed(10),
                        tp_target_usdt: newOff.tp,
                    },
                    changed: liveTier !== newTier || liveOff.buy1 !== newOff.buy1 || liveOff.tp !== newOff.tp,
                };
            } catch (e) {
                return { symbol: sym, error: e.message };
            }
        }));

        res.json({
            ts: Date.now(),
            live_settings: Object.fromEntries(STRATEGY_KEYS.map(k => [k, live[k]])),
            candidate_settings: Object.fromEntries(STRATEGY_KEYS.map(k => [k, candidate[k]])),
            previews: rows,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Save new settings. Validates monotonicity (calm < normal < volatile) and
// reasonable bounds. Returns the merged config.
app.post('/api/offset-strategy/save', async (req, res) => {
    try {
        const overrides = req.body || {};
        const cfgRaw = await redis.get(CONFIG_KEY);
        const existing = cfgRaw ? JSON.parse(cfgRaw) : {};
        const merged = { ...DEFAULT_TRADING_CONFIG, ...existing };
        for (const k of STRATEGY_KEYS) {
            if (overrides[k] !== undefined) {
                const v = parseFloat(overrides[k]);
                if (isNaN(v) || v < 0 || v > 100) {
                    return res.status(400).json({ error: `Invalid value for ${k}: ${overrides[k]}` });
                }
                merged[k] = v;
            }
        }
        // Validation: tier thresholds must be strictly increasing
        if (!(merged.adaptiveTierCalmMaxPct < merged.adaptiveTierNormalMaxPct &&
              merged.adaptiveTierNormalMaxPct < merged.adaptiveTierVolatileMaxPct)) {
            return res.status(400).json({ error: 'Tier thresholds must be increasing: CALM < NORMAL < VOLATILE' });
        }
        // Buy offsets typically loosen as volatility grows — soft warning not error
        const buy1Order = [merged.adaptiveBuy1OffsetCalm, merged.adaptiveBuy1OffsetNormal,
                           merged.adaptiveBuy1OffsetVolatile, merged.adaptiveBuy1OffsetXVolatile];
        const monotonic = buy1Order.every((v, i, a) => i === 0 || v >= a[i-1]);
        await redis.set(CONFIG_KEY, JSON.stringify(merged));
        res.json({
            success: true,
            saved: Object.fromEntries(STRATEGY_KEYS.map(k => [k, merged[k]])),
            warning: monotonic ? null : 'Buy-1 offsets are not monotonically increasing across tiers. This is unusual — a more-volatile coin getting a tighter offset is risky. Saved anyway.',
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// iter 17 fe: Pattern Bot endpoints
app.get('/api/pattern-bot/status', async (req, res) => {
    try {
        const cfg = JSON.parse((await redis.get(CONFIG_KEY)) || '{}');
        const status = await redis.hgetall('PATTERN_BOT:STATUS') || {};
        const open = await redis.hgetall('PATTERN_BOT:OPEN') || {};
        const openTrades = Object.values(open).map(v => { try { return JSON.parse(v); } catch (_) { return null; } }).filter(Boolean);
        res.json({
            config: {
                enabled: !!cfg.patternBotEnabled,
                paper_mode: !!cfg.patternBotPaperMode,
                algo: cfg.patternBotAlgo || 'early_pump',
                min_score: cfg.patternBotMinScore ?? 70,
                stop_pct: cfg.patternBotStopPct ?? 1.5,
                max_fresh_sec: cfg.patternBotMaxFreshSec ?? 60,
                timeout_min: cfg.patternBotTimeoutMin ?? 240,
            },
            status: {
                last_poll_ts: status.last_poll_ts ? +status.last_poll_ts : null,
                last_eval_count: status.last_eval_count ? +status.last_eval_count : 0,
                last_executed: status.last_executed ? +status.last_executed : 0,
                pattern_open: status.pattern_open ? +status.pattern_open : 0,
                slot_available: status.slot_available === '1',
            },
            open_trades: openTrades,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/pattern-bot/trades', async (req, res) => {
    try {
        const date = req.query.date || new Date().toISOString().slice(0, 10);
        const mode = req.query.mode || 'paper';  // paper | live | both
        const limit = parseInt(req.query.limit || '100', 10);
        const result = { date, paper_trades: [], live_trades: [], skips: [] };

        if (mode === 'paper' || mode === 'both') {
            const raw = await redis.lrange(`PATTERN_BOT:PAPER_TRADES:${date}`, 0, limit - 1);
            result.paper_trades = raw.map(r => { try { return JSON.parse(r); } catch (_) { return null; } }).filter(Boolean);
        }
        if (mode === 'live' || mode === 'both') {
            const raw = await redis.lrange(`PATTERN_BOT:LIVE_TRADES:${date}`, 0, limit - 1);
            result.live_trades = raw.map(r => { try { return JSON.parse(r); } catch (_) { return null; } }).filter(Boolean);
        }
        const skipsRaw = await redis.lrange(`PATTERN_BOT:SKIPS:${date}`, 0, 50);
        result.skips = skipsRaw.map(r => { try { return JSON.parse(r); } catch (_) { return null; } }).filter(Boolean);

        // Summary
        const trades = [...result.paper_trades, ...result.live_trades];
        const wins = trades.filter(t => t.outcome === 'tp_hit').length;
        const losses = trades.filter(t => t.outcome === 'stop_loss').length;
        const timeouts = trades.filter(t => t.outcome === 'timeout').length;
        const totalPnl = trades.reduce((s, t) => s + (t.net_pnl || 0), 0);
        result.summary = {
            total: trades.length,
            wins, losses, timeouts,
            win_rate_pct: trades.length ? +(wins / trades.length * 100).toFixed(1) : 0,
            total_pnl_usdt: +totalPnl.toFixed(4),
        };
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/pattern-bot/toggle', async (req, res) => {
    try {
        const { enabled, paper_mode, algo, min_score } = req.body || {};
        const existingRaw = await redis.get(CONFIG_KEY);
        const existing = existingRaw ? JSON.parse(existingRaw) : {};
        const merged = { ...DEFAULT_TRADING_CONFIG, ...existing };
        if (typeof enabled === 'boolean') merged.patternBotEnabled = enabled;
        if (typeof paper_mode === 'boolean') merged.patternBotPaperMode = paper_mode;
        if (typeof algo === 'string') merged.patternBotAlgo = algo;
        if (typeof min_score === 'number') merged.patternBotMinScore = min_score;
        await redis.set(CONFIG_KEY, JSON.stringify(merged));
        res.json({ success: true,
            enabled: merged.patternBotEnabled,
            paper_mode: merged.patternBotPaperMode,
            algo: merged.patternBotAlgo,
            min_score: merged.patternBotMinScore });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/pattern-backtest', async (req, res) => {
    try {
        const date = req.query.date || new Date().toISOString().slice(0, 10);
        const which = req.query.algo || 'both';  // bounce | early_pump | both

        const out = { date, params: { tp_pct: TP_PCT, sl_pct: SL_PCT, timeout_hours: TIMEOUT_HOURS, leg_size_usdt: LEG_SIZE_USDT } };

        if (which === 'bounce' || which === 'both') {
            // BOUNCE detections live in main Redis
            const raw = await redis.lrange(`BOUNCE:DETECTIONS:${date}`, 0, -1);
            const detections = raw.map(r => { try { return JSON.parse(r); } catch (_) { return null; } }).filter(Boolean);
            // De-dupe: keep first detection per symbol (avoid scoring the same signature multiple times)
            const seen = new Set();
            const uniq = detections.filter(d => {
                if (seen.has(d.symbol)) return false;
                seen.add(d.symbol);
                return true;
            });
            const results = await backtestDetections(uniq);
            out.bounce = { summary: summariseResults(results), trades: results };
        }

        if (which === 'early_pump' || which === 'both') {
            // EARLY_PUMP detections live in analyse Redis
            const raw = await redisAnalyse.lrange(`EARLY_PUMP:DETECTIONS:${date}`, 0, -1);
            const detections = raw.map(r => { try { return JSON.parse(r); } catch (_) { return null; } }).filter(Boolean);
            const seen = new Set();
            const uniq = detections.filter(d => {
                if (seen.has(d.symbol)) return false;
                seen.add(d.symbol);
                return true;
            });
            const results = await backtestDetections(uniq);
            out.early_pump = { summary: summariseResults(results), trades: results };
        }

        res.json(out);
    } catch (err) {
        res.status(500).json({ error: err.message, stack: err.stack });
    }
});

app.post('/api/v1/config', async (req, res) => {
    try {
        const newConfig = req.body || {};
        // Basic validation
        if (typeof newConfig.autoBuyEnabled !== 'boolean') return res.status(400).json({ error: 'Invalid autoBuyEnabled' });
        if (isNaN(newConfig.buyAmountUsdt)) return res.status(400).json({ error: 'Invalid buyAmountUsdt' });
        if (isNaN(newConfig.profitAmountUsdt)) return res.status(400).json({ error: 'Invalid profitAmountUsdt' });

        // MERGE with existing config so fields the form doesn't include
        // (stopLossUsdt, virtualScalperLiveMode, min*24h*, etc.) are
        // preserved instead of silently destroyed. Single source of
        // truth: TRADING_CONFIG holds every field; the dashboard form
        // is allowed to update a subset.
        const existingRaw = await redis.get(CONFIG_KEY);
        const existing = existingRaw ? JSON.parse(existingRaw) : {};
        const merged = { ...DEFAULT_TRADING_CONFIG, ...existing, ...newConfig };

        await redis.set(CONFIG_KEY, JSON.stringify(merged));
        console.log('[Config] Configuration merged via dashboard:', merged);
        res.json({ success: true, config: merged });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save config' });
    }
});

// ─── Metrics API ──────────────────────────────────────────────────────────────
// Backend writes via metrics_collector.py to the same Redis under METRICS:*.
function todayStr() { return new Date().toISOString().slice(0, 10); }

async function _safeParseList(key, limit = 200) {
    try {
        const arr = await redis.lrange(key, 0, limit - 1);
        return arr.map((x) => { try { return JSON.parse(x); } catch (_) { return null; } }).filter(Boolean);
    } catch (_) { return []; }
}

app.get('/api/metrics/summary', async (req, res) => {
    try {
        const date = req.query.date || todayStr();
        const [daily, breakdown] = await Promise.all([
            redis.hgetall(`METRICS:DAILY:${date}`),
            redis.hgetall(`METRICS:FILTER_BREAKDOWN:${date}`),
        ]);
        const toNum = (m) => Object.fromEntries(
            Object.entries(m || {}).map(([k, v]) => [k, isNaN(Number(v)) ? v : Number(v)])
        );

        const outcomeKeys = await redis.keys(`METRICS:OUTCOME:${date}:*`);
        const outcomes = await Promise.all(outcomeKeys.map(async (k) => {
            const h = await redis.hgetall(k);
            const obj = {};
            for (const [k2, v2] of Object.entries(h || {})) {
                if (v2 === undefined) continue;
                if (typeof v2 === 'string' && (v2.startsWith('{') || v2.startsWith('['))) {
                    try { obj[k2] = JSON.parse(v2); continue; } catch (_) {}
                }
                obj[k2] = isNaN(Number(v2)) ? v2 : Number(v2);
            }
            return obj;
        }));

        res.json({
            date,
            daily: toNum(daily),
            filterBreakdown: toNum(breakdown),
            outcomes,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch metrics summary', detail: err.message });
    }
});

app.get('/api/metrics/signals', async (req, res) => {
    try {
        const date = req.query.date || todayStr();
        const limit = Math.min(parseInt(req.query.limit || '200', 10), 1000);
        const items = await _safeParseList(`METRICS:SIGNAL:${date}`, limit);
        res.json({ date, count: items.length, items });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch signals', detail: err.message });
    }
});

app.get('/api/metrics/skips', async (req, res) => {
    try {
        const date = req.query.date || todayStr();
        const limit = Math.min(parseInt(req.query.limit || '200', 10), 1000);
        const items = await _safeParseList(`METRICS:SKIP:${date}`, limit);
        res.json({ date, count: items.length, items });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch skips', detail: err.message });
    }
});

app.get('/api/metrics/buys', async (req, res) => {
    try {
        const date = req.query.date || todayStr();
        const limit = Math.min(parseInt(req.query.limit || '200', 10), 1000);
        const items = await _safeParseList(`METRICS:BUY:${date}`, limit);
        res.json({ date, count: items.length, items });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch buys', detail: err.message });
    }
});

// ─── Trade Audit API (2026-05-12) ─────────────────────────────────────────────
// Returns per-trade full audit data: pre-signal, signal, limit, fill, target sells,
// past 15min low/high, and live running lowest/highest since buy.
app.get('/api/metrics/audit', async (req, res) => {
    try {
        const date = req.query.date || todayStr();
        const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);

        // Pull the chronological AUDIT events
        const audit = await _safeParseList(`METRICS:AUDIT:${date}`, limit);

        // For each audit entry, augment with live OUTCOME state (lowest/highest since buy)
        for (const ev of audit) {
            try {
                const sym = (ev.symbol || '').replace('/', '');
                const outKey = `METRICS:OUTCOME:${date}:${sym}`;
                const h = await redis.hgetall(outKey);
                if (h) {
                    const num = (v) => v === '' || v == null ? null : Number(v);
                    ev.lowest_since_buy  = num(h.lowest_since_buy);
                    ev.highest_since_buy = num(h.highest_since_buy);
                    ev.now_price         = num(h.now_price);
                    ev.now_pct           = num(h.now_pct);
                    ev.bottom_pct        = num(h.bottom_pct);
                    ev.max_pct           = num(h.max_pct);
                    ev.filled            = Number(h.filled || 0) === 1;
                    ev.exited            = Number(h.exited || 0) === 1;
                    ev.exit_price        = num(h.exit_price);
                    ev.exit_reason       = h.exit_reason || null;
                    ev.pnl_usdt          = num(h.pnl_usdt);
                    // 2026-05-12 iter 15: surface order_type so dashboard
                    // can distinguish paper (virtual_..._paper) from live
                    // (virtual_..._offset_limit / virtual_..._market) and
                    // from Fast Scalper paths.
                    ev.order_type        = h.order_type || null;
                }
            } catch (_) {}
        }

        res.json({ date, count: audit.length, items: audit });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch audit', detail: err.message });
    }
});

// ─── Monitor snapshot — single call powering /monitor.html ──────────────────
// 2026-05-13 iter 20: aggregates everything the operator needs to glance at
// the bot's live state into one response (saves four round-trips from the
// page, and lets the dashboard auto-refresh every ~10s without slamming
// individual Redis keys). Sourced entirely from Redis, no Binance REST.
app.get('/api/monitor', async (req, res) => {
    try {
        const today = req.query.date || todayStr();
        const [usdtRaw, fastLadders, virtualLadders, daily, breakdown,
               openOrdersRaw, cooldownKeys] = await Promise.all([
            redis.get('BINANCE:BALANCE:USDT'),
            redis.hgetall('SCALPER:LADDER_STATES'),
            redis.hgetall('VIRTUAL:LADDER_STATES'),
            redis.hgetall(`METRICS:DAILY:${today}`),
            redis.hgetall(`METRICS:FILTER_BREAKDOWN:${today}`),
            redis.get('BINANCE:OPEN_ORDERS:ALL'),
            redis.keys('SCALPER:LADDER_COOLDOWN:*'),
        ]);

        const usdt = usdtRaw ? safeParse(usdtRaw, {}) : {};
        const openOrders = openOrdersRaw ? safeParse(openOrdersRaw, []) : [];

        // Inflate ladder state JSON blobs into objects. Each Redis hash
        // field is a JSON-serialised LadderState — parse all of them.
        const parseLadders = (obj) =>
            Object.entries(obj || {}).map(([k, v]) => {
                try { return JSON.parse(v); } catch (_) { return null; }
            }).filter(Boolean);

        // Coerce DAILY hash strings to numbers where they look numeric.
        const numericDaily = Object.fromEntries(
            Object.entries(daily || {}).map(([k, v]) => [k, isNaN(Number(v)) ? v : Number(v)])
        );
        const numericBreakdown = Object.fromEntries(
            Object.entries(breakdown || {}).map(([k, v]) => [k, Number(v)])
        );

        res.json({
            ts: Date.now(),
            date: today,
            wallet: {
                usdt_free: parseFloat(usdt.free || 0),
                usdt_locked: parseFloat(usdt.locked || 0),
            },
            ladders: {
                fast: parseLadders(fastLadders),
                virtual: parseLadders(virtualLadders),
            },
            daily: numericDaily,
            filterBreakdown: numericBreakdown,
            openOrders: openOrders,
            cooldowns: cooldownKeys.map(k => k.replace('SCALPER:LADDER_COOLDOWN:', '')),
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch monitor snapshot', detail: err.message });
    }
});

// Small JSON parse helper — tolerant of malformed strings.
function safeParse(raw, fallback) {
    try { return JSON.parse(raw); } catch (_) { return fallback; }
}

// Convenience route so operators can browse to /monitor without .html
app.get('/monitor', (req, res) => res.sendFile(path.join(__dirname, 'public', 'monitor.html')));

// ─── Spot movers ─────────────────────────────────────────────────────────────
// 2026-05-13 iter 26: proxy Binance ticker data through the backend so the
// /spot.html page works for operators whose browsers/ISPs block direct
// WebSocket connections to stream.binance.com (a common issue in India).
//
//   ?window=24h → returns the cache populated by binance-worker's
//                 !miniTicker@arr WebSocket (always fresh, ~1s lag).
//   ?window=1h  → fetches /api/v3/ticker?windowSize=1h from Binance.
//   ?window=4h  → fetches /api/v3/ticker?windowSize=4h from Binance.
//
// Response shape: { window, ts, tickers: [{symbol, price, change, high, low, volume}] }
// Sorted client-side; the endpoint just returns the raw set.
app.get('/api/spot-tickers', async (req, res) => {
    const window = (req.query.window || '24h').toLowerCase();
    try {
        if (window === '24h') {
            // Pull from binance-worker's WebSocket cache (no Binance REST call).
            const cached = binanceWorker.getAllTickers24h();
            const tickers = cached
                .filter(t => t.symbol && t.symbol.endsWith('USDT'))
                .map(t => {
                    const open = parseFloat(t.openPrice);
                    const last = parseFloat(t.lastPrice);
                    const changePct = (open > 0) ? ((last - open) / open) * 100 : 0;
                    return {
                        symbol: t.symbol,
                        price:  last,
                        change: changePct,
                        high:   parseFloat(t.highPrice),
                        low:    parseFloat(t.lowPrice),
                        volume: parseFloat(t.quoteVolume),
                    };
                });
            return res.json({ window, ts: Date.now(), tickers });
        }
        if (window === '1h' || window === '4h') {
            // Binance's /api/v3/ticker?windowSize=… REQUIRES a `symbols`
            // list (error -1128 if omitted). Cap is 100 symbols per call.
            // Strategy: take the top 100 USDT pairs by 24h volume — these
            // are the ones the operator actually cares about, and the
            // long tail is mostly illiquid micro-caps anyway.
            const cached = binanceWorker.getAllTickers24h() || [];
            const top = cached
                .filter(t => t.symbol && t.symbol.endsWith('USDT'))
                .sort((a, b) => parseFloat(b.quoteVolume || 0) - parseFloat(a.quoteVolume || 0))
                .slice(0, 100)
                .map(t => t.symbol);
            if (top.length === 0) {
                return res.json({ window, ts: Date.now(), tickers: [] });
            }
            const data = await binanceWorker.binanceFetch(
                '/api/v3/ticker', 'GET',
                { windowSize: window, symbols: JSON.stringify(top) },
                { signed: false }
            );
            const tickers = (Array.isArray(data) ? data : [])
                .filter(t => t.symbol && t.symbol.endsWith('USDT'))
                .map(t => ({
                    symbol: t.symbol,
                    price:  parseFloat(t.lastPrice),
                    change: parseFloat(t.priceChangePercent),
                    high:   parseFloat(t.highPrice),
                    low:    parseFloat(t.lowPrice),
                    volume: parseFloat(t.quoteVolume),
                }));
            return res.json({ window, ts: Date.now(), tickers });
        }
        return res.status(400).json({ error: `Unsupported window: ${window}` });
    } catch (err) {
        console.error('[/api/spot-tickers]', err.message);
        return res.status(500).json({ error: err.message });
    }
});

// ─── Per-coin pump analysis ──────────────────────────────────────────────────
// 2026-05-13 iter 30: deep-dive view for "why did this coin pump and why
// didn't our bot catch it?". Used by the slide-out panel on /spot.html.
//
// Aggregates:
//   - Klines 1h × 168 (7 days), 1d × 30  →  chart + pump-start detection
//   - Today's METRICS:SIGNAL entries for the symbol → did we see signals?
//   - Today's METRICS:SKIP entries for the symbol → did our filters block?
//   - Computed stats:
//       price now, 24h high, 24h low
//       7-day pre-pump baseline (mean close of days -14..-7)
//       pump_pct_vs_baseline
//       peak_within_last_7d, days_since_peak
//       vol_24h_vs_7d_avg ratio (surge indicator)
//       pump_started_hours_ago (when the 1h close first exceeded baseline×1.05)
//   - Filter simulation: dry-run each gate against current data, return
//       { name, passed, reason } so the UI can show why we wouldn't trade
//       this coin RIGHT NOW.
app.get('/api/coin-analysis', async (req, res) => {
    const symbol = String(req.query.symbol || '').toUpperCase().replace('/', '');
    if (!symbol || !symbol.endsWith('USDT')) {
        return res.status(400).json({ error: 'symbol must be a USDT pair, e.g. COSUSDT' });
    }

    try {
        // 1. Klines — public endpoint, no signing.
        const [k1h, k1d] = await Promise.all([
            binanceWorker.binanceFetch(
                '/api/v3/klines', 'GET',
                { symbol, interval: '1h', limit: 168 },
                { signed: false }
            ),
            binanceWorker.binanceFetch(
                '/api/v3/klines', 'GET',
                { symbol, interval: '1d', limit: 30 },
                { signed: false }
            ),
        ]);

        // 2. Bot's view today — pull from Redis lists.
        const today = todayStr();
        const symbolSlash = symbol.slice(0, -4) + '/USDT';
        const symbolFlat  = symbol;
        const matchSymbol = (s) => {
            const v = (s && s.symbol) || '';
            return v === symbolSlash || v === symbolFlat || v.replace('/', '') === symbolFlat;
        };
        const [allSignals, allSkips] = await Promise.all([
            _safeParseList(`METRICS:SIGNAL:${today}`, 500),
            _safeParseList(`METRICS:SKIP:${today}`, 500),
        ]);
        const ourSignals = allSignals.filter(matchSymbol);
        const ourSkips   = allSkips.filter(matchSymbol);

        // 3. Live config so we can dry-run the filter gates.
        const configRaw = await redis.get(CONFIG_KEY);
        const cfg = configRaw ? JSON.parse(configRaw) : {};

        // 4. Compute stats from klines.
        const closes1d = k1d.map(k => parseFloat(k[4]));
        const closes1h = k1h.map(k => parseFloat(k[4]));
        const highs1h  = k1h.map(k => parseFloat(k[2]));
        const lows1h   = k1h.map(k => parseFloat(k[3]));
        const vols1h   = k1h.map(k => parseFloat(k[7]));   // quote volume (USDT)
        const nowPrice = closes1h.length ? closes1h[closes1h.length - 1] : 0;

        const last24h = closes1h.slice(-24);
        const high24h = Math.max(...highs1h.slice(-24));
        const low24h  = Math.min(...lows1h.slice(-24));
        const open24h = last24h[0] || nowPrice;
        const change24hPct = open24h > 0 ? ((nowPrice - open24h) / open24h * 100) : 0;

        // 7-day baseline = mean close of days -14 to -7 (pre-pump window).
        const baselineSlice = closes1d.slice(-14, -7);
        const baseline7d = baselineSlice.length
            ? baselineSlice.reduce((a, b) => a + b, 0) / baselineSlice.length
            : 0;
        const pumpPctVsBaseline = baseline7d > 0
            ? ((nowPrice - baseline7d) / baseline7d * 100)
            : 0;

        // Peak in the last 14 days
        const last14dHighs = k1d.slice(-14).map(k => parseFloat(k[2]));
        const peak14d = last14dHighs.length ? Math.max(...last14dHighs) : 0;
        const peakIdx = last14dHighs.lastIndexOf(peak14d);
        const daysSincePeak = peak14d > 0 ? (last14dHighs.length - 1 - peakIdx) : 0;
        const offPeakPct = peak14d > 0 ? ((peak14d - nowPrice) / peak14d * 100) : 0;

        // Volume surge: 24h vol vs prior 6-day average daily quote vol.
        const vols1d = k1d.map(k => parseFloat(k[7]));
        const vol24h = vols1d.length ? vols1d[vols1d.length - 1] : 0;
        const priorVols = vols1d.slice(-7, -1);
        const avgVolPrior = priorVols.length
            ? priorVols.reduce((a, b) => a + b, 0) / priorVols.length
            : 0;
        const volSurgeRatio = avgVolPrior > 0 ? (vol24h / avgVolPrior) : 0;

        // When did the pump start? Walk 1h closes backwards from now; the
        // first hour where the close was within 2% of the 7d baseline is
        // a reasonable "pump-start" marker.
        let pumpStartHoursAgo = null;
        if (baseline7d > 0) {
            for (let i = closes1h.length - 1; i >= 0; i--) {
                if (closes1h[i] <= baseline7d * 1.02) {
                    pumpStartHoursAgo = closes1h.length - 1 - i;
                    break;
                }
            }
        }

        // 5. Filter simulation — does our current config want to buy this
        // coin RIGHT NOW? Each entry: { rule, ok, detail }.
        const fkMaxChange  = Number(cfg.maxChange24hPct || 12);
        const fkMaxRange1h = Number(cfg.maxRange1hPct || 6);
        const fkOver60m    = Number(cfg.overbought60mPct || 2.5);
        const minVolUsdt   = Number(cfg.minVol24hUsd || 2_000_000);
        const ppThreshold  = Number(cfg.postPumpThresholdPct || 30);
        const ppOffPeakMin = Number(cfg.postPumpOffPeakMinPct || 10);
        const ppMinDays    = Number(cfg.postPumpMinDaysSincePeak || 2);
        const ppLookback   = Number(cfg.postPumpLookbackDays || 15);
        const ppBaselineD  = Number(cfg.postPumpBaselineDays || 10);

        // 1h range
        const last1hHighs = highs1h.slice(-1);
        const last1hLows  = lows1h.slice(-1);
        const range1hPct = (last1hHighs[0] && last1hLows[0])
            ? ((last1hHighs[0] - last1hLows[0]) / last1hLows[0] * 100) : 0;
        // 60m change (last hour close vs previous close)
        const change60mPct = closes1h.length >= 2
            ? ((closes1h[closes1h.length - 1] - closes1h[closes1h.length - 2])
                / closes1h[closes1h.length - 2] * 100)
            : 0;

        // Post-pump gate using configured lookback
        const ppLookbackSlice = k1d.slice(-(ppLookback + 1), -1).map(k => parseFloat(k[2]));
        const ppBaselineSlice = k1d.slice(-(ppLookback + 1 + ppBaselineD), -(ppLookback + 1))
            .map(k => parseFloat(k[4]));
        const ppPeak = ppLookbackSlice.length ? Math.max(...ppLookbackSlice) : 0;
        const ppPeakIdx = ppLookbackSlice.lastIndexOf(ppPeak);
        const ppDaysSincePeak = ppPeak > 0 ? (ppLookbackSlice.length - 1 - ppPeakIdx) : 0;
        const ppBaseline = ppBaselineSlice.length
            ? ppBaselineSlice.reduce((a, b) => a + b, 0) / ppBaselineSlice.length
            : 0;
        const ppPumpPct = ppBaseline > 0 ? ((ppPeak - ppBaseline) / ppBaseline * 100) : 0;
        const ppOffPct  = ppPeak > 0 ? ((ppPeak - nowPrice) / ppPeak * 100) : 0;

        const filters = [
            {
                rule: 'min 24h volume',
                ok: vol24h >= minVolUsdt,
                detail: `vol24h $${(vol24h / 1e6).toFixed(2)}M  vs threshold $${(minVolUsdt / 1e6).toFixed(2)}M`,
            },
            {
                rule: 'max 24h pump',
                ok: change24hPct <= fkMaxChange,
                detail: `change24h ${change24hPct >= 0 ? '+' : ''}${change24hPct.toFixed(2)}%  vs cap +${fkMaxChange.toFixed(1)}%`,
            },
            {
                rule: 'max 1h range',
                ok: range1hPct <= fkMaxRange1h,
                detail: `range1h ${range1hPct.toFixed(2)}%  vs cap ${fkMaxRange1h.toFixed(1)}%`,
            },
            {
                rule: 'overbought combo (24h>0 AND 60m>X)',
                ok: !(change24hPct > 0 && change60mPct > fkOver60m),
                detail: `24h ${change24hPct >= 0 ? '+' : ''}${change24hPct.toFixed(2)}% / 60m ${change60mPct >= 0 ? '+' : ''}${change60mPct.toFixed(2)}%  (skip if 24h>0 AND 60m>${fkOver60m}%)`,
            },
            {
                rule: 'post-pump bleed',
                ok: !(ppPumpPct >= ppThreshold && ppOffPct >= ppOffPeakMin && ppDaysSincePeak >= ppMinDays),
                detail: `pump +${ppPumpPct.toFixed(0)}% / off-peak ${ppOffPct.toFixed(1)}% / days-since-peak ${ppDaysSincePeak}  (block if all 3 ≥ thresholds ${ppThreshold}/${ppOffPeakMin}/${ppMinDays})`,
            },
        ];
        const blockedBy = filters.filter(f => !f.ok).map(f => f.rule);
        const verdict = blockedBy.length === 0
            ? { state: 'pass_filters', text: 'All filters pass. A signal from process_symbol would lead to a buy.' }
            : { state: 'blocked', text: `Blocked by: ${blockedBy.join(', ')}` };

        // Trim klines payload — only keep [openTime, open, high, low, close, vol]
        const trim = (k) => [parseInt(k[0]), parseFloat(k[1]), parseFloat(k[2]),
                              parseFloat(k[3]), parseFloat(k[4]), parseFloat(k[5])];

        res.json({
            symbol: symbolSlash,
            ts: Date.now(),
            stats: {
                price: nowPrice,
                change24h_pct: change24hPct,
                high24h, low24h,
                baseline7d,
                pump_pct_vs_baseline: pumpPctVsBaseline,
                peak14d, days_since_peak: daysSincePeak, off_peak_pct: offPeakPct,
                vol24h, avgVolPrior, vol_surge_ratio: volSurgeRatio,
                pump_start_hours_ago: pumpStartHoursAgo,
            },
            klines_1h: k1h.map(trim),
            klines_1d: k1d.map(trim),
            bot_today: {
                signals: ourSignals.length,
                skips: ourSkips.length,
                signal_events: ourSignals.slice(0, 10),
                skip_events:   ourSkips.slice(0, 10),
            },
            filters,
            verdict,
        });
    } catch (err) {
        console.error('[/api/coin-analysis]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── REST API ─────────────────────────────────────────────────────────────────
// ─── Binance Account APIs (Node-native) ───────────────────────────────────────
// 1. Get Open Orders
app.get('/api/open-orders', async (req, res) => {
    const symbol = req.query.symbol;
    const key = symbol ? `BINANCE:OPEN_ORDERS:${symbol}` : 'BINANCE:OPEN_ORDERS:ALL';
    
    try {
        const raw = await redis.get(key);
        let orders = raw ? JSON.parse(raw) : [];

        // Check against DELIST list for safety
        const delistRaw = await redis.get('BINANCE:DELIST');
        const delisted = delistRaw ? JSON.parse(delistRaw) : [];

        orders = orders.map(o => ({
            ...o,
            atRisk: delisted.includes(o.symbol)
        }));

        res.json(orders);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch open orders' });
    }
});

// 2. Get Trade History
app.get('/api/trade-history', async (req, res) => {
    const symbol = req.query.symbol;
    const key = symbol ? `BINANCE:TRADE_HISTORY:${symbol}` : 'BINANCE:TRADE_HISTORY:ALL';
    
    try {
        const raw = await redis.get(key);
        const trades = raw ? JSON.parse(raw) : [];
        res.json(trades);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch trade history' });
    }
});

// 3. Cancel Order (Node-native)
app.post('/api/open-orders/cancel', async (req, res) => {
    const { symbol, orderId } = req.body;
    if (!symbol || !orderId) return res.status(400).json({ error: 'symbol + orderId required' });

    console.log(`[API] Node Cancel Order | symbol=${symbol} orderId=${orderId}`);
    
    try {
        const data = await binanceWorker.binanceFetch('/api/v3/order', 'DELETE', { symbol, orderId });
        if (data && data.status === 'CANCELED') {
            // Remove from Redis cache immediately for better UX
            const key = `BINANCE:OPEN_ORDERS:${symbol}`;
            const raw = await redis.get(key);
            if (raw) {
                let orders = JSON.parse(raw);
                orders = orders.filter(o => o.orderId !== orderId);
                await redis.set(key, JSON.stringify(orders));
            }
            // Also update the ALL list
            const allRaw = await redis.get('BINANCE:OPEN_ORDERS:ALL');
            if (allRaw) {
                let allOrders = JSON.parse(allRaw);
                allOrders = allOrders.filter(o => o.orderId !== orderId);
                await redis.set('BINANCE:OPEN_ORDERS:ALL', JSON.stringify(allOrders));
            }

            io.emit('order-cancelled', { symbol, orderId });
            // Force fresh snapshots so the dashboard reflects the
            // cancellation across all components, not just open orders.
            if (binanceWorker.refreshAllSnapshots) {
                binanceWorker.refreshAllSnapshots().catch(() => {});
            }
            return res.json({ ok: true, data });
        }
        res.status(400).json({ error: 'Cancel failed', detail: data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get/update auto-trade config
app.get('/api/config', (req, res) => res.json(autoConfig));
app.post('/api/config', (req, res) => {
    autoConfig = { ...autoConfig, ...req.body };
    console.log('[Config]', autoConfig);
    io.emit('config', autoConfig);
    res.json({ ok: true, config: autoConfig });
});

// ─── Dust Transfer (Convert to BNB) ──────────────────────────────────────────
app.post('/api/wallet/dust-transfer', async (req, res) => {
    const { asset } = req.body;
    if (!asset) return res.status(400).json({ error: 'asset required' });

    console.log(`[API] Dust Transfer | asset=${asset}`);
    try {
        // Binance API: POST /sapi/v1/asset/dust (asset can be a comma-separated list)
        const data = await binanceWorker.binanceFetch('/sapi/v1/asset/dust', 'POST', { asset });
        if (data && data.transferResult && data.transferResult.length > 0) {
            // Force-refresh balances so the UI reflects the conversion
            // without waiting for the next snapshot tick.
            if (binanceWorker.refreshAllSnapshots) {
                binanceWorker.refreshAllSnapshots().catch(() => {});
            }
            return res.json({ ok: true, data });
        }
        res.status(400).json({ error: 'Transfer failed', detail: data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Manual Market Sell (fast exit for orphaned positions) ───────────────────
// Bypasses the bot. Asset → SELL all free balance at market. Useful when
// the Binance web UI is slow and you need to dump a position immediately.
app.post('/api/wallet/market-sell', async (req, res) => {
    const { asset, qty } = req.body;
    if (!asset) return res.status(400).json({ error: 'asset required' });
    const symbol = `${asset.toUpperCase()}USDT`;
    console.log(`[API] Market Sell | asset=${asset} qty=${qty || 'ALL'}`);
    try {
        // Resolve sell quantity: explicit override, else free balance
        let sellQty = parseFloat(qty);
        if (!sellQty || sellQty <= 0) {
            const balRaw = await redis.get('BINANCE:BALANCES:ALL');
            const balances = balRaw ? JSON.parse(balRaw) : [];
            const row = balances.find(b => b.asset === asset.toUpperCase());
            if (!row) return res.status(400).json({ error: `no balance for ${asset}` });
            sellQty = parseFloat(row.free);
            if (!sellQty || sellQty <= 0) {
                return res.status(400).json({ error: `free balance is 0 for ${asset}` });
            }
        }
        const params = {
            symbol,
            side: 'SELL',
            type: 'MARKET',
            quantity: String(sellQty),
        };
        const order = await binanceWorker.binanceFetch('/api/v3/order', 'POST', params);
        if (binanceWorker.refreshAllSnapshots) {
            binanceWorker.refreshAllSnapshots().catch(() => {});
        }
        return res.json({ ok: true, order });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Manual Limit-Buy ─────────────────────────────────────────────────────────
app.post('/api/buy', async (req, res) => {
    // Support both field names to prevent breakage
    const symbol = req.body.symbol;
    const limitPrice = req.body.limitPrice || req.body.price;
    const targetPrice = req.body.targetPrice || req.body.target;
    const customSelPct = req.body.selPct;

    console.log(`[API] POST /api/buy | symbol=${symbol} limitPrice=${limitPrice} targetPrice=${targetPrice}`);
    
    const p = parseFloat(limitPrice);
    const isMarket = (!p || p <= 0);
    const q = req.body.qty || (100 / (p || 1)); // Use provided qty or $100 default
    const selPct = customSelPct || 2.0;

    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    if (!isMarket && !p) return res.status(400).json({ error: 'price required for LIMIT order' });
    
    if (positions.has(symbol)) return res.status(409).json({ error: 'Position already open' });

    // ── 1. Cascade to Engine (handles real Binance orders) ──────────────
    try {
        let url;
        if (isMarket) {
            // Market Buy endpoint
            url = `${SPRING_BASE}/order/buy/${encodeURIComponent(symbol)}?qty=${q}`;
            console.log(`[Engine] POST /order/buy (MARKET) | symbol=${symbol} qty=${q}`);
        } else {
            // Limit Buy endpoint
            url = `${SPRING_BASE}/order/limit-buy/${encodeURIComponent(symbol)}` +
                  `?limitPrice=${p}&targetPrice=${targetPrice || 0}&profitPct=${selPct}&qty=${q}`;
            console.log(`[Engine] POST /order/limit-buy | symbol=${symbol} price=${p} qty=${q}`);
        }
        const sbRes = await Promise.race([
            fetch(url),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
        ]);

        if (!sbRes.ok) {
            const errText = await sbRes.text();
            throw new Error(errText || `Engine returned ${sbRes.status}`);
        }

        const text = await sbRes.text();
        if (!text) throw new Error('Engine returned an empty response');
        
        const data = JSON.parse(text);
        if (!data || !data.orderId) throw new Error('Engine response missing orderId');

        const orderId       = data.orderId;
        const limitBuyPrice = p;
        const target        = targetPrice || (limitBuyPrice * (1 + selPct / 100));
        const stop          = limitBuyPrice * (1 - (autoConfig.stopLossPct || 0.8) / 100);

        // Register for monitoring
        activeLimitOrders.set(orderId, {
            orderId, symbol, side: 'BUY', limitPrice: p, qty: q, status: 'NEW', time: now(), source: 'MANUAL'
        });

        positions.set(symbol, {
            symbol, buyPrice: limitBuyPrice, qty: q,
            buyTime: now(), target, stop, signal: 'LIMIT_MANUAL', orderId,
            status: 'NEW'
        });

        const trade = { symbol, action: 'BUY', price: limitBuyPrice, qty: q,
                        target, stop, time: now(), status: data.status || 'NEW', simulation: false,
                        orderId, executedQty: data.executedQty, origQty: data.origQty,
                        note: `Manual Limit @ ${limitBuyPrice}` };
        tradeLog.unshift(trade);
        io.emit('trade', trade);
        io.emit('order-update', activeLimitOrders.get(orderId));
        console.log(`[Server] Buy Registered: ${symbol} #${orderId}`);

        setTimeout(() => tick().catch(e => console.error('[Refresh]', e.message)), 100);
        return res.json({ ok: true, trade, source: 'engine', orderId });
    } catch (e) {
        console.warn(`[Server] Engine unreachable (${e.message}), writing Redis directly`);
    }

    // ── 2. Fallback: record in Redis BUY hash directly ────────────────────────
    const limitBuyPrice = p;
    const target        = targetPrice || (limitBuyPrice * (1 + selPct / 100));
    const stop          = limitBuyPrice * (1 - (autoConfig.stopLossPct || 0.8) / 100);
    const hms           = new Date().toLocaleTimeString('en-GB');

    positions.set(symbol, {
        symbol, buyPrice: limitBuyPrice, qty: q,
        buyTime: now(), target, stop, signal: 'LIMIT_MANUAL',
        status: 'NEW'
    });

    const buyRecord = {
        buyPrice:    limitBuyPrice,
        selP:        targetPrice ? parseFloat(((targetPrice - p) / p * 100).toFixed(2)) : selPct,
        status:      'NEW',
        hms,
        source:      'DASHBOARD',
        limitOffset: 0,
    };

    try {
        await redis.hset(BUY_KEY, symbol, JSON.stringify(buyRecord));
        console.log(`[Redis] BUY HSET ${symbol} manualLimit@${limitBuyPrice.toFixed(6)} target@${target.toFixed(6)}`);
        setTimeout(() => tick().catch(e => console.error('[Refresh]', e.message)), 100);
    } catch (e) {
        console.warn(`[Redis] BUY write failed: ${e.message}`);
    }

    const trade = { symbol, action: 'BUY', price: limitBuyPrice, qty: q, target, stop,
                    time: now(), status: 'NEW', simulation: false,
                    note: `Manual Limit @ ${limitBuyPrice}` };
    tradeLog.unshift(trade);
    io.emit('trade', trade);
    res.json({ ok: true, trade, source: 'redis_fallback' });
});

// Manual sell
app.post('/api/sell', async (req, res) => {
    const { symbol, price, qty } = req.body;
    console.log(`[API] POST /api/sell | symbol=${symbol} price=${price} qty=${qty}`);
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    
    try {
        const url = `${SPRING_BASE}/sell/${encodeURIComponent(symbol)}?qty=${qty || 0}`;
        console.log(`[Engine] GET /sell/${symbol}?qty=${qty}`);
        const sbRes = await fetch(url);
        if (sbRes.ok) {
            positions.delete(symbol);
            io.emit('trade', { symbol, action: 'SELL', price, time: now() });
            setTimeout(() => tick().catch(e => console.error('[Refresh]', e.message)), 100);
            return res.json({ ok: true, message: 'SELL order sent via Engine' });
        }
    } catch (e) { /* fall through to direct fallback */ }

    let pos = positions.get(symbol);
    if (!pos) {
        try {
            const raw = await redis.hget(BUY_KEY, symbol);
            if (raw) {
                const buy = JSON.parse(raw);
                pos = {
                    symbol,
                    buyPrice: parseFloat(buy.buyPrice?.value ?? buy.buyPrice ?? 0),
                    qty: 12 / parseFloat(buy.buyPrice?.value ?? buy.buyPrice ?? 1),
                    buyTime: Date.now(),
                    target: 0, stop: 0, source: 'BOT'
                };
            }
        } catch (e) { console.error('[Redis] Lookup failed in /api/sell', e); }
    }

    if (!pos || !pos.buyPrice) return res.status(404).json({ error: 'No open position found for ' + symbol });

    const p        = parseFloat(price);
    const pnlPct   = ((p - pos.buyPrice) / pos.buyPrice * 100).toFixed(2);
    const realized = ((p - pos.buyPrice) * pos.qty).toFixed(4);
    totalPnL += parseFloat(realized);
    positions.delete(symbol);

    try {
        const hms = new Date().toLocaleTimeString('en-GB');
        const sellRecord = {
            sellingPoint: String(p), buyPrice: String(pos.buyPrice), pnlPct, pnlUsdt: realized,
            status: 'Y', source: 'DASHBOARD', timestamp: { time: Date.now() }, hms,
        };
        await redis.hset(SELL_KEY, symbol, JSON.stringify(sellRecord));
        await redis.hdel(BUY_KEY, symbol);
        console.log(`[Redis] SELL HSET ${symbol} @ ${p} | P&L ${pnlPct}%`);
        setTimeout(() => tick().catch(e => console.error('[Refresh]', e.message)), 100);
    } catch (e) {
        console.warn(`[Redis] SELL write failed: ${e.message}`);
    }

    const trade = { symbol, action: 'SELL', price: p, qty: pos.qty, buyPrice: pos.buyPrice, pnlPct, realizedPnL: realized, time: now(), status: 'CLOSED', simulation: false, reason: 'MANUAL' };
    tradeLog.unshift(trade);
    io.emit('trade', trade);
    res.json({ ok: true, trade });
});

app.post('/api/order/cancel', async (req, res) => {
    const { symbol, orderId } = req.body;
    console.log(`[API] POST /api/order/cancel | symbol=${symbol} orderId=${orderId}`);
    if (!symbol || !orderId) return res.status(400).json({ error: 'symbol + orderId required' });

    try {
        const url = `${SPRING_BASE}/order/cancel/${encodeURIComponent(symbol)}/${orderId}`;
        console.log(`[Engine] GET /order/cancel/${symbol}/${orderId}`);
        const sbRes = await fetch(url);
        const msg = await sbRes.text();

        if (sbRes.ok) {
            activeLimitOrders.delete(orderId);
            positions.delete(symbol);
            try { await redis.hdel(BUY_KEY, symbol); } catch (e) {}
            io.emit('order-update', { orderId, symbol, status: 'CANCELED' });
            return res.json({ ok: true, message: msg });
        } else {
            return res.status(sbRes.status).json({ error: msg });
        }
    } catch (err) {
        console.error('[Server] Cancel error:', err.message);
        res.status(500).json({ error: 'Failed to proxy cancel' });
    }
});

app.get('/api/analyze/:symbol', async (req, res) => {
    const { symbol } = req.params;
    console.log(`[API] GET /api/analyze/${symbol}`);

    try {
        const url = `${SPRING_BASE}/analyze/${encodeURIComponent(symbol)}`;
        console.log(`[Engine] GET ${url}`);
        const sbRes = await Promise.race([
            fetch(url),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
        ]);
        if (sbRes.ok) {
            const data = await sbRes.json();
            return res.json({ ok: true, source: 'engine', analysis: data });
        }
    } catch (_) { /* fall through to direct Binance */ }

    // ── Fallback: call public Binance API directly ───────────────────────────
    try {
        // Daily klines stay on REST (no historical WS equivalent). The 24h
        // ticker is read from the in-process mini-ticker cache populated by
        // binance-worker.js — one less REST call per fallback path.
        const klinesRes = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=60`);
        const klines = await klinesRes.json();

        if (!Array.isArray(klines) || klines.length < 14) {
            return res.json({ ok: false, error: 'Not enough candle data from Binance' });
        }

        // kline format: [openTime, open, high, low, close, volume, closeTime, quoteVol, ...]
        const closes    = klines.map(k => parseFloat(k[4]));
        const highs     = klines.map(k => parseFloat(k[2]));
        const lows      = klines.map(k => parseFloat(k[3]));
        const quoteVols = klines.map(k => parseFloat(k[7]));   // USDT volume

        const high2m = Math.max(...highs);
        const low2m  = Math.min(...lows);
        const avg2m  = closes.reduce((a, b) => a + b, 0) / closes.length;
        const n      = closes.length;

        const avgClose = (from, to) => {
            const sl = closes.slice(Math.max(0, from), to);
            return sl.length ? sl.reduce((a, b) => a + b, 0) / sl.length : 0;
        };

        const trend7d  = avgClose(n-14, n-7) ? ((avgClose(n-7, n) - avgClose(n-14, n-7)) / avgClose(n-14, n-7) * 100) : 0;
        const trend30d = avgClose(n-60, n-30) ? ((avgClose(n-30, n) - avgClose(n-60, n-30)) / avgClose(n-60, n-30) * 100) : 0;

        // 24h stats from the WS mini-ticker cache; cold-start fallback is
        // the latest daily candle's close + quote volume.
        const cachedTicker = binanceWorker.getTicker24h ? binanceWorker.getTicker24h(symbol) : null;
        const vol24h     = cachedTicker
            ? parseFloat(cachedTicker.quoteVolume || 0)
            : (quoteVols[n - 1] || 0);
        const vol30dAvg  = quoteVols.slice(-30).reduce((a, b) => a + b, 0) / 30;
        const vol7dAvg   = quoteVols.slice(-7).reduce((a, b) => a + b, 0) / 7;
        const volRatio   = vol30dAvg > 0 ? vol24h / vol30dAvg : 1;
        const currentPrice = cachedTicker
            ? parseFloat(cachedTicker.lastPrice || 0)
            : (closes[n - 1] || 0);
        const pricePos   = (high2m - low2m) > 0 ? ((currentPrice - low2m) / (high2m - low2m) * 100) : 50;

        // Scoring (0–7)
        let score = 0; const reasons = [];
        if (currentPrice < avg2m)  { score++; reasons.push('✅ Price below 2m avg'); }
        else                       { reasons.push('⚠️ Price above 2m avg'); }
        if (pricePos < 40)         { score++; reasons.push('✅ Lower 40% of 2m range'); }
        else if (pricePos > 80)    { reasons.push('🔴 Near 2m high (risky)'); }
        if (trend7d > 0)           { score++; reasons.push(`✅ 7d trend +${trend7d.toFixed(2)}%`); }
        else                       { reasons.push(`⚠️ 7d trend ${trend7d.toFixed(2)}%`); }
        if (trend30d > 0)          { score++; reasons.push(`✅ 30d trend +${trend30d.toFixed(2)}%`); }
        else                       { reasons.push(`⚠️ 30d trend ${trend30d.toFixed(2)}%`); }
        if (volRatio >= 1.5)       { score++; reasons.push(`✅ Volume ${volRatio.toFixed(1)}× above 30d avg`); }
        if (vol24h > vol7dAvg)     { score++; reasons.push('✅ Today volume > 7d avg'); }
        let volInc = 0;
        for (let i = n-6; i < n; i++) if (quoteVols[i] > quoteVols[i-1]) volInc++;
        if (volInc >= 3)           { score++; reasons.push(`✅ Volume rising ${volInc}/6 days`); }

        const rec = score >= 5 ? 'STRONG_BUY' : score === 4 ? 'BUY' : score === 3 ? 'NEUTRAL' : score === 2 ? 'WAIT' : 'DONT_BUY';

        const analysis = {
            symbol, currentPrice, high2m, low2m, avg2m,
            pricePosition: Math.round(pricePos * 100) / 100,
            trend7d: Math.round(trend7d * 100) / 100,
            trend30d: Math.round(trend30d * 100) / 100,
            vol24hUsdt: Math.round(vol24h),
            vol30dAvgUsdt: Math.round(vol30dAvg),
            vol7dAvgUsdt: Math.round(vol7dAvg),
            volumeRatio: Math.round(volRatio * 100) / 100,
            buyScore: score,
            recommendation: rec,
            shouldBuy: score >= 4,
            reason: reasons.join(' | '),
            daysAnalyzed: n,
        };

        let newsAnalysis = null;
        try {
            const coinName = symbol.replace('USDT', '');
            const rawNews = await redis.get(`analysis:${coinName}:detailed`);
            if (rawNews) {
                newsAnalysis = JSON.parse(rawNews);
                analysis.newsAnalysis = newsAnalysis;
            }
        } catch(e) {}

        return res.json({ ok: true, source: 'binance_direct', analysis });

    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// ─── Debug: dump all Redis keys + fast-move hashes ───────────────────────────
app.get('/api/debug/redis', async (req, res) => {
    try {
        const allKeys = await redis.keys('*');
        const keyInfo = {};
        for (const k of allKeys) {
            const type = await redis.type(k);
            if (type === 'hash') {
                const len = await redis.hlen(k);
                const fields = len <= 5 ? await redis.hgetall(k) : `(${len} fields)`;
                keyInfo[k] = { type, len, fields };
            } else if (type === 'string') {
                const val = await redis.get(k);
                keyInfo[k] = { type, val: val?.substring(0, 100) };
            } else {
                keyInfo[k] = { type };
            }
        }
        res.json({
            totalKeys: allKeys.keys,
            keys: allKeys,
            details: keyInfo,
            serverConstants: {
                FAST_MOVE_KEY, LT2MIN_KEY, UF_0_2_KEY, UF_2_3_KEY, UF_0_3_KEY,
                CURRENT_PRICE, BUY_KEY, SELL_KEY,
            },
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/trades', (req, res) => res.json({ trades: tradeLog, totalPnL }));

// iter 24: /api/virtual-scalper endpoint deleted along with the dedicated
// virtual_scalper.html page. The /monitor page now shows both Fast and
// Virtual ladder activity from a unified /api/monitor snapshot, so the
// per-engine dashboard isn't needed anymore.



// ─── Bot Manual Sell (from dashboard Bot Positions panel) ─────────────────────

/**
 * POST /api/bot/sell
 * Body: { symbol: "SOLUSDT" }
 *
 * Flow:
 *   1. Try Engine GET /api/v1/sell/{symbol}  (handles TradeState + Redis correctly)
 *   2. If Engine is unreachable, fall back to direct Redis manipulation:
 *      - Read current price from CURRENT_PRICE hash
 *      - Write a SELL record to SELL hash
 *      - Delete symbol from BUY hash
 *   3. Emit 'bot-sell' socket event so all dashboard tabs update immediately
 */
app.post('/api/bot/sell', async (req, res) => {
    const { symbol } = req.body;
    if (!symbol) return res.status(400).json({ ok: false, error: 'symbol required' });

    // ── Step 1: Try Engine sell endpoint ────────────────────────────────
    try {
        const sbRes = await Promise.race([
            fetch(`${SPRING_BASE}/sell/${encodeURIComponent(symbol)}`),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
        ]);
        if (sbRes.ok) {
            const msg = await sbRes.text();
            console.log(`[BotSell] Engine sold ${symbol}: ${msg}`);
            positions.delete(symbol);
            io.emit('bot-sell', { symbol, source: 'ENGINE' });
            return res.json({ ok: true, symbol, source: 'engine', message: msg });
        }
        console.warn(`[BotSell] Engine sell returned ${sbRes.status}, falling back to Redis`);
    } catch (e) {
        console.warn(`[BotSell] Engine unreachable (${e.message}), falling back to Redis`);
    }

    // ── Step 2: Fallback — manipulate Redis directly ─────────────────────────
    try {
        // Read buy record
        const buyRaw = await redis.hget(BUY_KEY, symbol);
        const buy    = safeJson(buyRaw);

        // Read current price
        const priceRaw  = await redis.hget(CURRENT_PRICE, symbol);
        const priceData = safeJson(priceRaw);
        const sellPrice = typeof priceData === 'object'
            ? parseFloat(priceData?.currentPrice ?? priceData?.price ?? 0)
            : parseFloat(priceData) || 0;

        const buyPrice = parseFloat(buy?.buyPrice?.value ?? buy?.buyPrice ?? 0);
        const pnlPct   = (buyPrice > 0 && sellPrice > 0)
            ? ((sellPrice - buyPrice) / buyPrice * 100)
            : 0;

        // Write sell record (plain JSON — dashboard will read it)
        const sellRecord = {
            sellingPoint: String(sellPrice),
            buyPrice:     String(buyPrice),
            buy,
            pnlPct:       pnlPct.toFixed(3),
            status:       'Y',
            source:       'MANUAL_DASHBOARD',
            timestamp:    { time: Date.now() },
        };
        await redis.hset(SELL_KEY, symbol, JSON.stringify(sellRecord));
        await redis.hdel(BUY_KEY, symbol);
        positions.delete(symbol);

        console.log(`[BotSell] Redis direct sell ${symbol} @ ${sellPrice} | P&L ${pnlPct.toFixed(3)}%`);
        io.emit('bot-sell', { symbol, sellPrice, buyPrice, pnlPct: pnlPct.toFixed(3), source: 'REDIS_FALLBACK' });
        return res.json({ ok: true, symbol, sellPrice, buyPrice, pnlPct: pnlPct.toFixed(3), source: 'redis_fallback' });

    } catch (err) {
        console.error('[BotSell] Error:', err.message);
        return res.status(500).json({ ok: false, error: err.message });
    }
});



/**
 * POST /api/redis/flush
 * Deletes ALL keys in every Redis database (FLUSHALL),
 * then disconnects and reconnects the ioredis client so
 * the polling loop resumes cleanly without a server restart.
 */
app.post('/api/redis/flush', async (req, res) => {
    try {
        await redis.flushall();
        
        // Also clear internal Node.js memory state
        positions.clear();
        tradeLog.length = 0;
        totalPnL = 0;
        activeLimitOrders.clear();
        tradeStatusMap.clear();

        console.log('[Redis] FLUSHALL executed ✅ — Internal state cleared.');

        io.emit('redis-flushed', { ts: Date.now() });
        res.json({ ok: true, message: 'All Redis keys and internal state deleted.' });
    } catch (err) {
        console.error('[Redis] Flush error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── Admin: patch one METRICS:OUTCOME entry ────────────────────────────────
// 2026-05-13 iter 17: small backfill endpoint so we can retroactively fix
// historic manual_cancel entries whose P&L was wrongly recorded as $0 (the
// bug fixed in backend iter17 _handle_external_cancel). Body fields:
//   symbol      (e.g. "NEAR/USDT")          required
//   date        (YYYY-MM-DD)                optional, defaults to today
//   exit_price  number                      optional
//   pnl_usdt    number                      optional
//   exit_reason string                      optional
app.post('/api/admin/patch-outcome', async (req, res) => {
    const { symbol, date, exit_price, pnl_usdt, exit_reason,
            filled, exited, fill_price, qty } = req.body || {};
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    const d = date || new Date().toISOString().slice(0, 10);
    const key = `METRICS:OUTCOME:${d}:${String(symbol).replace('/', '')}`;
    try {
        const existing = await redis.hgetall(key);
        if (!existing || Object.keys(existing).length === 0) {
            return res.status(404).json({ error: `no OUTCOME row at ${key}` });
        }
        const oldPnl = Number(existing.pnl_usdt || 0);
        const patch = {};
        if (exit_price  != null) patch.exit_price  = String(exit_price);
        if (pnl_usdt    != null) patch.pnl_usdt    = String(pnl_usdt);
        if (exit_reason != null) patch.exit_reason = String(exit_reason);
        // iter 34: allow flipping filled/exited + fill_price/qty so a
        // human or a cleanup script can reconcile a stuck PENDING entry
        // to its real status (CANCELLED / WIN / LOSS / FLAT).
        if (filled      != null) patch.filled      = String(filled ? 1 : 0);
        if (exited      != null) patch.exited      = String(exited ? 1 : 0);
        if (fill_price  != null) patch.fill_price  = String(fill_price);
        if (qty         != null) patch.qty         = String(qty);
        // Stamp exit_ts when transitioning to exited so the dashboard
        // shows a real timestamp instead of a missing field.
        if (exited && !existing.exit_ts) patch.exit_ts = String(Date.now());
        if (Object.keys(patch).length === 0) {
            return res.status(400).json({ error: 'nothing to patch' });
        }
        await redis.hset(key, patch);
        // Adjust DAILY:realized_pnl_usdt by the delta
        if (pnl_usdt != null) {
            const delta = Number(pnl_usdt) - oldPnl;
            try {
                await redis.hincrbyfloat(`METRICS:DAILY:${d}`, 'realized_pnl_usdt', delta);
            } catch (_) {}
        }
        console.log(`[Admin] Patched ${key}: oldPnl=${oldPnl} newPnl=${pnl_usdt} fields=${Object.keys(patch).join(',')}`);
        return res.json({ ok: true, key, oldPnl, newPnl: pnl_usdt, patch });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─── Engine Service Control ──────────────────────────────────────────────────
// Frontend route names kept as /api/service/{status,stop,start} for
// drop-in compatibility — the only thing that changes is what we spawn.

/**
 * GET /api/service/status
 * Returns { running: boolean } — checks if the engine port is answering.
 */
app.get('/api/service/status', async (req, res) => {
    try {
        const r = await Promise.race([
            fetch(`${ENGINE_BASE}/health`),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000)),
        ]);
        res.json({ running: r.ok || r.status < 500 });
    } catch {
        res.json({ running: false });
    }
});

/**
 * POST /api/service/stop
 * Calls the engine's /stop endpoint (which sends itself SIGTERM and
 * drains every async task in order), then force-kills any process we
 * spawned ourselves so we never leave orphans.
 */
app.post('/api/service/stop', async (req, res) => {
    try {
        try {
            await fetch(`${ENGINE_BASE}/stop`, { method: 'GET' });
            console.log('[Engine] /stop called ✅');
        } catch (e) {
            console.warn('[Engine] /stop unreachable (already down?):', e.message);
        }

        if (engineProc && !engineProc.killed) {
            engineProc.kill('SIGTERM');
            setTimeout(() => { if (engineProc && !engineProc.killed) engineProc.kill('SIGKILL'); }, 6000);
        }

        io.emit('service-status', { running: false });
        res.json({ ok: true, message: 'Engine stop signal sent.' });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

/**
 * POST /api/service/start
 * Spawns ``python -m booknow.main`` from python-engine/.
 * If the engine is already listening on its port, returns 409.
 *
 * Picks the interpreter in this order: $BOOKNOW_PYTHON, ./venv313/bin/python,
 * ./venv/bin/python, then plain "python3" on PATH.
 */
app.post('/api/service/start', async (req, res) => {
    // Already running?
    try {
        const probe = await Promise.race([
            fetch(`${ENGINE_BASE}/health`),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500)),
        ]);
        if (probe.ok || probe.status < 500) {
            return res.status(409).json({ ok: false, error: 'Engine is already running.' });
        }
    } catch { /* not running — proceed to start */ }

    // Pick a python interpreter we can find without making the dashboard
    // care about venv layout — same idea as Java picking up JAVA_HOME.
    const fs = require('fs');
    const repoRoot = path.resolve(__dirname, '..');
    const candidates = [
        process.env.BOOKNOW_PYTHON,
        path.join(repoRoot, 'venv313', 'bin', 'python'),
        path.join(repoRoot, 'venv', 'bin', 'python'),
        'python3',
    ].filter(Boolean);
    let python = null;
    for (const c of candidates) {
        if (c === 'python3') { python = c; break; }       // fall-through, no path check
        try { if (fs.existsSync(c)) { python = c; break; } } catch { /* ignore */ }
    }
    if (!python) {
        return res.status(500).json({
            ok: false,
            error: 'No python interpreter found. Set BOOKNOW_PYTHON or create venv313/.',
        });
    }

    try {
        engineProc = spawn(python, ['-m', 'booknow.main'], {
            cwd: ENGINE_DIR,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, PYTHONUNBUFFERED: '1' },
        });

        engineProc.stdout.on('data', c => process.stdout.write('[Engine] ' + c));
        engineProc.stderr.on('data', c => process.stderr.write('[Engine] ' + c));
        engineProc.on('exit', (code, sig) => {
            console.log(`[Engine] Process exited code=${code} sig=${sig}`);
            engineProc = null;
            io.emit('service-status', { running: false });
        });
        engineProc.on('error', err => {
            console.error('[Engine] Spawn error:', err.message);
            engineProc = null;
        });

        // Give it a moment to fail fast (bad cwd / wrong python).
        await new Promise(r => setTimeout(r, 700));
        if (!engineProc || engineProc.killed) {
            return res.status(500).json({
                ok: false,
                error: `Engine failed to start. Is ${python} valid and python-engine/ present?`,
            });
        }

        io.emit('service-status', { running: true, pid: engineProc.pid });
        console.log('[Engine] Started ✅ pid:', engineProc.pid, 'python:', python);
        res.json({ ok: true, message: 'Engine starting…', pid: engineProc.pid });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── Socket ───────────────────────────────────────────────────────────────────
io.on('connection', async socket => {
    console.log('[WS] Client:', socket.id);
    socket.emit('config', autoConfig);
    socket.emit('trades', { trades: tradeLog, totalPnL });
    socket.on('disconnect', () => console.log('[WS] Disconnected:', socket.id));
});

// ─── Start ───────────────────────────────────────────────────────────────────
redis.connect().catch(() => { });
redisAnalyse.connect().catch(() => { });

// iter 17 fe (2026-05-15): Pattern Bot worker
const patternBot = require('./pattern-bot-worker');

// iter 24 fe (2026-05-16): Pending-order auto-cancel worker
const pendingAutoCancel = require('./pending-monitor-worker');

// iter 25 fe (2026-05-16): Cancel-recovery worker
const pendingRecovery = require('./pending-recovery-worker');

server.listen(PORT, () => {
    console.log(`\n🚀 BookNow Fast Dashboard → http://localhost:${PORT}`);
    console.log(`📡 Polling Redis every ${POLL_MS}ms\n`);

    // Start pattern bot 5s after server boot (gives Redis time to connect)
    setTimeout(() => {
        try {
            patternBot.start({ redis, redisAnalyse, port: PORT });
        } catch (e) {
            console.error('[pattern-bot] failed to start:', e.message);
        }
    }, 5000);

    // Start auto-cancel worker 6s after boot — runs even when disabled in
    // config (it short-circuits inside pollOnce), so status is always live.
    setTimeout(() => {
        try {
            pendingAutoCancel.start({ redis, port: PORT });
        } catch (e) {
            console.error('[auto-cancel] failed to start:', e.message);
        }
    }, 6000);

    // Start recovery worker 7s after boot
    setTimeout(() => {
        try {
            pendingRecovery.start({ redis, port: PORT });
        } catch (e) {
            console.error('[recovery] failed to start:', e.message);
        }
    }, 7000);
});
