'use strict';
/* ─────────────────────────────────────────────────────────────────────────
   ORDER FLOW RADAR — server-side 24×7 signal engine  (iter178)
   ─────────────────────────────────────────────────────────────────────────
   Faithful Node port of public/orderflow-radar.html's BURST → T+1 CONFIRM
   rule so that orderflow-history.html accrues data WITHOUT anyone keeping the
   radar tab open — exactly like pump-radar-engine.js (iter174) does for pump.

   WHY THIS EXISTS: orderflow-history was fed ONLY by browser captures from
   orderflow-radar.html (POST /api/history/capture). pump-history had a 24×7
   server engine but orderflow never did, so once nobody kept the orderflow
   tab open (last: 2026-06-14) the history simply stopped growing.

   Data source = Binance public **WebSocket** klines (1m + 1h). WS carries no
   REST weight, so this never touches the trading IP's 6000/min REST budget. A
   one-time REST seed at startup primes the 1m/1h baselines (throttled).

   Rule (identical constants to the browser):
     1h context  : prior 1h ret(2 closed bars) ≥ +4% AND vol surge ≥ 2.5× ⇒ ARMED
     fresh BURST : green 1m, vol surge ≥ 3× (and < 15× blow-off),
                   taker-buy ≥ 60%, trade-count breadth ≥ 3×
     T+1 CONFIRM : the very next minute is green, taker-buy ≥ 55%,
                   vol still elevated ≥ 1.2×  ⇒  CONFIRM (or BUY if 1h ARMED)

   Only BUY / CONFIRM transitions are captured (browser captures the same two
   — never bare BURST). Capture flows through the SAME durable writer the
   browser uses (persistRadarCapture → file + redis-analyse), so the history
   is identical in shape no matter who produced it.
   ──────────────────────────────────────────────────────────────────────── */

const WebSocket = require('ws');

// Reuse the curated 217-symbol universe from the pump engine so both radars
// watch an identical coin set (and we don't duplicate the list here).
const { SYMBOLS } = require('./pump-radar-engine');

// Rule constants — identical to orderflow-radar.html.
const VS_GATE    = 3.0;    // 1m volume surge vs 20m base (burst ignition)
const BUY_GATE   = 60;     // taker-buy % on the burst minute
const BREADTH    = 3.0;    // trade-count surge vs 20m base (the real tell)
const T1_BUY     = 55;     // T+1 taker-buy % to confirm
const VS_BLOWOFF = 15.0;   // 1m vol surge ≥ this = climax blow-off → skip burst
const T1_VS      = 1.2;    // T+1 volume still elevated
const RET2_GATE  = 4.0;    // prior 1h % over 2 closed bars (ARMED)
const VS1H_GATE  = 2.5;    // prior 1h volume surge (ARMED)
const BASE_N     = 20;     // 1m baseline window
const BURST_COOLDOWN_MS = 8 * 60000;   // min gap between fresh bursts per coin
const STALE_MS   = 12 * 60000;         // clear status after 12m of no burst

// ── v2 quality gates + pullback entry (iter179) ───────────────────────────
// Backtest of the first 44 live CONFIRM signals (median MFE +0.56% vs median
// MAE −2.03%, 20% win) showed the raw confirm-candle entry is "buy the climax".
// The taker-buy% curve was the tell: buy%<60 won 67% (+4.5%), buy% 70-80 won
// 0% — high taker-buy is EXHAUSTION, not strength. So a CONFIRM is still
// recorded for history/learning, but a real (auto-buyable) BUY is only emitted
// when the burst passes quality gates AND price pulls back to a limit (no
// chasing). This took total backtest P&L from −42.9% → break-even/positive on
// the few setups that actually qualified.
const BUY_EXH      = 78;     // reject confirm taker-buy% ≥ this (exhaustion)
const BLOWOFF_VS   = 12;     // blow-off reject fires only when vol_surge ≥ this …
const BLOWOFF_BUY  = 75;     // … AND taker-buy% ≥ this (pure exhaustion spike;
                             //     high-vol + low-buy = real breakout, kept)
const WAVE_WINDOW_MS = 5 * 60000;  // correlated-wave lookback
const WAVE_MAX     = 4;      // ≥ this many bursts across the universe in the
                             //     window ⇒ market-wide blow-off → suppress BUY
const PULL_PCT     = 0.8;    // limit-entry pullback below the confirm close
const FILL_WIN_MS  = 12 * 60000;   // how long the pullback limit stays live

const STREAM_BATCH = 200;
const SEED_CONC = 4;
const WS_URL = 'wss://stream.binance.com:9443/stream';

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

