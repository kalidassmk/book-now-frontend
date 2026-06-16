'use strict';
/* ─────────────────────────────────────────────────────────────────────────
   PUMP RADAR — server-side 24×7 signal engine  (iter174)
   ─────────────────────────────────────────────────────────────────────────
   Faithful Node port of public/pump-radar.html's client-side engine so that
   pump-history.html accrues data WITHOUT anyone keeping the radar tab open.

   Data source = Binance public **WebSocket** klines (1h + 5m). WS carries no
   REST weight, so this never touches the trading IP's 6000/min REST budget
   (operator's standing rule). A one-time REST seed at startup primes the
   baseline history (≈217 syms × 2 = 434 light kline calls, throttled).

   Rule (validated over 90 days — identical constants to the browser):
     prior 1h ret(2 closed bars) ≥ +4%  AND  prior 1h vol surge ≥ 2.5×  ⇒ ARMED
     + fresh 5m GREEN candle, vol surge ≥ 3×, taker-buy ≥ 55%,
       not a blow-off (5m surge < 12×), not chasing (1h move < 18%)     ⇒ SIGNAL

   On every fresh COLD→ARMED and →SIGNAL transition we call the injected
   `capture(ev)` (server.js's durable file + redis-analyse writer), so the
   history is identical in shape to the browser captures.
   ──────────────────────────────────────────────────────────────────────── */

const WebSocket = require('ws');

// Curated universe — Object.keys(PLAYBOOK) from pump-radar.html (217 syms).
const SYMBOLS = [
  "WLDUSDT", "ZECUSDT", "TRUMPUSDT", "BABYUSDT", "TAOUSDT", "NIGHTUSDT", "NEARUSDT", "ALLOUSDT", "SUIUSDT", "ENAUSDT",
  "DEXEUSDT", "XPLUSDT", "STGUSDT", "FETUSDT", "HMSTRUSDT", "TONUSDT", "XLMUSDT", "ORCAUSDT", "ONDOUSDT", "RIFUSDT",
  "ICPUSDT", "ENJUSDT", "MEGAUSDT", "HOMEUSDT", "ATUSDT", "FILUSDT", "WLFIUSDT", "NOTUSDT", "INJUSDT", "SEIUSDT",
  "RENDERUSDT", "CHZUSDT", "AXLUSDT", "PENGUUSDT", "OPUSDT", "JSTUSDT", "OPGUSDT", "PUMPUSDT", "ZBTUSDT", "HEIUSDT",
  "BANANAS31USDT", "VIRTUALUSDT", "OPNUSDT", "BIOUSDT", "SAHARAUSDT", "EPICUSDT", "OPENUSDT", "WUSDT", "ORDIUSDT", "CHIPUSDT",
  "PHAUSDT", "LUNCUSDT", "BONKUSDT", "IOUSDT", "ENSOUSDT", "ESPUSDT", "FFUSDT", "ZAMAUSDT", "GENIUSUSDT", "AIXBTUSDT",
  "ZKUSDT", "DASHUSDT", "JTOUSDT", "ROBOUSDT", "PYTHUSDT", "TIAUSDT", "HEMIUSDT", "ZROUSDT", "ARUSDT", "PENDLEUSDT",
  "NILUSDT", "HOLOUSDT", "DOLOUSDT", "KATUSDT", "ARKMUSDT", "IDUSDT", "ALGOUSDT", "TSTUSDT", "SOPHUSDT", "KITEUSDT",
  "STRAXUSDT", "PARTIUSDT", "ETHFIUSDT", "MMTUSDT", "MOVRUSDT", "FIDAUSDT", "PNUTUSDT", "KMNOUSDT", "MEUSDT", "LDOUSDT",
  "STOUSDT", "BANKUSDT", "HAEDALUSDT", "SPKUSDT", "MORPHOUSDT", "EIGENUSDT", "GIGGLEUSDT", "SAGAUSDT", "STRKUSDT", "GALAUSDT",
  "ICXUSDT", "PORTALUSDT", "1000CHEEMSUSDT", "SENTUSDT", "WALUSDT", "ZENUSDT", "BERAUSDT", "0GUSDT", "AIGENSYNUSDT", "DUSDT",
  "NXPCUSDT", "NEIROUSDT", "WIFUSDT", "DOGSUSDT", "CFGUSDT", "INITUSDT", "MIRAUSDT", "ALTUSDT", "MITOUSDT", "EDENUSDT",
  "MOVEUSDT", "CUSDT", "AVNTUSDT", "SUSDT", "LUMIAUSDT", "TLMUSDT", "AXSUSDT", "PLUMEUSDT", "DYMUSDT", "PROVEUSDT",
  "IOTAUSDT", "ASTRUSDT", "USUALUSDT", "KAVAUSDT", "RAYUSDT", "WCTUSDT", "DYDXUSDT", "FORMUSDT", "MEMEUSDT", "SOMIUSDT",
  "2ZUSDT", "APEUSDT", "BARDUSDT", "MANTAUSDT", "LAYERUSDT", "AIUSDT", "HFTUSDT", "BATUSDT", "FOGOUSDT", "USTCUSDT",
  "PIXELUSDT", "GPSUSDT", "BBUSDT", "TREEUSDT", "STXUSDT", "ACHUSDT", "NOMUSDT", "ASRUSDT", "EDUUSDT", "KAITOUSDT",
  "TRBUSDT", "BROCCOLI714USDT", "HIGHUSDT", "HYPERUSDT", "SXTUSDT", "HUMAUSDT", "VICUSDT", "GNOUSDT", "GMTUSDT", "GUNUSDT",
  "XAIUSDT", "LAUSDT", "CFXUSDT", "MANTRAUSDT", "SUPERUSDT", "TUTUSDT", "BOMEUSDT", "ZKCUSDT", "OSMOUSDT", "NEWTUSDT",
  "SKLUSDT", "PSGUSDT", "AUDIOUSDT", "RONINUSDT", "EULUSDT", "REDUSDT", "MUBARAKUSDT", "LPTUSDT", "OGUSDT", "TOWNSUSDT",
  "TURBOUSDT", "PONDUSDT", "SCRUSDT", "PEOPLEUSDT", "CTSIUSDT", "RAREUSDT", "MBOXUSDT", "SUSHIUSDT", "ADXUSDT", "METISUSDT",
  "LUNAUSDT", "CGPTUSDT", "ZKPUSDT", "ATMUSDT", "COSUSDT", "JUVUSDT", "THETAUSDT", "DODOUSDT", "1000SATSUSDT", "COMPUSDT",
  "ACMUSDT", "FLOWUSDT", "MINAUSDT", "NFPUSDT", "AMPUSDT", "IMXUSDT", "CATIUSDT",
];

