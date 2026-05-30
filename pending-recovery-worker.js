/*
 * pending-recovery-worker.js (iter 25 fe, 2026-05-16)
 * ───────────────────────────────────────────────────────────────────────
 * Rescues orders that the Python scalper cancelled too early.
 *
 * User story (the RENDER incident):
 *   Buy 1 LIMIT @ $1.892 was placed. Price peaked at $1.903 (+0.26%) then
 *   pulled back. The Python scalper's pending_pump_dump_cancel logic
 *   triggered at 23:57:10 UTC because the −0.58% pullback from peak crossed
 *   its 0.5% threshold. But that pullback was heading STRAIGHT TO OUR
 *   LIMIT — the very minute the bot cancelled, the candle low printed at
 *   exactly $1.892 (the limit price). Order would have filled within
 *   seconds. Instead the bot cancelled, and now we sit in a 3h cooldown.
 *
 *   "if coin is not down much deeper then buy 1 price then we can buy that
 *    coin, kindly implement better way"
 *
 * Architecture:
 *   ─ Polls OUTCOME records every 20s looking for fresh cancels (exit_ts
 *     in the last 5 min) with exit_reason in RECOVERABLE_REASONS.
 *   ─ For each candidate, evaluates 4 gates:
 *       G1 closest-approach   price came ≤ minTouchPct of limit during wait
 *       G2 current-still-good current price ≤ maxAbovePct above limit
 *       G3 eligibility        Adaptive Gate is GREEN or YELLOW (not RED)
 *       G4 quota + cooldown   per-hour + per-symbol guards
 *   ─ When all 4 pass:
 *       paperMode=true  → log paper-recover, don't hit Binance
 *       paperMode=false → POST /api/buy with a LIMIT at
 *                         min(currentPrice, originalLimitPrice).
 *       The Spring engine processes the re-issue; the Python scalper's
 *       overaggressive cancel logic doesn't see it (different code path),
 *       so the same false-positive can't fire twice on the same recovery.
 *
 * Redis state:
 *   PENDING_RECOVERY:LOG               list of audit entries (JSON, 200)
 *   PENDING_RECOVERY:STATUS            hash
 *   PENDING_RECOVERY:COOLDOWN:<sym>    TTL key, 30 min
 *   PENDING_RECOVERY:HOUR_BUCKET:<ts>  TTL key, 1h — per-hour quota
 *   PENDING_RECOVERY:HANDLED:<sym>:<ts>  TTL key, 1h — idempotency guard
 *                                       (don't re-process the same OUTCOME)
 */

const CONFIG_KEY = 'TRADING_CONFIG';
const POLL_INTERVAL_MS = 20 * 1000;

// Cancel reasons that the Python scalper produces which are often premature.
// pending_pump_dump_cancel = the bot saw a "dump from peak" but the dump
// was really just the pullback toward our limit. Most common false positive.
// manual_cancel = could be user OR the iter24 auto-cancel worker.
const RECOVERABLE_REASONS = new Set([
    'pending_pump_dump_cancel',
    'manual_cancel',
]);

const DEFAULTS = {
    enabled: false,
    paperMode: true,
    minTouchPct: 0.20,         // price came within 0.20% of limit while waiting
    maxAbovePct: 0.30,         // current price at most 0.30% above limit now
    windowSec: 300,            // only recover cancels in last 5 min
    maxPerHour: 3,             // recovery is risky — strict ceiling
    cooldownSec: 1800,         // 30 min symbol cooldown after recovery
    logRetention: 200,
};

let _redis, _port;
let _running = false;

