/*
 * pending-monitor-worker.js (iter 24 fe, 2026-05-16)
 * ───────────────────────────────────────────────────────────────────────
 * Auto-cancels stale / failing Buy 1 LIMIT orders so the operator does
 * not have to babysit the bot. Driven by the same classifier exposed at
 * /api/pending-buy-analysis and /api/pending-orders.
 *
 * User story (the ZAMA incident):
 *   "i need to avoid manual cancel button, because bot need to take
 *    decision because some time i will be busy so i can not monitor every
 *    time. kindly implement it"
 *
 * Architecture:
 *   ─ Polls every 30s.
 *   ─ Hits its own /api/pending-orders to get the live list with the
 *     classifier already applied.
 *   ─ For each order whose action == CANCEL AND classification is in the
 *     auto-cancel whitelist, applies safety rules:
 *       • age >= staleMin + 1 min
 *       • symbol not in recent-cancel cooldown (5 min)
 *       • per-hour cancel quota not exhausted
 *     If all pass:
 *       • paperMode=true  → log paper-cancel, do NOT call Binance
 *       • paperMode=false → hit /api/open-orders/cancel internally
 *   ─ Every action (paper or live) appended to PENDING_AUTO_CANCEL:LOG
 *     for audit. Last 200 entries retained.
 *
 * Kill switch: pendingAutoCancelEnabled in TRADING_CONFIG (default false).
 *
 * Redis state:
 *   PENDING_AUTO_CANCEL:LOG          list of audit entries (JSON)
 *   PENDING_AUTO_CANCEL:STATUS       hash (last_poll_ts, last_run_count,
 *                                          last_action_ts, last_error)
 *   PENDING_AUTO_CANCEL:COOLDOWN:<sym>  TTL key, 5 min
 *   PENDING_AUTO_CANCEL:HOUR_BUCKET:<ts> TTL key, 1 hour — used as quota
 */

const CONFIG_KEY = 'TRADING_CONFIG';
const POLL_INTERVAL_MS = 30 * 1000;

// Auto-cancel these classifications. Operator explicitly requested full
// autonomy ("no manual intervention"), so DRIFTED_REPRICE is included —
// the cancel frees the slot for a fresher signal. The iter25 recovery
// worker guards against false-positive cancels (won't re-issue if price
// has drifted above the limit zone). Together they cover the spectrum.
const AUTO_CANCEL_CLASSIFICATIONS = new Set([
    'MISSED_BOAT',
    'PUMP_AND_DUMP',
    'DRIFTED_UP',
    'DRIFTED_REPRICE',    // added 2026-05-16 — autonomy
    'STALE_FLAT',
    'DRIFTED_NO_DIP',
]);

// Safety knobs (can be overridden via TRADING_CONFIG)
const DEFAULTS = {
    enabled: false,
    paperMode: true,
    maxCancelsPerHour: 10,
    cooldownAfterCancelSec: 300,    // 5 min — don't spam a re-issued order
    ageBufferSec: 60,               // extra second buffer above staleMin
    logRetention: 200,              // last N entries kept in audit log
};

let _redis, _port;
let _running = false;

function loadConfig() {
    return _redis.get(CONFIG_KEY).then(raw => {
        const cfg = raw ? JSON.parse(raw) : {};
        return {
            enabled: cfg.pendingAutoCancelEnabled ?? DEFAULTS.enabled,
            paperMode: cfg.pendingAutoCancelPaperMode ?? DEFAULTS.paperMode,
            maxCancelsPerHour: cfg.pendingAutoCancelMaxPerHour ?? DEFAULTS.maxCancelsPerHour,
            cooldownSec: cfg.pendingAutoCancelCooldownSec ?? DEFAULTS.cooldownAfterCancelSec,
            ageBufferSec: cfg.pendingAutoCancelAgeBufferSec ?? DEFAULTS.ageBufferSec,
        };
    }).catch(() => ({ ...DEFAULTS }));
}

async function fetchPendingOrders() {
    const r = await fetch(`http://127.0.0.1:${_port}/api/pending-orders`);
    if (!r.ok) throw new Error(`pending-orders ${r.status}`);
    return await r.json();
}

async function inCooldown(symbol) {
    return await _redis.exists(`PENDING_AUTO_CANCEL:COOLDOWN:${symbol}`) === 1;
}

async function consumeQuota(cfg) {
    // Quota tracked per hour-bucket so we never exceed maxCancelsPerHour
    // even if the worker restarts. Bucket key auto-expires after 1h.
    const bucket = Math.floor(Date.now() / 3600000);
    const key = `PENDING_AUTO_CANCEL:HOUR_BUCKET:${bucket}`;
    const count = await _redis.incr(key);
    if (count === 1) await _redis.expire(key, 3600);
    return { used: count, limit: cfg.maxCancelsPerHour, ok: count <= cfg.maxCancelsPerHour };
}

