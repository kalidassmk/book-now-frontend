/*
 * alert-banner.js — iter 78 (2026-05-24)
 * ─────────────────────────────────────────────────────────────────
 * REWRITTEN — no more fat top banner.
 *
 * What changed:
 *   • Old fat horizontal banner at top of every page is GONE.  It
 *     conflicted with the iter77 nav and was hard to read.
 *   • Now: small bell icon injected into the nav bar (after the
 *     coin search) with an unseen-count badge.
 *   • Sound + browser-notification still work for new events.
 *   • Exposes window.bnAlerts = { events, unseen, markSeen() } so
 *     the Coin Detail page (and others) can consume the same data.
 *   • Polls /api/alerts/feed every 5s (unchanged).
 */
(function () {
  if (window.__bookNowAlertsInitialized) return;
  window.__bookNowAlertsInitialized = true;

  const POLL_MS = 5000;
  const FEED_URL = '/api/alerts/feed';
  let lastSeenTs = parseInt(localStorage.getItem('alertsLastSeen') || '0', 10) || (Date.now() - 5 * 60 * 1000);
  let unseen = 0;
  let allEvents = [];
  const listeners = new Set();

  // Exposed API
  window.bnAlerts = {
    get events() { return allEvents; },
    get unseen() { return unseen; },
    markSeen() {
      unseen = 0;
      lastSeenTs = Date.now();
      localStorage.setItem('alertsLastSeen', String(lastSeenTs));
      updateBadge();
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };

  // ── CSS ───────────────────────────────────────────────────────
  const css = `
    .bn-bell {
      position: relative;
      display: inline-flex; align-items: center; justify-content: center;
      width: 34px; height: 34px;
      background: var(--bn-panel-2, #1a232e);
      border: 1px solid var(--bn-line, #1f2933);
      border-radius: 7px;
      color: var(--bn-text, #e6edf3);
      cursor: pointer; font-size: 16px;
      margin: 0 8px 0 4px;
      transition: border-color .15s, background .15s;
    }
    .bn-bell:hover { border-color: var(--bn-accent, #29b6f6); background: var(--bn-panel, #141b24); }
    .bn-bell.flash {
      animation: bnBellFlash .8s ease-out;
    }
    @keyframes bnBellFlash {
      0% { background: var(--bn-good, #2ecc71); transform: scale(1); }
      50% { background: var(--bn-good, #2ecc71); transform: scale(1.15); }
      100% { background: var(--bn-panel-2, #1a232e); transform: scale(1); }
    }
    .bn-bell-badge {
      position: absolute; top: -4px; right: -4px;
      background: var(--bn-bad, #e74c3c); color: #fff;
      font-size: 9px; font-weight: 700;
      padding: 1px 5px; min-width: 16px; height: 16px;
      border-radius: 10px;
      display: flex; align-items: center; justify-content: center;
      line-height: 1;
    }
    .bn-bell-badge.hidden { display: none; }

    /* Dropdown panel that opens from the bell */
    .bn-alerts-pop {
      position: fixed; top: 56px; right: 14px;
      width: 380px; max-height: 60vh;
      background: var(--bn-panel, #141b24);
      border: 1px solid var(--bn-line, #1f2933);
      border-radius: 10px;
      box-shadow: 0 12px 32px rgba(0,0,0,.5);
      overflow: hidden;
      display: none; z-index: 9999;
      flex-direction: column;
      animation: bnDrop .15s ease-out;
    }
    @keyframes bnDrop { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
    .bn-alerts-pop.open { display: flex; }
    .bn-alerts-pop-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px; border-bottom: 1px solid var(--bn-line, #1f2933);
      font-size: 12px; font-weight: 700; color: var(--bn-muted, #8b949e);
      text-transform: uppercase; letter-spacing: .4px;
    }
    .bn-alerts-pop-actions { display: flex; gap: 6px; }
    .bn-alerts-pop-actions button {
      background: var(--bn-panel-2, #1a232e);
      border: 1px solid var(--bn-line, #1f2933);
      color: var(--bn-muted, #8b949e);
      padding: 3px 9px; border-radius: 4px;
      font-size: 11px; cursor: pointer;
    }
    .bn-alerts-pop-actions button:hover { color: var(--bn-text, #e6edf3); border-color: var(--bn-accent, #29b6f6); }
    .bn-alerts-pop-list {
      flex: 1; overflow-y: auto; padding: 6px;
    }
    .bn-alerts-pop-list .empty { padding: 22px; text-align: center; color: var(--bn-muted, #8b949e); font-style: italic; font-size: 12px; }
    .bn-alerts-pop-list a.row {
      display: flex; align-items: flex-start; gap: 8px;
      padding: 8px 10px; border-radius: 6px;
      color: var(--bn-text, #e6edf3); text-decoration: none;
      font-size: 12px;
      transition: background .12s;
    }
    .bn-alerts-pop-list a.row:hover { background: var(--bn-panel-2, #1a232e); }
    .bn-alerts-pop-list .row .ic { font-size: 14px; min-width: 18px; text-align: center; }
    .bn-alerts-pop-list .row .body { flex: 1; min-width: 0; }
    .bn-alerts-pop-list .row .sym { font-weight: 700; }
    .bn-alerts-pop-list .row .meta { font-size: 11px; color: var(--bn-muted, #8b949e); margin-top: 1px; }
    .bn-alerts-pop-list .row .ago { font-size: 10px; color: var(--bn-muted, #8b949e); padding-top: 2px; }
    .bn-alerts-pop-list .row.unseen { background: rgba(41, 182, 246, .06); }
    .bn-alerts-pop-list .row.trade { border-left: 3px solid #c084fc; }
    .bn-alerts-pop-list .row.strong { border-left: 3px solid #2ecc71; }
    .bn-alerts-pop-list .row.watch { border-left: 3px solid #f1c40f; }
    .bn-alerts-pop-list .row.weak { border-left: 3px solid #e67e22; }
    .bn-alerts-pop-list .row.dump { border-left: 3px solid #e74c3c; }
  `;
  const style = document.createElement('style'); style.textContent = css;
  document.head.appendChild(style);

  // ── Inject bell into nav (waits until nav.js has rendered) ────
  function injectBell() {
    const nav = document.querySelector('.bn-nav');
    if (!nav) { setTimeout(injectBell, 100); return; }
    if (nav.querySelector('.bn-bell')) return;  // already injected

    const bell = document.createElement('button');
    bell.className = 'bn-bell';
    bell.title = 'Alerts';
    bell.innerHTML = `🔔<span class="bn-bell-badge hidden" id="bnBellBadge">0</span>`;

    // Insert before the status pill if present, else before burger
    const statusPill = nav.querySelector('.bn-status');
    const burger = nav.querySelector('.bn-burger');
    if (statusPill) nav.insertBefore(bell, statusPill);
    else if (burger) nav.insertBefore(bell, burger);
    else nav.appendChild(bell);

    // Popover panel
    const pop = document.createElement('div');
    pop.className = 'bn-alerts-pop';
    pop.innerHTML = `
      <div class="bn-alerts-pop-header">
        <span>🔔 Recent alerts</span>
        <div class="bn-alerts-pop-actions">
          <button id="bnAlertsSound" title="Toggle sound">🔊</button>
          <button id="bnAlertsNotify" title="Browser notifications">🔕</button>
          <button id="bnAlertsSeen" title="Mark all as seen">✓ seen</button>
        </div>
      </div>
      <div class="bn-alerts-pop-list" id="bnAlertsPopList">
        <div class="empty">waiting for activity…</div>
      </div>
    `;
    document.body.appendChild(pop);

    bell.addEventListener('click', (e) => {
      e.stopPropagation();
      pop.classList.toggle('open');
      if (pop.classList.contains('open')) renderPop();
    });
    document.addEventListener('click', (e) => {
      if (!pop.contains(e.target) && e.target !== bell) pop.classList.remove('open');
    });

    // Toggle sound
    const soundBtn = document.getElementById('bnAlertsSound');
    let soundOn = localStorage.getItem('alertsSound') !== '0';
    soundBtn.textContent = soundOn ? '🔊' : '🔇';
    soundBtn.onclick = (e) => {
      e.stopPropagation();
      soundOn = !soundOn;
      localStorage.setItem('alertsSound', soundOn ? '1' : '0');
      soundBtn.textContent = soundOn ? '🔊' : '🔇';
      window.__bnAlertsSoundOn = soundOn;
    };
    window.__bnAlertsSoundOn = soundOn;

    // Browser notify
    const notifyBtn = document.getElementById('bnAlertsNotify');
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      notifyBtn.textContent = '🔔';
      notifyBtn.style.color = 'var(--bn-good, #2ecc71)';
    }
    notifyBtn.onclick = async (e) => {
      e.stopPropagation();
      if (typeof Notification === 'undefined') return alert('Browser does not support notifications');
      const r = await Notification.requestPermission();
      notifyBtn.textContent = r === 'granted' ? '🔔' : '🔕';
      notifyBtn.style.color = r === 'granted' ? 'var(--bn-good, #2ecc71)' : '';
    };

    // Mark seen
    document.getElementById('bnAlertsSeen').onclick = (e) => {
      e.stopPropagation();
      window.bnAlerts.markSeen();
    };
  }
  injectBell();

  function updateBadge() {
    const badge = document.getElementById('bnBellBadge');
    if (!badge) return;
    if (unseen > 0) {
      badge.classList.remove('hidden');
      badge.textContent = unseen > 99 ? '99+' : String(unseen);
    } else {
      badge.classList.add('hidden');
    }
  }

  function timeAgo(ts) {
    const sec = Math.max(0, (Date.now() - ts) / 1000);
    if (sec < 60) return `${sec.toFixed(0)}s ago`;
    if (sec < 3600) return `${(sec / 60).toFixed(0)}m ago`;
    return `${(sec / 3600).toFixed(1)}h ago`;
  }

  // Classify event into one of 5 categories
  function categorize(ev) {
    if (ev.kind === 'trade') return 'trade';
    if (ev.kind === 'weak_pump') return 'weak';
    if (ev.kind === 'pump_rider') {
      const t = (ev.tier || '').toUpperCase();
      if (t === 'STRONG' || t === 'NORMAL') return 'strong';
      if (t === 'EARLY' || t === 'MEGA') return 'watch';
      return 'watch';
    }
    if (ev.kind === 'early_pump') {
      const s = +ev.score || 0;
      return s >= 80 ? 'strong' : 'watch';
    }
    if (ev.kind === 'vsp') {
      const l = (ev.label || '').toUpperCase();
      if (l.startsWith('BIG_PUMP')) return 'strong';
      if (l.startsWith('BIG_DUMP') || l.startsWith('MODERATE_DUMP')) return 'dump';
      return 'watch';
    }
    if (ev.kind === 'lmc') {
      const l = (ev.label || '').toUpperCase();
      if (l === 'EXPLOSIVE_PUMP') return 'strong';
      if (l.includes('DUMP')) return 'dump';
      return 'watch';
    }
    if (ev.kind === 'ccp') {
      const l = (ev.label || '').toUpperCase();
      if (l === 'CALM_REVERSAL_UP') return 'strong';
      if (l.includes('BREAKDOWN_RISK')) return 'dump';
      return 'watch';
    }
    return 'watch';
  }

  // Build a one-line summary for the popover row
  function summarize(ev) {
    if (ev.kind === 'trade') {
      const a = ev.action || '';
      const p = ev.price != null ? `$${(+ev.price).toPrecision(4)}` : '';
      const pnl = ev.realised_net != null ? ` ${ev.realised_net >= 0 ? '+' : ''}$${(+ev.realised_net).toFixed(2)}` : '';
      return { ic: a === 'BUY' ? '🛒' : (ev.realised_net >= 0 ? '💰' : '🛑'), text: `${a} ${p}${pnl}` };
    }
    if (ev.kind === 'weak_pump') {
      return { ic: '⚠️', text: `WEAK PUMP — ${(ev.reason || '').slice(0, 60)}` };
    }
    if (ev.kind === 'pump_rider') {
      const t = (ev.tier || '').toUpperCase();
      const ic = ({STRONG:'🔥', NORMAL:'🚀', EARLY:'👀', MEGA:'⚠️'})[t] || '⚡';
      const c5 = ev.chg_5m != null ? `+${(+ev.chg_5m).toFixed(2)}%/5m` : '';
      const v5 = ev.vol_surge_5m != null ? `vol ${(+ev.vol_surge_5m).toFixed(1)}×` : '';
      return { ic, text: `PumpRider ${t} ${c5} ${v5}`.trim() };
    }
    if (ev.kind === 'early_pump') {
      const s = +ev.score || 0;
      const chg = ev.change_24h_pct != null ? `${ev.change_24h_pct >= 0 ? '+' : ''}${(+ev.change_24h_pct).toFixed(2)}% 24h` : '';
      return { ic: s >= 80 ? '🚀' : '👀', text: `Early Pump score ${s} · ${chg}` };
    }
    if (ev.kind === 'vsp') {
      const l = ev.label || '';
      const ic = l.includes('BIG_PUMP') ? '🔥' : l.includes('BIG_DUMP') ? '🔴' : l.includes('MODERATE') ? '⚡' : '👀';
      return { ic, text: `VSP ${l} · conf ${ev.confidence ?? '?'}` };
    }
    if (ev.kind === 'lmc') {
      const l = ev.label || '';
      const ic = l === 'EXPLOSIVE_PUMP' ? '💎🚀' : l.includes('DUMP') ? '💎🔴' : '💎';
      return { ic, text: `LMC ${l} · score ${ev.score ?? '?'} · vol ${ev.vol_surge_x ?? '?'}×` };
    }
    if (ev.kind === 'ccp') {
      const l = ev.label || '';
      const ic = l === 'CALM_REVERSAL_UP' ? '🌊⬆️' : l.includes('BREAKDOWN') ? '🌊🔴' : '🌊';
      return { ic, text: `CCP ${l} · score ${ev.score ?? '?'}` };
    }
    return { ic: '•', text: ev.kind || 'event' };
  }

  function renderPop() {
    const list = document.getElementById('bnAlertsPopList');
    if (!list) return;
    if (!allEvents.length) {
      list.innerHTML = '<div class="empty">no recent alerts</div>';
      return;
    }
    list.innerHTML = allEvents.slice(0, 30).map(ev => {
      const cat = categorize(ev);
      const { ic, text } = summarize(ev);
      const unseenCls = ev.ts > lastSeenTs ? 'unseen' : '';
      // iter 83 — inline Binance link
      const bz = (window.bnBinanceLinkHtml || (()=>''))(ev.symbol, { compact: true });
      return `
        <a class="row ${cat} ${unseenCls}" href="/coin.html?sym=${ev.symbol}">
          <span class="ic">${ic}</span>
          <span class="body">
            <span class="sym">${ev.symbol}</span>
            <div class="meta">${text}</div>
          </span>
          ${bz}
          <span class="ago">${timeAgo(ev.ts)}</span>
        </a>
      `;
    }).join('');
  }

  // ── Sound + Notification ──────────────────────────────────────
  let audioCtx = null;
  function beep(freq, dur, type) {
    if (!window.__bnAlertsSoundOn) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      osc.connect(g); g.connect(audioCtx.destination);
      osc.type = type || 'sine'; osc.frequency.value = freq; g.gain.value = .1;
      osc.start();
      g.gain.exponentialRampToValueAtTime(.001, audioCtx.currentTime + dur);
      osc.stop(audioCtx.currentTime + dur);
    } catch (_) {}
  }
  function soundTrade() { beep(880, .15, 'sine'); setTimeout(() => beep(1320, .15, 'sine'), 150); }
  function soundPump()  { beep(660, .20, 'triangle'); }

  function browserNotify(title, body, tag) {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try { new Notification(title, { body, tag, icon: '/favicon.ico' }); } catch (_) {}
  }

  // ── Polling ───────────────────────────────────────────────────
  async function poll() {
    try {
      const r = await fetch(FEED_URL + '?since=0&limit=60');
      if (!r.ok) return;
      const d = await r.json();
      const events = d.events || [];

      // Detect new ones
      const newOnes = events.filter(e => e.ts > lastSeenTs);
      if (newOnes.length > unseen) {
        unseen = newOnes.length;
        updateBadge();
        const bell = document.querySelector('.bn-bell');
        if (bell) {
          bell.classList.add('flash');
          setTimeout(() => bell.classList.remove('flash'), 800);
        }
        const tradeNew = newOnes.find(e => e.kind === 'trade');
        if (tradeNew) {
          soundTrade();
          browserNotify(`Bot ${tradeNew.action}: ${tradeNew.symbol}`,
                        `${tradeNew.price ? '$' + (+tradeNew.price).toPrecision(4) : ''}${tradeNew.realised_net != null ? ' P&L ' + (tradeNew.realised_net >= 0 ? '+' : '') + '$' + (+tradeNew.realised_net).toFixed(2) : ''}`,
                        'trade-' + tradeNew.symbol + '-' + tradeNew.ts);
        } else {
          soundPump();
          const top = newOnes[0];
          browserNotify(`Alert: ${top.symbol}`,
                        summarize(top).text,
                        'alert-' + top.symbol + '-' + top.ts);
        }
      }
      events.sort((a, b) => b.ts - a.ts);
      allEvents = events;

      // Notify subscribers
      listeners.forEach(fn => { try { fn(allEvents); } catch (_) {} });

      // Re-render pop if open
      const pop = document.querySelector('.bn-alerts-pop');
      if (pop && pop.classList.contains('open')) renderPop();
    } catch (_) {}
  }
  poll();
  setInterval(poll, POLL_MS);
})();
