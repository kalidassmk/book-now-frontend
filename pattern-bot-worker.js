/*
 * pattern-bot-worker.js (iter 17 fe, 2026-05-15)
 * ───────────────────────────────────────────────────────────────────────
 * Third auto-trader for the Book-Now stack, alongside Fast Scalper and
 * Virtual Scalper. Driven by the Bounce Watch + Early Pump pattern
 * detectors logged to BOUNCE:DETECTIONS / EARLY_PUMP:DETECTIONS.
 *
 * Architecture:
 *   ─ Polls detections every 10s.
 *   ─ For each new high-score detection that's < 60s old, runs the
 *     same 5 pre-buy safety filters Fast Scalper uses (via the
 *     /api/check-coin endpoint) plus pattern-specific gates.
 *   ─ If all pass:
 *       • paperMode=true  → log a paper trade to PATTERN_BOT:PAPER_TRADES
 *       • paperMode=false → place a real LIMIT order via Binance
 *   ─ For each open trade (paper or real), polls 1m klines every 30s
 *     and checks TP (+0.567% = $0.15 net) / stop (-1.5%) / timeout (4h).
 *
 * Trade flow:
 *   detection → safety check → place LIMIT @ -0.15% (60s timeout if not
 *   filled) → on fill, monitor for TP/stop/timeout → log outcome.
 *
 * All state in Redis:
 *   PATTERN_BOT:OPEN          hash sym → trade JSON  (single concurrent slot)
 *   PATTERN_BOT:PAPER_TRADES:<date>  list of completed paper trades
 *   PATTERN_BOT:LIVE_TRADES:<date>   list of completed live trades
 *   PATTERN_BOT:STATUS        hash (last_poll_ts, last_eval_count, errors)
 */

const CONFIG_KEY = 'TRADING_CONFIG';
const POLL_INTERVAL_MS = 10 * 1000;
const POSITION_CHECK_INTERVAL_MS = 30 * 1000;
const LEG_SIZE_USDT = 48;
const FEE_RATE = 0.00075;
const TP_PCT = 0.567;   // matches iter43 strategy + iter42 $0.15 net
const ENTRY_OFFSET_PCT = 0.15;
const ENTRY_FILL_TIMEOUT_SEC = 60;

let _redis, _redisAnalyse, _binanceFetch;
let _running = false;