async function logAction(entry) {
    try {
        await _redis.lpush('PENDING_AUTO_CANCEL:LOG', JSON.stringify(entry));
        await _redis.ltrim('PENDING_AUTO_CANCEL:LOG', 0, DEFAULTS.logRetention - 1);
        await _redis.expire('PENDING_AUTO_CANCEL:LOG', 7 * 24 * 60 * 60);  // 7 days
    } catch (e) {
        console.error('[auto-cancel] log failed:', e.message);
    }
}

async function callCancel(binanceSym, orderId) {
    const r = await fetch(`http://127.0.0.1:${_port}/api/open-orders/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: binanceSym, orderId: Number(orderId) }),
    });
    const j = await r.json().catch(() => null);
    return { ok: r.ok && j && j.ok, body: j };
}

async function setStatus(patch) {
    const flat = {};
    for (const [k, v] of Object.entries(patch)) flat[k] = String(v);
    if (Object.keys(flat).length) {
        await _redis.hset('PENDING_AUTO_CANCEL:STATUS', flat).catch(() => {});
    }
}

async function pollOnce() {
    const cfg = await loadConfig();
    await setStatus({ last_poll_ts: Date.now(), enabled: cfg.enabled ? 1 : 0, paper_mode: cfg.paperMode ? 1 : 0 });

    if (!cfg.enabled) return;

    let data;
    try {
        data = await fetchPendingOrders();
    } catch (e) {
        await setStatus({ last_error: e.message });
        return;
    }

    const orders = data.orders || [];
    let evaluated = 0, cancelled = 0;

    for (const o of orders) {
        const a = o.analysis || {};
        if (a.action !== 'CANCEL') continue;
        if (!AUTO_CANCEL_CLASSIFICATIONS.has(a.classification)) continue;

        evaluated++;
        const symbol = o.symbol;
        const binanceSym = symbol.replace('/', '');
        const staleMin = a.thresholds?.staleMin ?? 10;
        const ageOkMin = staleMin + cfg.ageBufferSec / 60;

        // Safety gate 1: age must comfortably exceed staleMin
        if (a.age_min < ageOkMin) {
            continue;
        }

        // Safety gate 2: open order id must be present (we can't cancel what we can't address)
        if (!o.open_order || !o.open_order.orderId) {
            continue;
        }

        // Safety gate 3: per-symbol cooldown
        if (await inCooldown(binanceSym)) {
            continue;
        }

        // Safety gate 4: hourly quota
        // We pre-allocate the slot via INCR; if it pushes us over the limit,
        // we don't roll it back (small over-count is fine — the quota is a
        // soft ceiling). Skip remaining orders this cycle.
        const quota = await consumeQuota(cfg);
        if (!quota.ok) {
            await setStatus({ last_error: `quota exhausted: ${quota.used}/${quota.limit} this hour` });
            break;
        }

        // ── Take action ──
        const audit = {
            ts: Date.now(),
            symbol,
            binanceSym,
            classification: a.classification,
            action: a.action,
            tier: o.tier,
            age_min: a.age_min,
            peak_pct: a.peak_pct_from_signal,
            pullback_pct: a.pullback_from_peak_pct,
            current_vs_limit_pct: a.current_vs_limit_pct,
            momentum_3m_pct: a.momentum_3m_pct,
            limit_price: a.limit_price,
            current_price: a.current_price,
            headline: a.headline,
            mode: cfg.paperMode ? 'paper' : 'live',
            quota_used: quota.used,
        };

        if (cfg.paperMode) {
            audit.outcome = 'paper_logged';
            await logAction(audit);
            cancelled++;
            console.log(`[auto-cancel] 📝 PAPER ${symbol} ${a.classification} (age ${a.age_min}m) — would cancel order #${o.open_order.orderId}`);
        } else {
            try {
                const res = await callCancel(binanceSym, o.open_order.orderId);
                audit.outcome = res.ok ? 'cancelled' : 'cancel_failed';
                audit.detail = res.body;
                await logAction(audit);
                if (res.ok) {
                    cancelled++;
                    // 5-min cooldown on this symbol so we don't re-cancel a
                    // freshly re-issued order from the next bot signal cycle.
                    await _redis.set(`PENDING_AUTO_CANCEL:COOLDOWN:${binanceSym}`, '1', 'EX', cfg.cooldownSec);
                    console.log(`[auto-cancel] ✗ LIVE ${symbol} ${a.classification} — cancelled order #${o.open_order.orderId}`);
                } else {
                    console.error(`[auto-cancel] cancel failed ${symbol}:`, res.body);
                }
            } catch (e) {
                audit.outcome = 'error';
                audit.detail = e.message;
                await logAction(audit);
                console.error(`[auto-cancel] error ${symbol}:`, e.message);
            }
        }
        await setStatus({ last_action_ts: Date.now() });
    }

    await setStatus({
        last_run_count: evaluated,
        last_cancel_count: cancelled,
    });
}

function start({ redis, port }) {
    if (_running) return;
    _running = true;
    _redis = redis;
    _port = port;

    console.log('[auto-cancel] worker starting…');
    setInterval(() => {
        pollOnce().catch(e => {
            console.error('[auto-cancel] poll error:', e.message);
            setStatus({ last_error: e.message }).catch(() => {});
        });
    }, POLL_INTERVAL_MS);
}

module.exports = { start };
