/*
 * nav.js — Universal navigation for Book-Now dashboard (iter 77)
 * ─────────────────────────────────────────────────────────────────
 * One file = ONE consistent header on every page.
 *
 * Usage on any page:
 *   <body>
 *     ...
 *     <script src="/nav.js"></script>
 *   </body>
 *
 * The script auto-injects the nav at the top of <body>, replaces
 * any legacy <nav class="topnav"> blocks, and highlights the
 * current page based on window.location.pathname.
 *
 * Features:
 *   • Sticky header with logo, 4 grouped dropdowns, coin search,
 *     live-status pill
 *   • Auto-active highlighting (which category + which item)
 *   • Mobile burger menu (collapses dropdowns into a vertical list)
 *   • Self-contained CSS (works on any page, dark theme aware)
 *   • Live status badge polls /api/lmc/status every 30s
 *   • Coin search jumps to /coin.html?sym=XXX
 */
// ── Global helpers (available on every page that loads nav.js) ──
// iter 83 — Binance trade-page URL builder.  Splits SYMBOL into BASE_QUOTE
// (e.g. "NEIROUSDT" → "NEIRO_USDT") so the deep link works.
window.bnBinanceUrl = function (sym) {
  sym = String(sym || '').toUpperCase().trim();
  if (!sym) return 'https://www.binance.com/en/trade';
  // Insert _ before common quote currencies
  for (const quote of ['USDT', 'BUSD', 'FDUSD', 'USDC', 'BTC', 'BNB', 'ETH']) {
    if (sym.endsWith(quote) && sym.length > quote.length) {
      return `https://www.binance.com/en/trade/${sym.slice(0, -quote.length)}_${quote}?type=spot`;
    }
  }
  return `https://www.binance.com/en/trade/${sym}?type=spot`;
};

// iter 83 — Small inline Binance link button.  Returns the HTML for
// a tiny clickable icon next to a symbol.  e.g.:
//   <a class="bn-binance-link" href="..." target="_blank" ...>🟡</a>
//
// iter 127 — Every Binance icon now also emits a sibling 🚀 Quick Trade
// icon so the operator has one-tap access to the in-house trading panel
// from any table that lists symbols (coin detail alerts, early-pump,
// vsp, lmc, ccp, order-flow…).  No per-page changes required — the
// helper is the single source of truth.
window.bnBinanceLinkHtml = function (sym, opts) {
  const url = window.bnBinanceUrl(sym);
  const compact = (opts || {}).compact;
  const label = compact ? '🟡' : '🟡 Binance';
  const binanceLink = `<a class="bn-binance-link" href="${url}" target="_blank" rel="noopener noreferrer" title="Open ${sym} on Binance" onclick="event.stopPropagation()">${label}</a>`;
  const quickLink = window.bnQuickTradeLinkHtml ? window.bnQuickTradeLinkHtml(sym, opts) : '';
  return binanceLink + quickLink;
};

// iter 127 — Internal Quick Trade page link, sibling to the Binance icon.
// Independent helper so pages that want ONLY a Quick Trade icon (no
// Binance) can call it directly.
window.bnQuickTradeUrl = function (sym) {
  sym = String(sym || '').toUpperCase().trim();
  if (!sym) return '/quick-trade.html';
  return `/quick-trade.html?sym=${encodeURIComponent(sym)}`;
};
window.bnQuickTradeLinkHtml = function (sym, opts) {
  const url = window.bnQuickTradeUrl(sym);
  const compact = (opts || {}).compact;
  // iter128 — typographic 'B' mark (BookNow Bogo AI branding) instead
  // of the 🚀 emoji.  Emojis have inconsistent baselines vs the 🟡
  // Binance pill, which the operator noticed as drift.  The B-mark
  // is a span so its width is fixed regardless of label length, and
  // it sits on the same baseline as text.
  const mark = '<span class="b-mark">B</span>';
  const label = compact ? mark : `${mark} Trade`;
  return `<a class="bn-quick-link" href="${url}" title="Open ${sym} in BookNow Quick Trade" onclick="event.stopPropagation()">${label}</a>`;
};