// Per-coin live state (mirrors the browser's S{}).
const S = {};
for (const sym of SYMBOLS) {
  S[sym] = {
    vols1m: [], trd1m: [], cur1m: null,
    closes1h: [], vols1h: [], cur1h: null,
    price: null, vs1m: null, breadth: null, buy1m: null, green: false,
    armed: false, ret2: null, vs1h: null,
    burst: null,                 // { t, vs, breadth, buy, price }
    t1: null,                    // 'PASS' | 'FAIL' | null
    status: 'QUIET',             // QUIET | BURST | CONFIRM | BUY | FADE
    entry: null,
    lastBurstSeen: 0,
    pending: null,               // v2: { target, refPrice, expiresAt } pullback-limit
  };
}

// Global rolling record of fresh-burst timestamps across the whole universe —
// powers the correlated-wave guard (suppress BUYs when everything bursts at once).
let _burstTimes = [];
function registerBurst() {
  const now = Date.now();
  _burstTimes.push(now);
  const cut = now - WAVE_WINDOW_MS;
  _burstTimes = _burstTimes.filter(t => t >= cut);
}
function waveCount() {
  const cut = Date.now() - WAVE_WINDOW_MS;
  return _burstTimes.filter(t => t >= cut).length;
}

let _capture = null;       // injected durable writer: (source, ev) => Promise
let _binanceFetch = null;
let ws = null;
let started = false;
let seeded = false;
let lastLog = 0;

// ── REST seed (one-time, throttled) ──────────────────────────────────────
async function seedCoin(sym) {
  const st = S[sym];
  try { // 1m volume + trade-count baseline
    const k = await _binanceFetch('/api/v3/klines', 'GET',
      { symbol: sym, interval: '1m', limit: BASE_N + 4 }, { signed: false });
    for (let i = 0; i < k.length - 1; i++) { st.vols1m.push(+k[i][5]); st.trd1m.push(+k[i][8]); }
    const lf = k[k.length - 1];
    st.cur1m = { t: lf[0], o: +lf[1], c: +lf[4], v: +lf[5], n: +lf[8], tb: +lf[9] };
    st.price = +lf[4];
  } catch (_) { /* stays QUIET until WS fills it */ }
  try { // 1h context
    const k = await _binanceFetch('/api/v3/klines', 'GET',
      { symbol: sym, interval: '1h', limit: 16 }, { signed: false });
    for (let i = 0; i < k.length - 1; i++) { st.closes1h.push(+k[i][4]); st.vols1h.push(+k[i][5]); }
  } catch (_) {}
  recomputeContext(sym);
}

async function seedAll() {
  const queue = [...SYMBOLS];
  let done = 0;
  async function worker() {
    while (queue.length) { await seedCoin(queue.shift()); done++; }
  }
  await Promise.all(Array.from({ length: SEED_CONC }, worker));
  seeded = true;
  // NOTE: unlike the pump engine we do NOT emit an initial snapshot. A
  // BUY/CONFIRM is only valid after a live BURST followed by a fresh T+1
  // confirmation minute — it can't be reconstructed from seed history alone,
  // and the browser likewise only captures on live onConfirm(). The engine
  // therefore starts quiet and accrues captures as transitions happen live.
  console.log(`[orderflow-radar-engine] seeded ${done}/${SYMBOLS.length} symbols — watching live transitions`);
}

// ── 1h momentum context (ARMED) ──────────────────────────────────────────
function recomputeContext(sym) {
  const st = S[sym], c = st.closes1h, v = st.vols1h;
  st.ret2 = c.length >= 3 ? (c[c.length - 1] / c[c.length - 3] - 1) * 100 : null;
  if (v.length >= 4) {
    const last = v[v.length - 1];
    const m = mean(v.slice(Math.max(0, v.length - 13), v.length - 1));
    st.vs1h = m > 0 ? last / m : null;
  } else st.vs1h = null;
  st.armed = st.ret2 != null && st.ret2 >= RET2_GATE && st.vs1h != null && st.vs1h >= VS1H_GATE;
}

