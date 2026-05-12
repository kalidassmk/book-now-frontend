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
            buyAmount: config.buyAmountUsdt || 50,
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
    // 2026-05-12 iter 12: $50/leg, 2-leg ladder (Buy 3 off).
    buyAmountUsdt: 50.0,
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
    ladderBuy1SizeUsdt: 50.0,
    ladderBuy2SizeUsdt: 50.0,
    ladderBuy3SizeUsdt: 0.0,
    ladderBuy2OffsetPct: 0.5,
    ladderBuy3OffsetPct: 1.0,
    ladderTpFromAvgPct: 0.6,
    // 2026-05-11 iter 8: dollar-target wins when set; TP auto-computed.
    ladderTargetNetProfitUsdt: 0.15,
    ladderFeeRatePerSide: 0.00075,  // 0.075 % (BNB-fees ON); set to 0.001 if OFF
    ladderHardStopBelowBuy3Pct: 1.0,
    ladderBuy1UseMarketOrder: true,
    ladderBuy1OffsetPct: 0.15,        // 0 = market; >0 = LIMIT at signal × (1-X%) — iter 12 default
    ladderCooldownSeconds: 14400,    // 4h per-coin cooldown after a ladder closes
    metricsEnabled: true,
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

/**
 * GET /api/virtual-scalper
 * One-shot snapshot of the Virtual Scalper subprocess's open positions
 * and trade history. The page calls this on first load; live updates
 * piggy-back on the regular `update` Socket.io event.
 *
 * Returns:
 *   { open: [...], history: [...], summary: { ... }, prices: {symbol → price} }
 */
app.get('/api/virtual-scalper', async (req, res) => {
    try {
        // Open positions (hash, symbol → JSON).
        const openMap = await redis.hgetall(VIRTUAL_POSITIONS);
        const open = Object.values(openMap).map(j => {
            try { return JSON.parse(j); } catch { return null; }
        }).filter(Boolean);

        // History (list, JSON, newest first).
        const histRaw = await redis.lrange(VIRTUAL_HISTORY, 0, -1);
        const history = histRaw.map(j => {
            try { return JSON.parse(j); } catch { return null; }
        }).filter(Boolean);

        // Live prices for open positions so the UI can show unrealised PnL
        // without round-tripping back to the server. Match the same key
        // shape the scanner uses (CURRENT_PRICE hash, JSON value w/ price).
        const priceRaw = await redis.hgetall(CURRENT_PRICE);
        const prices = {};
        for (const [sym, j] of Object.entries(priceRaw || {})) {
            try {
                const cp = JSON.parse(j);
                if (cp && cp.price != null) prices[sym] = parseFloat(cp.price);
            } catch { /* ignore unparseable rows */ }
        }

        // Summary stats from history.
        const closed = history.length;
        const wins   = history.filter(h => (h.pnl_usdt || 0) > 0).length;
        const losses = history.filter(h => (h.pnl_usdt || 0) < 0).length;
        const totalPnl = history.reduce((s, h) => s + (h.pnl_usdt || 0), 0);
        const totalFees = history.reduce((s, h) => s + (h.fees_paid || 0), 0);
        const best  = history.reduce((b, h) => (h.pnl_usdt > (b?.pnl_usdt ?? -Infinity)) ? h : b, null);
        const worst = history.reduce((w, h) => (h.pnl_usdt < (w?.pnl_usdt ??  Infinity)) ? h : w, null);
        const avgHold = closed
            ? history.reduce((s, h) => s + (h.hold_duration || 0), 0) / closed
            : 0;

        // Reason breakdown: how many times each exit fired.
        const reasons = {};
        for (const h of history) {
            const r = h.reason || 'UNKNOWN';
            reasons[r] = (reasons[r] || 0) + 1;
        }

        res.json({
            open,
            history,
            prices,
            summary: {
                openCount: open.length,
                closedCount: closed,
                wins,
                losses,
                winRate: closed ? wins / closed : 0,
                totalPnl,
                totalFees,
                avgPnl: closed ? totalPnl / closed : 0,
                avgHoldSeconds: avgHold,
                best,
                worst,
                reasons,
            },
        });
    } catch (err) {
        console.error('[/api/virtual-scalper]', err.message);
        res.status(500).json({ error: err.message });
    }
});



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
server.listen(PORT, () => {
    console.log(`\n🚀 BookNow Fast Dashboard → http://localhost:${PORT}`);
    console.log(`📡 Polling Redis every ${POLL_MS}ms\n`);
});