function loadConfig() {
    return _redis.get(CONFIG_KEY).then(raw => {
        const cfg = raw ? JSON.parse(raw) : {};
        return {
            enabled: cfg.pendingRecoveryEnabled ?? DEFAULTS.enabled,
            paperMode: cfg.pendingRecoveryPaperMode ?? DEFAULTS.paperMode,
            minTouchPct: cfg.pendingRecoveryMinTouchPct ?? DEFAULTS.minTouchPct,
            maxAbovePct: cfg.pendingRecoveryMaxAbovePct ?? DEFAULTS.maxAbovePct,
            windowSec: cfg.pendingRecoveryWindowSec ?? DEFAULTS.windowSec,
            maxPerHour: cfg.pendingRecoveryMaxPerHour ?? DEFAULTS.maxPerHour,
            cooldownSec: cfg.pendingRecoveryCooldownSec ?? DEFAULTS.cooldownSec,
        };
    }).catch(() => ({ ...DEFAULTS }));
}

async function setStatus(patch) {
    const flat = {};
    for (const [k, v] of Object.entries(patch)) flat[k] = String(v);
    if (Object.keys(flat).length) {
        await _redis.hset('PENDING_RECOVERY:STATUS', flat).catch(() => {});
    }
}

function stripNp(s) {
    return parseFloat(String(s || '').replace(/np\.float64\(/, '').replace(/\)$/, ''));
}

async function fetchKlines(binanceSym, startMs, endMs) {
    try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${binanceSym}&interval=1m&startTime=${startMs}&endTime=${endMs}&limit=500`;
        const r = await fetch(url);
        if (!r.ok) return null;
        return await r.json();
    } catch (_) { return null; }
}

async function getTickerPrice(binanceSym) {
    try {
        const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${binanceSym}`);
        if (!r.ok) return null;
        const j = await r.json();
        return j && j.price ? parseFloat(j.price) : null;
    } catch (_) { return null; }
}

async function consumeQuota(maxPerHour) {
    const bucket = Math.floor(Date.now() / 3600000);
    const key = `PENDING_RECOVERY:HOUR_BUCKET:${bucket}`;
    const count = await _redis.incr(key);
    if (count === 1) await _redis.expire(key, 3600);
    return { used: count, limit: maxPerHour, ok: count <= maxPerHour };
}

async function logAction(entry) {
    try {
        await _redis.lpush('PENDING_RECOVERY:LOG', JSON.stringify(entry));
        await _redis.ltrim('PENDING_RECOVERY:LOG', 0, DEFAULTS.logRetention - 1);
        await _redis.expire('PENDING_RECOVERY:LOG', 7 * 24 * 60 * 60);
    } catch (e) {
        console.error('[recovery] log failed:', e.message);
    }
}

async function checkEligibility(symbol) {
    try {
        const r = await fetch(`http://127.0.0.1:${_port}/api/adaptive-eligibility?symbol=${encodeURIComponent(symbol)}`);
        if (!r.ok) return { level: 'UNKNOWN', error: `eligibility ${r.status}` };
        const j = await r.json();
        return { level: j.eligibility?.level || 'UNKNOWN', headline: j.eligibility?.headline };
    } catch (e) {
        return { level: 'UNKNOWN', error: e.message };
    }
}