// Rule constants — identical to pump-radar.html.
const RET2_GATE = 4.0;     // prior 1h % over 2 closed bars
const VS1H_GATE = 2.5;     // prior 1h volume surge
const VS5M_GATE = 3.0;     // fresh 5m volume surge
const BASE_1H = 12;        // 1h baseline bars for vol avg
const BASE_5M = 20;        // 5m baseline bars for vol avg
const BUY5M_GATE = 55.0;   // min taker-buy % on the 5m ignition candle
const VS5M_BLOWOFF = 12.0; // 5m vol surge ≥ this = parabolic blow-off → no SIGNAL
const RET2_CHASE = 18.0;   // prior 1h move ≥ this = already extended → no SIGNAL

const STREAM_BATCH = 200;  // SUBSCRIBE params per WS message
const SEED_CONC = 4;       // concurrent REST seed fetches (gentle on the IP)
const WS_URL = 'wss://stream.binance.com:9443/stream';

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

// Per-coin live state (mirrors the browser's S{}).
const S = {};
for (const sym of SYMBOLS) {
  S[sym] = {
    closes1h: [], vols1h: [], vols5m: [],
    cur1h: null, cur5m: null,
    price: null, ret2: null, vs1h: null, vs5m: null, buy5m: null, green5m: false,
    status: 'COLD',                 // COLD | ARMED | SIGNAL
    sigTs: 0, sigPrice: null,
  };
}

let _capture = null;   // injected durable writer: (source, ev) => Promise
let _binanceFetch = null;
let ws = null;
let started = false;
let seeded = false;
let lastSignalLog = 0;

// ── REST seed (one-time, throttled) ──────────────────────────────────────
async function seedCoin(sym) {
  const st = S[sym];
  try {
    const k1 = await _binanceFetch('/api/v3/klines', 'GET',
      { symbol: sym, interval: '1h', limit: BASE_1H + 4 }, { signed: false });
    for (let i = 0; i < k1.length - 1; i++) { st.closes1h.push(+k1[i][4]); st.vols1h.push(+k1[i][5]); }
    const lf = k1[k1.length - 1];
    st.cur1h = { t: lf[0], o: +lf[1], h: +lf[2], l: +lf[3], c: +lf[4], v: +lf[5], V: +lf[9] };
    st.price = +lf[4];
  } catch (_) { /* stays COLD until WS fills it */ }
  try {
    const k5 = await _binanceFetch('/api/v3/klines', 'GET',
      { symbol: sym, interval: '5m', limit: BASE_5M + 4 }, { signed: false });
    for (let i = 0; i < k5.length - 1; i++) st.vols5m.push(+k5[i][5]);
    const lf = k5[k5.length - 1];
    st.cur5m = { t: lf[0], o: +lf[1], h: +lf[2], l: +lf[3], c: +lf[4], v: +lf[5], V: +lf[9] };
  } catch (_) {}
  recompute(sym);
}

async function seedAll() {
  const queue = [...SYMBOLS];
  let done = 0;
  async function worker() {
    while (queue.length) {
      await seedCoin(queue.shift());
      done++;
    }
  }
  await Promise.all(Array.from({ length: SEED_CONC }, worker));
  seeded = true;
  console.log(`[pump-radar-engine] seeded ${done}/${SYMBOLS.length} symbols`);
}