async function loadConfig() {
    try {
        const raw = await _redis.get(CONFIG_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) {
        console.error('[pattern-bot] config load failed:', e.message);
        return null;
    }
}

async function fetchKlines1m(binanceSym, limit = 30) {
    try {
        const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${binanceSym}&interval=1m&limit=${limit}`);
        if (!r.ok) return null;
        return await r.json();
    } catch (_) { return null; }
}

async function runSafetyCheck(symbol, port) {
    // Calls our own /api/check-coin endpoint to reuse the 5-filter
    // pipeline. Localhost is the cheapest hop.
    try {
        const r = await fetch(`http://127.0.0.1:${port}/api/check-coin?symbol=${encodeURIComponent(symbol)}`);
        if (!r.ok) return { ok: false, reason: `check-coin ${r.status}` };
        const data = await r.json();
        if (data.verdict?.blocked) {
            return { ok: false, reason: `${data.verdict.blocker}: ${data.verdict.blocker_reason}` };
        }
        return { ok: true, market: data.market };
    } catch (e) {
        return { ok: false, reason: `check-coin error: ${e.message}` };
    }
}

async function fetchLatestDetections(cfg) {
    const date = new Date().toISOString().slice(0, 10);
    const events = [];
    if (cfg.patternBotAlgo === 'bounce' || cfg.patternBotAlgo === 'both') {
        const raw = await _redis.lrange(`BOUNCE:DETECTIONS:${date}`, 0, 20);
        for (const r of raw) {
            try { const ev = JSON.parse(r); ev._source = 'bounce'; events.push(ev); } catch (_) {}
        }
    }
    if (cfg.patternBotAlgo === 'early_pump' || cfg.patternBotAlgo === 'both') {
        const raw = await _redisAnalyse.lrange(`EARLY_PUMP:DETECTIONS:${date}`, 0, 20);
        for (const r of raw) {
            try { const ev = JSON.parse(r); ev._source = 'early_pump'; events.push(ev); } catch (_) {}
        }
    }
    return events;
}

async function getProcessedSet() {
    const ids = await _redis.smembers('PATTERN_BOT:PROCESSED');
    return new Set(ids);
}
async function markProcessed(id) {
    await _redis.sadd('PATTERN_BOT:PROCESSED', id);
    await _redis.expire('PATTERN_BOT:PROCESSED', 24 * 60 * 60);
}

async function pollerCycle(port) {
    const cfg = await loadConfig();
    if (!cfg) return;
    if (!cfg.patternBotEnabled) return;

    const now = Date.now();
    const events = await fetchLatestDetections(cfg);
    const processed = await getProcessedSet();
    const minScore = cfg.patternBotMinScore ?? 70;
    const maxFreshSec = cfg.patternBotMaxFreshSec ?? 60;
    let evaluated = 0, executed = 0;

    // Check if pattern bot slot is taken (single coin lock across all bots)
    const fastActive = await _redis.hlen('SCALPER:LADDER_STATES');
    const virtualActive = await _redis.hlen('VIRTUAL:LADDER_STATES');
    const patternOpen = await _redis.hlen('PATTERN_BOT:OPEN');
    const totalSlots = fastActive + virtualActive + patternOpen;
    const slotAvailable = totalSlots < (cfg.maxConcurrentLadders ?? 1);

    for (const ev of events) {
        const id = `${ev._source}:${ev.symbol}:${ev.ts}`;
        if (processed.has(id)) continue;

        const ageSec = (now - ev.ts) / 1000;
        if (ageSec > maxFreshSec) {
            await markProcessed(id);
            continue;
        }
        if (ev.score < minScore) {
            await markProcessed(id);
            continue;
        }

        evaluated++;

        if (!slotAvailable) {
            console.log(`[pattern-bot] ${ev.symbol} score=${ev.score} age=${ageSec.toFixed(0)}s → SKIP (slot taken: fast=${fastActive} virtual=${virtualActive} pattern=${patternOpen})`);
            await markProcessed(id);
            continue;
        }

        // Run safety check
        const safety = await runSafetyCheck(ev.symbol, port);
        if (!safety.ok) {
            console.log(`[pattern-bot] ${ev.symbol} score=${ev.score} → SAFETY BLOCK (${safety.reason})`);
            await markProcessed(id);
            await _redis.lpush('PATTERN_BOT:SKIPS:' + new Date().toISOString().slice(0,10),
                JSON.stringify({ ts: now, symbol: ev.symbol, score: ev.score, source: ev._source, reason: safety.reason }));
            continue;
        }

        // ALL CHECKS PASSED → execute (paper or live)
        const buyPrice = +(safety.market.last_price * (1 - ENTRY_OFFSET_PCT / 100)).toFixed(8);
        const tpPrice  = +(buyPrice * (1 + TP_PCT / 100)).toFixed(8);
        const stopPct  = cfg.patternBotStopPct ?? 1.5;
        const stopPrice= +(buyPrice * (1 - stopPct / 100)).toFixed(8);
        const qty      = +(LEG_SIZE_USDT / buyPrice).toFixed(8);

        const trade = {
            id,
            symbol: ev.symbol,
            source: ev._source,
            detection_score: ev.score,
            detection_ts: ev.ts,
            opened_ts: now,
            mode: cfg.patternBotPaperMode ? 'paper' : 'live',
            entry_offset_pct: ENTRY_OFFSET_PCT,
            buy_price: buyPrice,
            qty,
            tp_price: tpPrice,
            stop_price: stopPrice,
            tp_pct: TP_PCT,
            stop_pct: stopPct,
            timeout_min: cfg.patternBotTimeoutMin ?? 240,
            status: 'open',
            factors_at_entry: ev.factors,
            market_at_entry: safety.market,
        };

        if (cfg.patternBotPaperMode) {
            // Just log it
            await _redis.hset('PATTERN_BOT:OPEN', ev.symbol, JSON.stringify(trade));
            await _redis.expire('PATTERN_BOT:OPEN', 6 * 60 * 60);  // 6h safety expiry
            console.log(`[pattern-bot] 📝 PAPER OPEN ${ev.symbol} score=${ev.score} @ \$${buyPrice} TP=\$${tpPrice} stop=\$${stopPrice}`);
            executed++;
        } else {
            // TODO: real Binance order placement
            console.log(`[pattern-bot] ⚠️ live mode not yet implemented — flip patternBotPaperMode=true for now`);
        }

        await markProcessed(id);
    }

    // Update status
    await _redis.hset('PATTERN_BOT:STATUS',
        'last_poll_ts', now,
        'last_eval_count', evaluated,
        'last_executed', executed,
        'pattern_open', patternOpen,
        'slot_available', slotAvailable ? '1' : '0',
        'paper_mode', cfg.patternBotPaperMode ? '1' : '0',
        'algo', cfg.patternBotAlgo,
    );
}

async function checkOpenPositions() {
    const open = await _redis.hgetall('PATTERN_BOT:OPEN');
    if (!open || Object.keys(open).length === 0) return;

    for (const [sym, raw] of Object.entries(open)) {
        let trade;
        try { trade = JSON.parse(raw); } catch (_) { continue; }
        if (trade.status !== 'open') continue;

        // Fetch latest 1m kline
        const klines = await fetchKlines1m(sym, 1);
        if (!klines || !klines.length) continue;
        const k = klines[klines.length - 1];
        const high = parseFloat(k[2]);
        const low = parseFloat(k[3]);
        const close = parseFloat(k[4]);

        const now = Date.now();
        const ageMin = (now - trade.opened_ts) / 60000;

        let outcome = null, exit_price = null;
        if (high >= trade.tp_price) {
            outcome = 'tp_hit';
            exit_price = trade.tp_price;
        } else if (low <= trade.stop_price) {
            outcome = 'stop_loss';
            exit_price = trade.stop_price;
        } else if (ageMin >= trade.timeout_min) {
            outcome = 'timeout';
            exit_price = close;
        }

        if (outcome) {
            const grossPnl = (exit_price - trade.buy_price) * trade.qty;
            const fees = 2 * FEE_RATE * LEG_SIZE_USDT;
            const netPnl = grossPnl - fees;
            const closed = {
                ...trade,
                status: 'closed',
                outcome,
                exit_price,
                exit_ts: now,
                hold_minutes: +ageMin.toFixed(1),
                gross_pnl: +grossPnl.toFixed(4),
                net_pnl: +netPnl.toFixed(4),
            };
            const date = new Date().toISOString().slice(0, 10);
            const listKey = trade.mode === 'paper'
                ? `PATTERN_BOT:PAPER_TRADES:${date}`
                : `PATTERN_BOT:LIVE_TRADES:${date}`;
            await _redis.lpush(listKey, JSON.stringify(closed));
            await _redis.ltrim(listKey, 0, 999);
            await _redis.expire(listKey, 30 * 24 * 60 * 60);   // 30 days
            await _redis.hdel('PATTERN_BOT:OPEN', sym);
            const emoji = outcome === 'tp_hit' ? '✅' : outcome === 'stop_loss' ? '🛑' : '⏱';
            console.log(`[pattern-bot] ${emoji} CLOSE ${sym} ${outcome} @ \$${exit_price} net=\$${netPnl.toFixed(4)} (${ageMin.toFixed(0)}m)`);
        }
    }
}

function start({ redis, redisAnalyse, port }) {
    if (_running) return;
    _running = true;
    _redis = redis;
    _redisAnalyse = redisAnalyse;

    console.log('[pattern-bot] worker starting…');
    // Poll detections
    setInterval(() => {
        pollerCycle(port).catch(e => console.error('[pattern-bot] poll error:', e.message));
    }, POLL_INTERVAL_MS);
    // Monitor open positions
    setInterval(() => {
        checkOpenPositions().catch(e => console.error('[pattern-bot] position check error:', e.message));
    }, POSITION_CHECK_INTERVAL_MS);
}

module.exports = { start };