(function () {
  'use strict';
  if (window.__bnNavLoaded) return;  // idempotent
  window.__bnNavLoaded = true;

  // ── Site structure ────────────────────────────────────────────
  const NAV = [
    {
      key: 'trading',
      label: 'Trading',
      icon: '📊',
      items: [
        { href: '/',                       label: 'Monitor',          icon: '📊', desc: 'Live signals + scanner' },
        // iter104 — Order Flow scalper UI added by other-laptop work, surfaced in header.
        { href: '/order_flow.html',        label: 'Order Flow',       icon: '🌊', desc: 'Scalper — taker BUY/SELL per symbol grouped by mcap tier', highlight: true },
        { href: '/active-monitors.html',   label: 'Active Monitors',  icon: '🎛️', desc: 'Currently held positions' },
        { href: '/pending-monitor.html',   label: 'Pending Buys',     icon: '⏳', desc: 'Limit orders waiting to fill' },
        { href: '/spot.html',              label: 'Spot Tickers',     icon: '📋', desc: 'Top movers + volume leaders' },
        { href: '/metrics.html',           label: 'Metrics',          icon: '📈', desc: 'Aggregate trade stats' },
      ],
    },
    {
      key: 'detectors',
      label: 'Detectors',
      icon: '🎯',
      items: [
        { href: '/coin.html',              label: 'Coin Detail',      icon: '🔬', desc: 'One-stop deep dive — search ANY coin',  highlight: true },
        { href: '/pump-radar.html',        label: 'Pump Radar',       icon: '📡', desc: 'Live 90-day pattern signal (client-side WS) — ARMED/SIGNAL + BUY/TP/STOP', highlight: true },
        { href: '/orderflow-radar.html',   label: 'Order-Flow Radar', icon: '🌊', desc: 'Live burst rhythm — breadth + T+1 confirm + whale prints & buy/sell walls', highlight: true },
        { href: '/early-pump.html',        label: 'Early Pump',       icon: '🚀', desc: 'Stealth accumulation 0-1%' },
        { href: '/vsp.html',               label: 'Volume Spike (VSP)', icon: '⚡', desc: 'Big PUMP vs DUMP classifier' },
        { href: '/lmc.html',               label: 'Low MCap (LMC)',   icon: '💎', desc: 'Small caps getting unusual volume' },
        { href: '/ccp.html',               label: 'Calm Consolidation', icon: '🌊', desc: 'Accumulation phase (vol drying)' },
        { href: '/bounce-watch.html',      label: 'Bounce Watch',     icon: '⤴️', desc: 'Oversold reversal candidates' },
      ],
    },
    // iter122 — '💱 Spot Order' top-level menu.  Previously the manual
    // Trade History + Round Trips + NET P&L dashboard (/premium.html)
    // lived under 'Bots' as 'Premium', which mis-tagged it — those
    // entries are your own manual spot trades, not bot trades.
    {
      key: 'spot',
      label: 'Spot Order',
      icon: '💱',
      items: [
        // iter125 — Quick Trade lands first so it's one click away during pumps.
        { href: '/quick-trade.html',       label: 'Quick Trade',      icon: '🚀', desc: 'Binance WS order book + 2-tap BUY/SELL for explosive pumps', highlight: true },
        { href: '/premium.html',           label: 'Trades & P&L',     icon: '🧾', desc: 'Manual spot trades — history, round trips, NET P&L' },
      ],
    },
    {
      key: 'analysis',
      label: 'Analysis',
      icon: '🔍',
      items: [
        { href: '/decision-trace.html',    label: 'Decision Trace',   icon: '🔍', desc: 'Why was X skipped / bought?' },
        { href: '/pattern-backtest.html',  label: 'Pattern Backtest', icon: '📊', desc: 'Did detections actually win?' },
        { href: '/hard-stop-backtest.html', label: 'Hard-Stop Backtest', icon: '🛑', desc: 'Tune hard-stop %' },
        { href: '/scalper-diagnostic.html', label: 'Scalper Diagnostic', icon: '🔬', desc: 'Why scalper picked / rejected' },
        { href: '/limit-buy-replay.html',  label: 'Limit-Buy Replay', icon: '🔄', desc: 'Replay pending-cancel events' },
        { href: '/filter-candidate.html',  label: 'Filter Tester',    icon: '🧪', desc: 'Test check-coin pipeline on any sym' },
        { href: '/profit_analysis.html',   label: 'Profit Analysis',  icon: '💰', desc: 'P&L analysis' },
        { href: '/adaptive-offset.html',   label: 'Adaptive Offset',  icon: '🎯', desc: 'Per-coin entry offsets' },
        { href: '/adaptive-eligibility.html', label: 'Adaptive Gate', icon: '✅', desc: 'Per-coin eligibility' },
        { href: '/offset-strategy.html',   label: 'Offset Strategy',  icon: '⚙️', desc: 'Buy-offset config' },
        { href: '/backtest.html',          label: 'Backtest',         icon: '🧮', desc: 'Generic backtest' },
      ],
    },
    {
      key: 'bots',
      label: 'Bots',
      icon: '🤖',
      items: [
        { href: '/pattern-bot.html',       label: 'Pattern Bot',      icon: '🤖', desc: 'Pattern-based auto-trader' },
        // iter122 — 'Premium' (really the manual spot Trade History page)
        // moved to its own '💱 Spot Order' top-level menu above.
        { href: '/pro.html',               label: 'Pro',              icon: '🎖️', desc: 'Pro tier' },
      ],
    },
    // Z-iter4 — Zerodha (Kite Connect) dashboard.  Separate top-level
    // menu so it never gets confused with Binance pages.  Backend lives
    // in book-now-zerodha-backend (port 8084).
    {
      key: 'zerodha',
      label: 'Zerodha',
      icon: '🇮🇳',
      items: [
        { href: '/zerodha-equity-scanner.html',    label: 'Equity Scanner',    icon: '🔍', desc: 'NIFTY 100 — top picks, gainers, volume surge, near day high', highlight: true },
        { href: '/zerodha-commodity-scanner.html', label: 'Commodity Scanner', icon: '🛢️', desc: 'MCX front-months — tiles, gainers, chain explorer, Price Planner', highlight: true },
        { href: '/zerodha-stock-chart.html',       label: 'Stock Workspace',   icon: '📊', desc: 'NSE/BSE workspace — chart + BUY/SELL + order book + 🎯 Price Planner' },
        { href: '/zerodha-commodity-chart.html',   label: 'Commodity Workspace', icon: '📊', desc: 'MCX workspace — chart + lot-aware BUY/SELL + order book + 🎯 Price Planner' },
        { href: '/zerodha-stock-detail.html',      label: 'Stock Detail',      icon: '📈', desc: 'Per-NSE/BSE-symbol deep dive — depth, VWAP, sell-price planner, GTTs' },
        { href: '/zerodha-commodity-detail.html',  label: 'Commodity Detail',  icon: '🛢️', desc: 'Per-MCX-contract deep dive — depth, lot/margin, expiry chain, planner' },
        { href: '/zerodha-orderflow-spot.html',    label: 'Spot Order Flow',   icon: '🌊', desc: 'NSE/BSE — buy/sell pressure, VWAP gap, day-range positioning' },
        { href: '/zerodha-orderflow-mcx.html',     label: 'MCX Order Flow',    icon: '🛢️', desc: 'CRUDE/GOLD/NATGAS — pressure + VWAP gap per front-month' },
        { href: '/zerodha.html',                   label: 'Overview',          icon: '📊', desc: 'Session + funds + holdings + positions at a glance' },
        { href: '/zerodha-spot.html',              label: 'Spot Equity',       icon: '🧾', desc: 'NSE/BSE — CNC delivery buy/sell + OCO GTT for SL/TP' },
        { href: '/zerodha-mcx.html',               label: 'MCX Commodity',     icon: '🛢️', desc: 'CRUDE/GOLD/NATGAS — front-month resolver + lot-aware orders' },
        { href: '/zerodha-portfolio.html',         label: 'Portfolio',         icon: '💼', desc: 'Holdings + positions + orders + trades + GTT triggers' },
      ],
    },
    {
      key: 'admin',
      label: 'Admin',
      icon: '🛠️',
      items: [
        { href: '/logs.html',              label: 'Live Logs',        icon: '📜', desc: 'Real-time tail of every subprocess log', highlight: true },
        { href: '/admin.html',             label: 'Service Controls', icon: '🛠️', desc: 'Restart backend, flush Redis, diagnostics' },
        { href: '/scalper-diagnostic.html', label: 'Scalper Diagnostic', icon: '🔬', desc: 'Smart-restart watcher + crash history' },
        // iter104 — Delisted coins page (scraped Binance announcements) added by other-laptop work.
        { href: '/delisted.html',          label: 'Delisted Coins',   icon: '🚫', desc: 'Binance scraped delistings — scalper auto-blocks these' },
      ],
    },
  ];

  // ── Inject CSS ────────────────────────────────────────────────
  const CSS = `
    :root {
      --bn-bg: #0c1116;
      --bn-panel: #141b24;
      --bn-panel-2: #1a232e;
      --bn-line: #1f2933;
      --bn-accent: #29b6f6;
      --bn-good: #2ecc71;
      --bn-bad: #e74c3c;
      --bn-warn: #f1c40f;
      --bn-text: #e6edf3;
      --bn-muted: #8b949e;
    }
    .bn-nav-spacer { height: 56px; }

    /* iter 83 — Binance quick-link button (compact inline + full size) */
    .bn-binance-link {
      display: inline-flex; align-items: center; justify-content: center;
      gap: 4px;
      padding: 2px 7px;
      border-radius: 4px;
      background: rgba(243, 186, 47, 0.12);
      border: 1px solid rgba(243, 186, 47, 0.35);
      color: #f3ba2f !important;
      text-decoration: none !important;
      font-size: 11px; font-weight: 700;
      line-height: 1.4;
      transition: background .12s, transform .12s;
    }
    .bn-binance-link:hover {
      background: rgba(243, 186, 47, 0.25);
      transform: translateY(-1px);
    }
    .bn-binance-link.large {
      padding: 8px 16px; font-size: 13px; border-radius: 7px;
    }
    /* iter 127 — Quick Trade quick-link button.  Sits next to the Binance
       icon and shares the same baseline so the row stays balanced.
       iter 128 — typographic 'B' brand mark replaces the 🚀 emoji; the
       outer pill is tighter and vertical-align middle keeps it on the
       same baseline as the 🟡 chip even when fonts differ. */
    .bn-quick-link {
      display: inline-flex; align-items: center; justify-content: center;
      gap: 4px;
      padding: 1px 5px;
      margin-left: 4px;
      border-radius: 4px;
      background: rgba(75, 159, 255, 0.10);
      border: 1px solid rgba(75, 159, 255, 0.35);
      color: #4b9fff !important;
      text-decoration: none !important;
      font-size: 10px; font-weight: 700;
      letter-spacing: 0.2px;
      line-height: 1.3;
      vertical-align: middle;
      transition: background .12s, transform .12s, border-color .12s;
    }
    .bn-quick-link:hover {
      background: rgba(75, 159, 255, 0.22);
      border-color: #4b9fff;
      transform: translateY(-1px);
    }
    .bn-quick-link .b-mark {
      display: inline-flex; align-items: center; justify-content: center;
      width: 13px; height: 13px;
      border-radius: 3px;
      background: #4b9fff;
      color: #fff;
      font-size: 9px;
      font-weight: 900;
      line-height: 1;
      font-family: -apple-system, "Segoe UI", Roboto, Inter, sans-serif;
    }
    .bn-quick-link.large {
      padding: 8px 14px; font-size: 13px; border-radius: 7px;
      margin-left: 8px; gap: 6px;
    }
    .bn-quick-link.large .b-mark {
      width: 18px; height: 18px;
      border-radius: 4px;
      font-size: 12px;
    }
    .bn-nav {
      position: fixed; top: 0; left: 0; right: 0; z-index: 1000;
      height: 56px;
      background: rgba(12, 17, 22, 0.92);
      backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--bn-line);
      display: flex; align-items: center; padding: 0 20px;
      font: 13px/1 -apple-system, "Segoe UI", Roboto, Inter, sans-serif;
      color: var(--bn-text);
    }
    .bn-logo {
      display: flex; align-items: center; gap: 8px;
      font-size: 16px; font-weight: 800; letter-spacing: -.2px;
      color: var(--bn-text); text-decoration: none; padding-right: 14px;
      margin-right: 14px; border-right: 1px solid var(--bn-line); height: 32px;
    }
    .bn-logo .bn-logo-mark {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; border-radius: 7px;
      background: linear-gradient(135deg, var(--bn-accent) 0%, #1e88e5 100%);
      font-size: 14px;
    }
    .bn-logo .bn-logo-text { background: linear-gradient(90deg, #fff 0%, var(--bn-accent) 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .bn-cats { display: flex; gap: 2px; flex: 1; }
    .bn-cat {
      position: relative;
      padding: 0 14px; height: 56px;
      display: flex; align-items: center; gap: 6px;
      color: var(--bn-muted); font-size: 13px; font-weight: 600;
      cursor: pointer; background: transparent; border: 0; outline: none;
      border-bottom: 2px solid transparent;
      transition: color .15s, border-color .15s;
    }
    .bn-cat:hover { color: var(--bn-text); }
    .bn-cat.active { color: var(--bn-text); border-bottom-color: var(--bn-accent); }
    .bn-cat .bn-chev { font-size: 9px; opacity: .6; }
    .bn-dropdown {
      position: absolute; top: 100%; left: 0;
      min-width: 280px; max-width: 340px;
      background: var(--bn-panel);
      border: 1px solid var(--bn-line);
      border-top: 0;
      border-radius: 0 0 10px 10px;
      box-shadow: 0 8px 24px rgba(0,0,0,.4);
      padding: 6px;
      display: none; flex-direction: column;
      animation: bnDrop .15s ease-out;
    }
    @keyframes bnDrop { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
    .bn-cat:hover .bn-dropdown,
    .bn-cat.open .bn-dropdown { display: flex; }
    .bn-item {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 9px 12px; border-radius: 6px;
      color: var(--bn-text); text-decoration: none;
      font-size: 13px;
      transition: background .12s;
    }
    .bn-item:hover { background: var(--bn-panel-2); }
    .bn-item.active { background: rgba(41, 182, 246, .15); color: var(--bn-accent); }
    .bn-item.highlight:not(.active) { background: rgba(41, 182, 246, .06); }
    .bn-item-ic { font-size: 16px; line-height: 18px; min-width: 22px; text-align: center; }
    .bn-item-body { flex: 1; min-width: 0; }
    .bn-item-label { font-weight: 600; }
    .bn-item-desc { font-size: 11px; color: var(--bn-muted); margin-top: 2px; line-height: 1.3; }
    .bn-item.active .bn-item-desc { color: rgba(41, 182, 246, .8); }
    .bn-search {
      display: flex; align-items: center; gap: 6px;
      background: var(--bn-panel-2); border: 1px solid var(--bn-line);
      border-radius: 7px; padding: 0 10px; height: 32px;
      margin: 0 10px; min-width: 200px;
      transition: border-color .15s, box-shadow .15s;
    }
    .bn-search:focus-within { border-color: var(--bn-accent); box-shadow: 0 0 0 3px rgba(41, 182, 246, .15); }
    .bn-search-icon { color: var(--bn-muted); font-size: 13px; }
    .bn-search input {
      flex: 1; background: transparent; border: 0; outline: none;
      color: var(--bn-text); font-size: 13px; font-weight: 600;
      text-transform: uppercase; letter-spacing: .3px;
      min-width: 0;
    }
    .bn-search input::placeholder { color: var(--bn-muted); text-transform: none; letter-spacing: 0; font-weight: 400; }
    .bn-status {
      display: flex; align-items: center; gap: 6px;
      padding: 5px 11px;
      border-radius: 14px;
      font-size: 11px; font-weight: 700;
      background: var(--bn-panel-2);
      border: 1px solid var(--bn-line);
      color: var(--bn-muted);
      cursor: default;
    }
    .bn-status .bn-dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--bn-muted);
    }
    .bn-status.live .bn-dot { background: var(--bn-good); animation: bnPulse 1.6s ease-in-out infinite; }
    .bn-status.paper .bn-dot { background: var(--bn-warn); }
    .bn-status.live { color: var(--bn-good); border-color: rgba(46, 204, 113, .35); }
    .bn-status.paper { color: var(--bn-warn); border-color: rgba(241, 196, 15, .35); }
    @keyframes bnPulse { 0%,100% { opacity: 1; } 50% { opacity: .4; } }
    .bn-burger {
      display: none;
      background: transparent; border: 0; color: var(--bn-text);
      font-size: 20px; cursor: pointer; padding: 0 8px;
    }

    /* Mobile */
    @media (max-width: 820px) {
      .bn-cats { display: none; }
      .bn-search { display: none; }
      .bn-burger { display: block; }
      .bn-nav { padding: 0 14px; }
      .bn-nav.mobile-open .bn-cats {
        display: flex; flex-direction: column;
        position: fixed; top: 56px; left: 0; right: 0; bottom: 0;
        background: var(--bn-bg); padding: 16px;
        overflow-y: auto; gap: 4px;
      }
      .bn-nav.mobile-open .bn-cat {
        height: auto; padding: 14px;
        border-bottom: 1px solid var(--bn-line);
        flex-direction: column; align-items: flex-start;
        gap: 0;
      }
      .bn-nav.mobile-open .bn-dropdown {
        position: static; display: flex !important;
        box-shadow: none; border: 0; padding: 6px 0 0 0;
        min-width: 0; max-width: none; background: transparent;
        animation: none;
      }
      .bn-nav.mobile-open .bn-search {
        display: flex; margin: 14px 16px 0; min-width: 0;
      }
    }
  `;
  const styleEl = document.createElement('style');
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);

  // ── Build nav HTML ────────────────────────────────────────────
  const currentPath = window.location.pathname.replace(/\/+$/, '') || '/';
  function isActive(href) {
    if (href === '/') return currentPath === '/' || currentPath === '/index.html' || currentPath === '/monitor.html';
    return currentPath === href || currentPath.startsWith(href.replace(/\.html$/, ''));
  }
  function categoryActive(items) {
    return items.some(it => isActive(it.href));
  }

  const catsHtml = NAV.map(cat => {
    const active = categoryActive(cat.items);
    const itemsHtml = cat.items.map(it => {
      const a = isActive(it.href);
      const hl = it.highlight ? 'highlight' : '';
      return `
        <a class="bn-item ${a ? 'active' : ''} ${hl}" href="${it.href}">
          <span class="bn-item-ic">${it.icon}</span>
          <span class="bn-item-body">
            <div class="bn-item-label">${it.label}</div>
            <div class="bn-item-desc">${it.desc || ''}</div>
          </span>
        </a>
      `;
    }).join('');
    return `
      <div class="bn-cat ${active ? 'active' : ''}" tabindex="0">
        <span>${cat.icon}</span>
        <span>${cat.label}</span>
        <span class="bn-chev">▼</span>
        <div class="bn-dropdown">${itemsHtml}</div>
      </div>
    `;
  }).join('');

  const navHtml = `
    <a class="bn-logo" href="/" title="Book-Now Trading Dashboard">
      <span class="bn-logo-mark">⚡</span>
      <span class="bn-logo-text">BookNow</span>
    </a>
    <div class="bn-cats">${catsHtml}</div>
    <div class="bn-search">
      <span class="bn-search-icon">🔍</span>
      <input id="bn-search-input" type="text" placeholder="Find coin — e.g. BTCUSDT" autocomplete="off" />
    </div>
    <div class="bn-status" id="bn-status-pill" title="Live trading status">
      <span class="bn-dot"></span>
      <span id="bn-status-text">…</span>
    </div>
    <button class="bn-burger" id="bn-burger" title="Menu">☰</button>
  `;

  // ── Mount ─────────────────────────────────────────────────────
  // Remove any pre-existing legacy <nav class="topnav"> blocks.
  document.querySelectorAll('nav.topnav, .scanner-topwrap > nav.topnav').forEach(n => n.remove());
  // Also remove old wrap if it became empty
  document.querySelectorAll('.scanner-topwrap').forEach(w => {
    if (!w.children.length || (w.children.length === 1 && w.firstElementChild.classList?.contains('bn-nav'))) {
      // Keep if it has content beyond nav (e.g., cmd-bar)
    }
  });

  const nav = document.createElement('nav');
  nav.className = 'bn-nav';
  nav.innerHTML = navHtml;
  document.body.insertBefore(nav, document.body.firstChild);

  // Spacer so content isn't hidden under fixed nav
  const spacer = document.createElement('div');
  spacer.className = 'bn-nav-spacer';
  document.body.insertBefore(spacer, nav.nextSibling);

  // ── Wire interactions ─────────────────────────────────────────
  // Mobile burger
  document.getElementById('bn-burger').addEventListener('click', () => {
    nav.classList.toggle('mobile-open');
  });

  // Search → /coin.html?sym=...
  const searchInput = document.getElementById('bn-search-input');
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      let sym = searchInput.value.trim().toUpperCase();
      if (!sym) return;
      if (!sym.endsWith('USDT')) sym = sym + 'USDT';
      window.location.href = `/coin.html?sym=${sym}`;
    }
  });

  // Click-to-toggle dropdowns (in case hover doesn't work, e.g. tablets)
  nav.querySelectorAll('.bn-cat').forEach(catEl => {
    catEl.addEventListener('click', (e) => {
      if (e.target.closest('.bn-item')) return;  // clicking an item should just navigate
      const wasOpen = catEl.classList.contains('open');
      nav.querySelectorAll('.bn-cat.open').forEach(c => c.classList.remove('open'));
      if (!wasOpen) catEl.classList.add('open');
      e.stopPropagation();
    });
  });
  document.addEventListener('click', () => {
    nav.querySelectorAll('.bn-cat.open').forEach(c => c.classList.remove('open'));
  });

  // ── Live status poller ────────────────────────────────────────
  async function pollStatus() {
    const pill = document.getElementById('bn-status-pill');
    const txt = document.getElementById('bn-status-text');
    try {
      // Use /api/lmc/status as a proxy — it returns mode (LIVE / PAPER).
      // Could also fetch /api/coin-trade-status if we add it later.
      const r = await fetch('/api/lmc/status').catch(() => null);
      if (!r || !r.ok) {
        pill.className = 'bn-status';
        txt.textContent = '— offline';
        return;
      }
      const d = await r.json();
      if (d.mode === 'LIVE') {
        pill.className = 'bn-status live';
        txt.textContent = 'LIVE';
      } else {
        pill.className = 'bn-status paper';
        txt.textContent = 'PAPER';
      }
    } catch (_) {
      pill.className = 'bn-status';
      txt.textContent = '—';
    }
  }
  pollStatus();
  setInterval(pollStatus, 30000);
})();