// ── live kline handling (mirrors browser handleKline) ────────────────────
function handleKline(d) {
  const sym = d.s, k = d.k, st = S[sym];
  if (!st) return;

  if (k.i === '1h') {
    st.cur1h = { c: +k.c, v: +k.v };
    if (k.x) {
      st.closes1h.push(+k.c); st.vols1h.push(+k.v);
      if (st.closes1h.length > 40) st.closes1h.shift();
      if (st.vols1h.length > 40) st.vols1h.shift();
    }
    recomputeContext(sym);
    return;
  }

  // 1m  (V = taker buy base)
  const cur = { t: k.t, o: +k.o, c: +k.c, v: +k.v, n: +k.n, tb: +k.V, l: +k.l };
  st.cur1m = cur; st.price = cur.c;
  const baseV = mean(st.vols1m.slice(-BASE_N)) || 1;
  const baseN = mean(st.trd1m.slice(-BASE_N)) || 1;
  st.vs1m = cur.v / baseV;
  st.breadth = cur.n / baseN;
  st.buy1m = cur.v > 0 ? cur.tb / cur.v * 100 : 0;
  st.green = cur.c > cur.o;

  // v2: pullback-limit fill check on EVERY tick (intrabar low counts).
  checkPullback(sym, cur.l);

  if (k.x) {   // minute closed
    // 1) evaluate T+1 confirmation of a prior burst
    if (st.burst && st.burst.t === cur.t - 60000) {
      const pass = st.green && st.buy1m >= T1_BUY && st.vs1m >= T1_VS;
      st.t1 = pass ? 'PASS' : 'FAIL';
      st.status = pass ? (st.armed ? 'BUY' : 'CONFIRM') : 'FADE';
      if (pass) { st.entry = cur.c; onConfirm(sym); }
    }
    // 2) fresh burst detection on the just-closed minute
    const isBurst = st.green && st.vs1m >= VS_GATE && st.vs1m < VS_BLOWOFF &&
                    st.buy1m >= BUY_GATE && st.breadth >= BREADTH;
    if (isBurst && st.burst?.t !== cur.t && cur.t - (st.burst?.t || 0) > BURST_COOLDOWN_MS) {
      st.burst = { t: cur.t, vs: st.vs1m, breadth: st.breadth, buy: st.buy1m, price: cur.c };
      st.t1 = null; st.status = 'BURST'; st.lastBurstSeen = Date.now();
      registerBurst();   // v2: feed the correlated-wave guard
    }
    // 3) push closed candle to baselines
    st.vols1m.push(cur.v); st.trd1m.push(cur.n);
    if (st.vols1m.length > 40) st.vols1m.shift();
    if (st.trd1m.length > 40) st.trd1m.shift();
    // 4) expire stale statuses after 12m of no burst
    if (st.status !== 'QUIET' && Date.now() - st.lastBurstSeen > STALE_MS) {
      st.status = 'QUIET'; st.burst = null; st.t1 = null;
    }
  }
}

// Build the same capture payload the browser POSTs, then persist durably.
function onConfirm(sym) {
  const st = S[sym];
  if (!seeded) return;                 // ignore the noisy seed phase
  if (st.status !== 'BUY' && st.status !== 'CONFIRM') return;
  const c = st.cur1m || {};
  const px = st.entry || c.c;
  const buyUsdt  = (c.tb != null && px) ? c.tb * px : null;
  const sellUsdt = (c.v != null && c.tb != null && px) ? (c.v - c.tb) * px : null;
  const ev = {
    source: 'orderflow',
    symbol: sym,
    label: st.status,                  // 'BUY' | 'CONFIRM'
    ts: Date.now(),
    price: px,
    chg_pct: st.ret2,
    vol_surge: st.vs1m,
    buy_pct: st.buy1m,
    buy_vol: buyUsdt,
    sell_vol: sellUsdt,
  };
  Promise.resolve(_capture('orderflow', ev)).catch(e =>
    console.error('[orderflow-radar-engine] capture failed:', e.message));
  const now = Date.now();
  if (now - lastLog > 30000) {
    console.log(`[orderflow-radar-engine] ${st.status} ${sym} @ ${px} (vs1m=${st.vs1m?.toFixed?.(1)}× buy=${st.buy1m?.toFixed?.(0)}% breadth=${st.breadth?.toFixed?.(1)}× armed=${st.armed})`);
    lastLog = now;
  }

  // v2: after recording the CONFIRM detection, decide whether this setup
  // qualifies for a real (auto-buyable) BUY. We do NOT chase the confirm
  // candle — instead arm a pullback limit and only emit BUY if price comes
  // back to it within the fill window.
  maybeArmPullback(sym);
}