// ── Rule evaluation (identical to recompute() in the browser) ────────────
function recompute(sym) {
  const st = S[sym];
  const c = st.closes1h;
  st.ret2 = (c.length >= 3) ? (c[c.length - 1] / c[c.length - 3] - 1) * 100 : null;
  const v1 = st.vols1h;
  if (v1.length >= 4) {
    const last = v1[v1.length - 1];
    const base = v1.slice(Math.max(0, v1.length - 1 - BASE_1H), v1.length - 1);
    const m = mean(base);
    st.vs1h = m > 0 ? last / m : null;
  } else st.vs1h = null;
  if (st.cur5m && st.vols5m.length >= 4) {
    const m = mean(st.vols5m.slice(-BASE_5M));
    st.vs5m = m > 0 ? st.cur5m.v / m : null;
    st.green5m = st.cur5m.c >= st.cur5m.o;
    st.buy5m = st.cur5m.v > 0 ? (st.cur5m.V / st.cur5m.v) * 100 : null;
    st.price = st.cur5m.c;
  }
  const armed = st.ret2 != null && st.ret2 >= RET2_GATE && st.vs1h != null && st.vs1h >= VS1H_GATE;
  const takerOk = st.buy5m != null && st.buy5m >= BUY5M_GATE;
  const blowoff = st.vs5m != null && st.vs5m >= VS5M_BLOWOFF;
  const chase = st.ret2 != null && st.ret2 >= RET2_CHASE;
  const ignite = st.green5m && st.vs5m != null && st.vs5m >= VS5M_GATE && takerOk && !blowoff && !chase;
  let next = 'COLD';
  if (armed && ignite) next = 'SIGNAL';
  else if (armed) next = 'ARMED';
  if (next === 'SIGNAL' && st.status !== 'SIGNAL') {
    st.sigTs = Date.now();
    st.sigPrice = st.price;
    emit(sym, 'SIGNAL', st.sigTs, st.sigPrice);
  } else if (next === 'ARMED' && st.status !== 'ARMED') {
    emit(sym, 'ARMED', Date.now(), st.price);
  }
  if (next !== 'SIGNAL') st.sigPrice = null;
  st.status = next;
}

// Build the same capture payload the browser POSTs, then persist durably.
function emit(sym, label, ts, price) {
  const st = S[sym];
  const ev = {
    ts: ts || Date.now(),
    symbol: sym,
    label,
    price: price != null ? price : st.price,
    chg_pct: st.ret2,
    vol_surge: st.vs5m,
    buy_pct: st.buy5m,
  };
  if (!seeded) return;   // ignore transitions during the noisy seed phase
  Promise.resolve(_capture('pump', ev)).catch(e =>
    console.error('[pump-radar-engine] capture failed:', e.message));
  const now = Date.now();
  if (label === 'SIGNAL' || now - lastSignalLog > 60000) {
    console.log(`[pump-radar-engine] ${label} ${sym} @ ${ev.price} (ret2=${st.ret2?.toFixed?.(1)}% vs5m=${st.vs5m?.toFixed?.(1)}× buy=${st.buy5m?.toFixed?.(0)}%)`);
    lastSignalLog = now;
  }
}

// ── WebSocket live feed ──────────────────────────────────────────────────
function handleKline(d) {
  const sym = d.s, k = d.k, st = S[sym];
  if (!st) return;
  const cand = { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v, V: +k.V };
  if (k.i === '1h') {
    st.cur1h = cand;
    if (k.x) {
      st.closes1h.push(cand.c); st.vols1h.push(cand.v);
      if (st.closes1h.length > 60) st.closes1h.shift();
      if (st.vols1h.length > 60) st.vols1h.shift();
    }
  } else if (k.i === '5m') {
    st.cur5m = cand;
    if (k.x) { st.vols5m.push(cand.v); if (st.vols5m.length > 60) st.vols5m.shift(); }
  }
  recompute(sym);
}

function connect() {
  ws = new WebSocket(WS_URL, { perMessageDeflate: false });
  ws.on('open', () => {
    console.log('[pump-radar-engine] WS connected — subscribing klines');
    const params = [];
    for (const sym of SYMBOLS) {
      const s = sym.toLowerCase();
      params.push(`${s}@kline_5m`, `${s}@kline_1h`);
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
  ws.on('close', () => { console.warn('[pump-radar-engine] WS closed — reconnecting in 3s'); setTimeout(connect, 3000); });
  ws.on('error', e => { console.warn('[pump-radar-engine] WS error:', e.message); try { ws.close(); } catch {} });
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
    console.error('[pump-radar-engine] start() requires {binanceFetch, capture} — not started');
    return;
  }
  started = true;
  _binanceFetch = o.binanceFetch;
  _capture = o.capture;
  console.log(`[pump-radar-engine] starting — ${SYMBOLS.length} symbols, WS klines`);
  connect();                 // WS first (live), seed in parallel
  try { await seedAll(); } catch (e) { console.error('[pump-radar-engine] seed error:', e.message); seeded = true; }
}

module.exports = { start, SYMBOLS };
