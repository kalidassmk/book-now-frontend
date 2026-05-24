/*
 * alert-banner.js — iter 60 (2026-05-23)
 * ───────────────────────────────────────────────────────────────────────
 * Drop-in alert overlay for every dashboard page.
 *
 * Watches /api/alerts/feed and shows:
 *   - top-of-page banner with the 5 most recent events
 *   - sound + browser notification on EVERY new event
 *   - persistent unseen badge counter
 *
 * Sources:
 *   - PUMP_RIDER:DETECTIONS:<date>   (volume-leads-price bot signal)
 *   - EARLY_PUMP:DETECTIONS:<date>   (5-factor predictive scoring)
 *   - TRADE_ALERTS:<date>            (the bot itself bought/filled/sold)
 *   - PRICE_PUMP_ALERTS:<date>       (any USDT pair with sharp move)
 */
(function () {
  if (window.__bookNowAlertsInitialized) return;
  window.__bookNowAlertsInitialized = true;

  const POLL_MS = 5000;
  const FEED_URL = '/api/alerts/feed';
  let lastSeenTs = parseInt(localStorage.getItem('alertsLastSeen') || '0', 10) || (Date.now() - 5 * 60 * 1000);
  let unseen = 0;

  // ── DOM ─────────────────────────────────────────────────────────────
  const css = `
  #bookNowAlertBar {
    position: fixed; top: 0; left: 0; right: 0;
    background: linear-gradient(90deg, #0c1116 0%, #1a232e 100%);
    border-bottom: 2px solid #29b6f6;
    color: #e6edf3;
    font: 12px/1.3 -apple-system, "Segoe UI", Roboto, sans-serif;
    z-index: 999999; padding: 6px 14px;
    display: flex; align-items: center; gap: 12px;
    box-shadow: 0 4px 14px rgba(0,0,0,.6);
    max-height: 80px; overflow: hidden;
  }
  #bookNowAlertBar.flash { background: linear-gradient(90deg, #1f5b32 0%, #2ecc71 100%); transition: background 0.4s ease-out; }
  #bookNowAlertBar.flash-trade { background: linear-gradient(90deg, #5a2d6c 0%, #c084fc 100%); }
  #bookNowAlertBar .b-label { font-weight: 700; color: #29b6f6; flex-shrink: 0; padding: 0 8px; border-right: 1px solid #2a3441; }
  #bookNowAlertBar .b-events { flex: 1; display: flex; gap: 14px; overflow-x: auto; }
  #bookNowAlertBar .b-event { white-space: nowrap; padding: 3px 8px; background: rgba(41,182,246,.08); border-radius: 4px; border-left: 3px solid #29b6f6; }
  #bookNowAlertBar .b-event.trade { border-left-color: #c084fc; background: rgba(192,132,252,.10); }
  #bookNowAlertBar .b-event.early { border-left-color: #f1c40f; background: rgba(241,196,15,.08); }
  #bookNowAlertBar .b-event.pump { border-left-color: #2ecc71; background: rgba(46,204,113,.10); }
  #bookNowAlertBar .b-event .sym { font-weight: 700; color: #fff; }
  #bookNowAlertBar .b-event .pos { color: #2ecc71; }
  #bookNowAlertBar .b-event .neg { color: #e74c3c; }
  #bookNowAlertBar .b-event .ago { color: #8b949e; font-size: 10px; margin-left: 6px; }
  #bookNowAlertBar .b-actions { display: flex; gap: 6px; flex-shrink: 0; }
  #bookNowAlertBar .b-btn { background: #1f2933; border: 1px solid #2a3441; color: #8b949e; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 11px; }
  #bookNowAlertBar .b-btn:hover { color: #fff; border-color: #29b6f6; }
  #bookNowAlertBar .b-badge { background: #e74c3c; color: #fff; padding: 1px 7px; border-radius: 10px; font-size: 10px; font-weight: 700; }
  body { padding-top: 40px !important; }
  `;

  const style = document.createElement('style'); style.textContent = css;
  document.head.appendChild(style);

  const bar = document.createElement('div');
  bar.id = 'bookNowAlertBar';
  bar.innerHTML = `
    <span class="b-label">🚨 ALERTS</span>
    <div class="b-events" id="bnAlertEvents"><span class="mute">waiting for activity…</span></div>
    <span class="b-badge" id="bnUnseen" style="display:none;">0</span>
    <div class="b-actions">
      <button class="b-btn" id="bnSoundToggle" title="Toggle sound">🔊</button>
      <button class="b-btn" id="bnNotifyToggle" title="Enable browser notifications">🔔</button>
      <button class="b-btn" id="bnClearSeen">✓ seen</button>
    </div>
  `;
  document.body.insertBefore(bar, document.body.firstChild);

  const eventsEl = document.getElementById('bnAlertEvents');
  const badgeEl = document.getElementById('bnUnseen');
  const soundBtn = document.getElementById('bnSoundToggle');
  const notifyBtn = document.getElementById('bnNotifyToggle');
  const clearBtn = document.getElementById('bnClearSeen');

  let soundOn = localStorage.getItem('alertsSound') !== '0';
  soundBtn.textContent = soundOn ? '🔊' : '🔇';
  soundBtn.onclick = () => {
    soundOn = !soundOn;
    localStorage.setItem('alertsSound', soundOn ? '1' : '0');
    soundBtn.textContent = soundOn ? '🔊' : '🔇';
  };

  notifyBtn.onclick = async () => {
    if (typeof Notification === 'undefined') {
      alert('This browser does not support notifications.');
      return;
    }
    const r = await Notification.requestPermission();
    notifyBtn.style.color = r === 'granted' ? '#2ecc71' : '#e74c3c';
  };

  clearBtn.onclick = () => {
    unseen = 0;
    badgeEl.style.display = 'none';
    lastSeenTs = Date.now();
    localStorage.setItem('alertsLastSeen', String(lastSeenTs));
  };

  // ── Sound ──────────────────────────────────────────────────────────
  let audioCtx = null;
  function beep(freq, duration, type) {
    if (!soundOn) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain); gain.connect(audioCtx.destination);
      osc.type = type || 'sine';
      osc.frequency.value = freq;
      gain.gain.value = 0.10;
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
      osc.stop(audioCtx.currentTime + duration);
    } catch (_) { /* user hasn't interacted yet */ }
  }
  // Two-tone for trade, single chime for pump
  function soundTrade() { beep(880, 0.15, 'sine'); setTimeout(() => beep(1320, 0.15, 'sine'), 150); }
  function soundPump()  { beep(660, 0.20, 'triangle'); }

  // ── Notification ───────────────────────────────────────────────────
  function browserNotify(title, body, tag) {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try { new Notification(title, { body, tag, icon: '/favicon.ico' }); } catch (_) {}
  }

  // ── Rendering ──────────────────────────────────────────────────────
  function timeAgo(ts) {
    const sec = (Date.now() - ts) / 1000;
    if (sec < 60) return `${sec.toFixed(0)}s ago`;
    if (sec < 3600) return `${(sec/60).toFixed(0)}m ago`;
    return `${(sec/3600).toFixed(1)}h ago`;
  }
  function fmtPrice(n) {
    if (n == null) return '—';
    const a = Math.abs(n);
    if (a >= 100) return n.toFixed(2);
    if (a >= 1)   return n.toFixed(4);
    if (a >= 0.01) return n.toFixed(5);
    return n.toFixed(8).replace(/0+$/, '');
  }

  function renderEvents(events) {
    if (!events.length) {
      eventsEl.innerHTML = '<span style="color:#8b949e;">no recent alerts</span>';
      return;
    }
    eventsEl.innerHTML = events.slice(0, 8).map(ev => {
      let kindClass = 'pump';
      let icon = '🚀';
      let body = '';
      if (ev.kind === 'trade') {
        kindClass = 'trade';
        icon = ev.action === 'BUY' ? '🛒' : (ev.realised_net >= 0 ? '💰' : '🛑');
        const p = ev.price != null ? `$${fmtPrice(ev.price)}` : '';
        const pnl = ev.realised_net != null ? ` <span class="${ev.realised_net >= 0 ? 'pos' : 'neg'}">${ev.realised_net >= 0 ? '+' : ''}$${ev.realised_net.toFixed(2)}</span>` : '';
        body = `${ev.action} ${p}${pnl}`;
      } else if (ev.kind === 'early_pump') {
        kindClass = 'early';
        icon = '🟡';
        body = `score ${ev.score} · ${ev.change_24h_pct >= 0 ? '+' : ''}${(ev.change_24h_pct||0).toFixed(2)}% 24h`;
      } else {
        // pump_rider — iter61 tiered output with chg_5m / vol_surge_5m
        const tier = ev.tier || '';
        const tierEmoji = ({STRONG:'🔥', NORMAL:'🚀', EARLY:'👀', MEGA:'⚠️'})[tier] || '🚀';
        icon = tierEmoji;
        const chg5 = ev.chg_5m != null ? `+${ev.chg_5m.toFixed(2)}%/5m` : (ev.price_change_pct ? '+' + ev.price_change_pct.toFixed(2) + '%' : '');
        const vol5 = ev.vol_surge_5m != null ? `vol ${ev.vol_surge_5m.toFixed(1)}x` : (ev.vol_multiple ? 'vol ' + ev.vol_multiple.toFixed(1) + 'x' : '');
        body = `${tier ? '<b>'+tier+'</b> ' : ''}${chg5} · ${vol5}`;
      }
      return `<div class="b-event ${kindClass}">${icon} <span class="sym">${ev.symbol}</span> ${body}<span class="ago">${timeAgo(ev.ts)}</span></div>`;
    }).join('');
  }

  // ── Polling ────────────────────────────────────────────────────────
  async function poll() {
    try {
      const r = await fetch(FEED_URL + '?since=' + lastSeenTs + '&limit=30');
      if (!r.ok) return;
      const d = await r.json();
      const events = d.events || [];
      if (events.length) {
        // New events since last seen — flash + sound
        const newOnes = events.filter(e => e.ts > lastSeenTs);
        if (newOnes.length) {
          unseen += newOnes.length;
          badgeEl.style.display = 'inline-block';
          badgeEl.textContent = unseen;
          const tradeNew = newOnes.find(e => e.kind === 'trade');
          if (tradeNew) {
            bar.classList.add('flash-trade');
            setTimeout(() => bar.classList.remove('flash-trade'), 600);
            soundTrade();
            browserNotify(`Bot ${tradeNew.action}: ${tradeNew.symbol}`,
                          `${tradeNew.price ? '$'+fmtPrice(tradeNew.price) : ''}${tradeNew.realised_net != null ? '  P&L: '+(tradeNew.realised_net>=0?'+':'')+'$'+tradeNew.realised_net.toFixed(2) : ''}`,
                          'trade-' + tradeNew.symbol + '-' + tradeNew.ts);
          } else {
            bar.classList.add('flash');
            setTimeout(() => bar.classList.remove('flash'), 600);
            soundPump();
            const top = newOnes[0];
            browserNotify(`${top.kind === 'early_pump' ? 'Early Pump' : 'Pump'}: ${top.symbol}`,
                          `score ${top.score || ''} ${top.change_24h_pct ? '24h ' + top.change_24h_pct.toFixed(2)+'%' : ''}`,
                          'pump-' + top.symbol + '-' + top.ts);
          }
        }
        // Sort newest first and render
        events.sort((a, b) => b.ts - a.ts);
        renderEvents(events);
      }
    } catch (e) {
      // network hiccup — ignore
    }
  }

  // First load + interval
  poll();
  setInterval(poll, POLL_MS);
})();