async function placeRecoveryBuy(symbol, limitPrice, qty) {
    const r = await fetch(`http://127.0.0.1:${_port}/api/buy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, price: limitPrice, qty }),
    });
    const j = await r.json().catch(() => null);
    return { ok: r.ok && j && j.ok, body: j, status: r.status };
}

// Pull all OUTCOME records for today + yesterday and filter to fresh,
// recoverable cancels we haven't already handled.
async function findCandidates(cfg) {
    const now = Date.now();
    const windowMs = cfg.windowSec * 1000;
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(now - 86400000).toISOString().slice(0, 10);
    const candidates = [];

    for (const date of [today, yesterday]) {
        const stream = _redis.scanStream({ match: `METRICS:OUTCOME:${date}:*`, count: 100 });
        const keys = [];
        stream.on('data', (b) => keys.push(...b));
        await new Promise(r => stream.on('end', r));
        for (const k of keys) {
            const o = await _redis.hgetall(k);
            if (!o || !o.symbol) continue;
            if (parseInt(o.filled || '0', 10) !== 0) continue;
            if (parseInt(o.exited || '0', 10) !== 1) continue;
            const reason = (o.exit_reason || '').trim();
            if (!RECOVERABLE_REASONS.has(reason)) continue;
            const exit_ts = parseInt(o.exit_ts || '0', 10);
            if (!exit_ts || (now - exit_ts) > windowMs) continue;

            const signal_price = stripNp(o.signal_price);
            const limit_price = parseFloat(o.buy_1_limit_price);
            const signal_ts = parseInt(o.buy_ts, 10);
            const size_usdt = parseFloat(o.size_usdt || '48');
            if (!signal_price || !limit_price || !signal_ts) continue;

            // Idempotency: only process each OUTCOME once per hour.
            const handledKey = `PENDING_RECOVERY:HANDLED:${o.symbol.replace('/', '')}:${signal_ts}`;
            if (await _redis.exists(handledKey) === 1) continue;

            candidates.push({
                date,
                symbol: o.symbol,
                signal_price,
                limit_price,
                signal_ts,
                exit_ts,
                exit_reason: reason,
                size_usdt,
                offset_pct: parseFloat(o.offset_pct || '0'),
                handledKey,
                origin: o.scalper_origin || null,
            });
        }
    }
    candidates.sort((a, b) => b.exit_ts - a.exit_ts);
    return candidates;
}

async function evaluateCandidate(c, cfg) {
    const binanceSym = c.symbol.replace('/', '');
    const audit = {
        ts: Date.now(),
        symbol: c.symbol, binanceSym,
        exit_reason: c.exit_reason,
        signal_price: c.signal_price,
        limit_price: c.limit_price,
        signal_ts: c.signal_ts,
        exit_ts: c.exit_ts,
        sec_since_cancel: Math.round((Date.now() - c.exit_ts) / 1000),
    };

    // Gate G1: closest approach during the order's lifetime
    const klines = await fetchKlines(binanceSym, c.signal_ts - 60000, c.exit_ts + 60000);
    let minLow = Infinity;
    if (klines && klines.length) {
        for (const k of klines) {
            const low = parseFloat(k[3]);
            if (low < minLow) minLow = low;
        }
    }
    if (minLow === Infinity) {
        audit.outcome = 'skip_no_klines';
        return { audit, eligible: false };
    }
    // closest_approach_pct: positive means price reached BELOW limit, negative means stayed above
    const closestApproachPct = (c.limit_price - minLow) / c.limit_price * 100;
    audit.min_low = +minLow.toFixed(10);
    audit.closest_approach_pct = +closestApproachPct.toFixed(4);

    // Gate G2: current price still in recoverable zone
    const currentPrice = await getTickerPrice(binanceSym);
    if (!currentPrice) {
        audit.outcome = 'skip_no_ticker';
        return { audit, eligible: false };
    }
    const currentVsLimitPct = (currentPrice - c.limit_price) / c.limit_price * 100;
    audit.current_price = +currentPrice.toFixed(10);
    audit.current_vs_limit_pct = +currentVsLimitPct.toFixed(4);

    // The "near miss" check: G1 = price came within minTouchPct of limit
    // (positive closestApproachPct means it actually hit or went below).
    const g1Pass = closestApproachPct >= -cfg.minTouchPct;
    audit.g1_pass = g1Pass;
    audit.g1_threshold = -cfg.minTouchPct;

    // G2: current price not too far above limit (chase still affordable)
    const g2Pass = currentVsLimitPct <= cfg.maxAbovePct;
    audit.g2_pass = g2Pass;
    audit.g2_threshold = cfg.maxAbovePct;

    if (!g1Pass || !g2Pass) {
        audit.outcome = !g1Pass ? 'skip_no_near_miss' : 'skip_too_far_above';
        return { audit, eligible: false };
    }

    // Gate G3: still safe per Adaptive Gate
    const elig = await checkEligibility(c.symbol);
    audit.eligibility_level = elig.level;
    audit.eligibility_headline = elig.headline;
    if (elig.level === 'RED') {
        audit.outcome = 'skip_eligibility_red';
        return { audit, eligible: false };
    }

    // G4 (cooldown) handled here, quota handled at action time
    const cdKey = `PENDING_RECOVERY:COOLDOWN:${binanceSym}`;
    if (await _redis.exists(cdKey) === 1) {
        audit.outcome = 'skip_cooldown';
        audit.cooldown_ttl_sec = await _redis.ttl(cdKey);
        return { audit, eligible: false };
    }

    return { audit, eligible: true, currentPrice, binanceSym };
}

async function pollOnce() {
    const cfg = await loadConfig();
    await setStatus({
        last_poll_ts: Date.now(),
        enabled: cfg.enabled ? 1 : 0,
        paper_mode: cfg.paperMode ? 1 : 0,
    });

    if (!cfg.enabled) return;

    let candidates;
    try {
        candidates = await findCandidates(cfg);
    } catch (e) {
        await setStatus({ last_error: e.message });
        return;
    }
    await setStatus({ last_candidates: candidates.length });

    let actions = 0;
    for (const c of candidates) {
        const { audit, eligible, currentPrice, binanceSym } = await evaluateCandidate(c, cfg);

        if (!eligible) {
            // Mark handled so we don't re-evaluate (1h TTL)
            await _redis.set(c.handledKey, '1', 'EX', 3600);
            await logAction(audit);
            continue;
        }

        // Quota check (atomic INCR)
        const quota = await consumeQuota(cfg.maxPerHour);
        if (!quota.ok) {
            audit.outcome = 'skip_quota_exhausted';
            audit.quota_used = quota.used;
            audit.quota_limit = quota.limit;
            await logAction(audit);
            await setStatus({ last_error: `quota exhausted ${quota.used}/${quota.limit}` });
            break;
        }

        // Compute re-issue price: chase to current if it's at/above limit,
        // else use original limit (price has dropped further — buy at limit).
        const recoveryPrice = +Math.min(currentPrice, c.limit_price).toFixed(8);
        const qty = +(c.size_usdt / recoveryPrice).toFixed(6);
        audit.recovery_price = recoveryPrice;
        audit.recovery_qty = qty;
        audit.mode = cfg.paperMode ? 'paper' : 'live';
        audit.quota_used = quota.used;

        if (cfg.paperMode) {
            audit.outcome = 'paper_recovered';
            console.log(`[recovery] 📝 PAPER ${c.symbol} would re-issue LIMIT @ $${recoveryPrice} (size $${c.size_usdt}, qty ${qty}) — limit ${c.limit_price}, min low ${audit.min_low}, current ${currentPrice}`);
        } else {
            try {
                const res = await placeRecoveryBuy(c.symbol, recoveryPrice, qty);
                audit.outcome = res.ok ? 'recovered' : 'recovery_failed';
                audit.detail = res.body;
                if (res.ok) {
                    console.log(`[recovery] ✓ LIVE ${c.symbol} re-issued @ $${recoveryPrice} (orderId ${res.body?.orderId})`);
                } else {
                    console.error(`[recovery] re-issue failed ${c.symbol}:`, res.body);
                }
            } catch (e) {
                audit.outcome = 'error';
                audit.detail = e.message;
                console.error(`[recovery] error ${c.symbol}:`, e.message);
            }
        }

        // Set cooldown + idempotency + audit
        await _redis.set(`PENDING_RECOVERY:COOLDOWN:${binanceSym}`, '1', 'EX', cfg.cooldownSec);
        await _redis.set(c.handledKey, '1', 'EX', 3600);
        await logAction(audit);
        await setStatus({ last_action_ts: Date.now() });
        actions++;
    }
    await setStatus({ last_recover_count: actions });
}

function start({ redis, port }) {
    if (_running) return;
    _running = true;
    _redis = redis;
    _port = port;

    console.log('[recovery] worker starting…');
    setInterval(() => {
        pollOnce().catch(e => {
            console.error('[recovery] poll error:', e.message);
            setStatus({ last_error: e.message }).catch(() => {});
        });
    }, POLL_INTERVAL_MS);
}

module.exports = { start };