// ── v2 quality gates → arm a pullback-limit entry ────────────────────────
function maybeArmPullback(sym) {
  const st = S[sym];
  const buy = st.buy1m, vs = st.vs1m;
  // Gate 1 — exhaustion: extreme taker-buy% means buyers are spent → skip.
  if (buy == null || buy >= BUY_EXH) return;
  // Gate 2 — blow-off: only reject when BOTH volume AND taker-buy are extreme
  // (high-vol + moderate-buy = genuine breakout, kept; e.g. ZKC +50%).
  if (vs != null && vs >= BLOWOFF_VS && buy >= BLOWOFF_BUY) return;
  // Gate 3 — correlated wave: whole market bursting at once = blow-off → skip.
  if (waveCount() >= WAVE_MAX) {
    console.log(`[orderflow-radar-engine] BUY suppressed (wave=${waveCount()}) ${sym}`);
    return;
  }
  const ref = st.entry || (st.cur1m && st.cur1m.c);
  if (!ref) return;
  st.pending = { refPrice: ref, target: ref * (1 - PULL_PCT / 100), expiresAt: Date.now() + FILL_WIN_MS };
  console.log(`[orderflow-radar-engine] BUY armed ${sym} ref=${ref} target=${st.pending.target.toFixed(8)} (buy=${buy.toFixed(0)}% vs=${vs?.toFixed?.(1)}× wave=${waveCount()})`);
}

// Fill the armed pullback limit when price dips to target within the window.
function checkPullback(sym, low) {
  const st = S[sym];
  const p = st.pending;
  if (!p || low == null) return;
  if (Date.now() > p.expiresAt) { st.pending = null; return; }   // window closed → no trade
  if (low <= p.target) {
    st.pending = null;
    emitBuy(sym, p.target);
  }
}

// Emit the real, auto-buyable BUY at the pulled-back entry price. The backend
// SignalAutoBuyManager acts ONLY on label "BUY" — CONFIRM stays study-only.
function emitBuy(sym, price) {
  const st = S[sym];
  if (!seeded) return;
  const c = st.cur1m || {};
  const buyUsdt  = (c.tb != null && price) ? c.tb * price : null;
  const sellUsdt = (c.v != null && c.tb != null && price) ? (c.v - c.tb) * price : null;
  st.status = 'BUY'; st.entry = price;
  const ev = {
    source: 'orderflow',
    symbol: sym,
    label: 'BUY',
    ts: Date.now(),
    price,
    chg_pct: st.ret2,
    vol_surge: st.vs1m,
    buy_pct: st.buy1m,
    buy_vol: buyUsdt,
    sell_vol: sellUsdt,
  };
  Promise.resolve(_capture('orderflow', ev)).catch(e =>
    console.error('[orderflow-radar-engine] BUY capture failed:', e.message));
  console.log(`[orderflow-radar-engine] ★ BUY ${sym} @ ${price} (pullback filled, buy=${st.buy1m?.toFixed?.(0)}% vs=${st.vs1m?.toFixed?.(1)}×)`);
}

// ── WebSocket live feed ──────────────────────────────────────────────────
function connect() {
  ws = new WebSocket(WS_URL, { perMessageDeflate: false });
  ws.on('open', () => {
    console.log('[orderflow-radar-engine] WS connected — subscribing klines');
    const params = [];
    for (const sym of SYMBOLS) {
      const s = sym.toLowerCase();
      params.push(`${s}@kline_1m`, `${s}@kline_1h`);
    }
    for (let i = 0; i < params.length; i += STREAM_BATCH) {
      ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: params.slice(i, i + STREAM_BATCH), id: i }));
    }
  });
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (!msg.data || !msg.data.k) return;
    handleKline(msg.data);
  });
  ws.on('close', () => { console.warn('[orderflow-radar-engine] WS closed — reconnecting in 3s'); setTimeout(connect, 3000); });
  ws.on('error', e => { console.warn('[orderflow-radar-engine] WS error:', e.message); try { ws.close(); } catch {} });
}

/**
 * Start the engine.
 * @param {object} o
 * @param {function} o.binanceFetch  public REST helper (path, method, params, {signed:false})
 * @param {function} o.capture       durable writer: (source, ev) => Promise
 */
async function start(o) {
  if (started) return;
  if (!o || typeof o.binanceFetch !== 'function' || typeof o.capture !== 'function') {
    console.error('[orderflow-radar-engine] start() requires {binanceFetch, capture} — not started');
    return;
  }
  started = true;
  _binanceFetch = o.binanceFetch;
  _capture = o.capture;
  console.log(`[orderflow-radar-engine] starting — ${SYMBOLS.length} symbols, WS klines`);
  connect();                 // WS first (live), seed in parallel
  try { await seedAll(); } catch (e) { console.error('[orderflow-radar-engine] seed error:', e.message); seeded = true; }
}

module.exports = { start, SYMBOLS };
