/* ──────────────────────────────────────────────────────────────────────────
   alert-kit.js — shared BUY-signal alert toolkit for the client-side radars
   (pump-radar.html, orderflow-radar.html). Mirrors the coin.html mechanism:
     • a one-click "Enable pop-ups" toggle (browser Notification permission)
     • a two-tone WebAudio "ding" that works even without notification perms
     • a tab-title flash so a backgrounded tab still grabs attention
     • per-symbol de-dup so the same coin doesn't ping repeatedly
   Usage:
     <div id="bn-alert-slot"></div>   in the header (button is injected here;
                                      falls back to a floating top-right button)
     <script src="/alert-kit.js"></script>
     BNAlert.notify({ sym:'WLDUSDT', kind:'SIGNAL', price:1.234, body:'…' });
   ────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  const NOTIF_KEY = 'bn_radar_notif_on';      // localStorage: pop-ups wanted
  const DEDUP_MS  = 90 * 1000;                 // suppress repeat ping per coin

  const supported = () => typeof Notification !== 'undefined';
  const wanted    = () => localStorage.getItem(NOTIF_KEY) === '1';
  const live      = () => supported() && wanted() && Notification.permission === 'granted';

  /* ── audio ping (lazy ctx; browsers gate it on a user gesture) ─────────── */
  let _ctx = null;
  function ping() {
    try {
      if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = _ctx, now = ctx.currentTime;
      [{ f: 880, s: 0.0, d: 0.10 }, { f: 1320, s: 0.10, d: 0.14 }].forEach(t => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = t.f;
        g.gain.setValueAtTime(0.0001, now + t.s);
        g.gain.exponentialRampToValueAtTime(0.20, now + t.s + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, now + t.s + t.d);
        o.connect(g).connect(ctx.destination);
        o.start(now + t.s); o.stop(now + t.s + t.d + 0.02);
      });
    } catch (_) {}
  }

  /* ── tab-title flash ───────────────────────────────────────────────────── */
  let _origTitle = null, _flashTimer = null, _flashStep = 0;
  function flashTitle(label) {
    if (_origTitle == null) _origTitle = document.title;
    if (_flashTimer) clearInterval(_flashTimer);
    _flashStep = 0;
    const lab = '🔥 ' + label;
    const tick = () => {
      document.title = (_flashStep % 2 === 0) ? lab : _origTitle;
      if (++_flashStep >= 16) { clearInterval(_flashTimer); _flashTimer = null; document.title = _origTitle; }
    };
    tick();
    _flashTimer = setInterval(tick, 750);
    window.addEventListener('focus', function stop() {
      if (_flashTimer) { clearInterval(_flashTimer); _flashTimer = null; }
      document.title = _origTitle || document.title;
      window.removeEventListener('focus', stop);
    }, { once: true });
  }

  /* ── toggle button ─────────────────────────────────────────────────────── */
  function btn() { return document.getElementById('bn-notif-btn'); }
  function injectButton() {
    if (btn()) return;
    const b = document.createElement('button');
    b.id = 'bn-notif-btn';
    b.type = 'button';
    b.style.cssText =
      'cursor:pointer;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.05);' +
      'color:#9ca3af;font-size:12px;font-weight:600;padding:8px 12px;border-radius:12px;' +
      'display:inline-flex;align-items:center;gap:6px;white-space:nowrap;transition:all .15s;';
    b.addEventListener('click', toggle);
    const slot = document.getElementById('bn-alert-slot');
    if (slot) {
      slot.appendChild(b);
    } else {                                   // floating fallback
      b.style.position = 'fixed';
      b.style.top = '14px'; b.style.right = '14px'; b.style.zIndex = '9999';
      document.body.appendChild(b);
    }
    update();
  }
  async function toggle() {
    if (!supported()) { alert('உங்க browser pop-up notifications-ஐ support செய்யல.'); return; }
    if (live()) { localStorage.removeItem(NOTIF_KEY); update(); return; }
    if (Notification.permission === 'denied') {
      alert('Browser settings-ல notifications block ஆயிருக்கு. அங்க enable செஞ்சு மறுபடி try பண்ணுங்க.');
      return;
    }
    let perm = Notification.permission;
    if (perm !== 'granted') perm = await Notification.requestPermission();
    if (perm === 'granted') {
      localStorage.setItem(NOTIF_KEY, '1');
      update();
      try {
        const n = new Notification('🔔 BookNow alerts ON', {
          body: 'புதிய BUY signal வந்ததும் இங்க ping வரும்.', tag: 'bn-notif-enable',
        });
        setTimeout(() => { try { n.close(); } catch (_) {} }, 4000);
      } catch (_) {}
      ping();                                  // unlock audio inside the gesture
    } else { update(); }
  }
  function update() {
    const b = btn(); if (!b) return;
    if (!supported()) { b.textContent = '🔕 Pop-ups unsupported'; b.disabled = true; return; }
    if (live()) {
      b.textContent = '🔔 Alerts ON';
      b.title = 'New BUY pop-ups-ஐ நிறுத்த click பண்ணுங்க';
      b.style.borderColor = 'rgba(14,203,129,.5)'; b.style.color = '#0ecb81';
      b.style.background = 'rgba(14,203,129,.12)';
    } else {
      const blocked = supported() && Notification.permission === 'denied';
      b.textContent = blocked ? '🚫 Pop-ups blocked' : '🔔 Enable alerts';
      b.title = blocked ? 'Notifications browser settings-ல block ஆயிருக்கு'
                        : 'புதிய BUY signal வந்தா browser pop-up கிடைக்க click பண்ணுங்க';
      b.style.borderColor = 'rgba(255,255,255,.15)'; b.style.color = '#9ca3af';
      b.style.background = 'rgba(255,255,255,.05)';
    }
  }

  /* ── public: fire an alert for a fresh BUY signal ──────────────────────── */
  const _last = new Map();                     // sym -> last-fired ts (de-dup)
  function notify(opts) {
    opts = opts || {};
    const sym = opts.sym || '?';
    const now = Date.now();
    if (now - (_last.get(sym) || 0) < DEDUP_MS) return;   // already pinged recently
    _last.set(sym, now);

    ping();
    flashTitle(`${sym} ${opts.kind || 'BUY'}`);

    if (live()) {
      try {
        const kind = (opts.kind || 'BUY').toUpperCase();
        const priceTail = (opts.price != null) ? ` @ $${(+opts.price).toPrecision(6)}` : '';
        const n = new Notification(`🔥 ${sym} — ${kind}`, {
          body: opts.body || `${sym}: ${kind} signal${priceTail}. Click to open the radar.`,
          tag: `bn-radar-${sym}`,
          renotify: true,
        });
        n.onclick = () => { try { window.focus(); } catch (_) {} n.close(); };
        setTimeout(() => { try { n.close(); } catch (_) {} }, 12000);
      } catch (_) {}
    }
  }

  window.BNAlert = { notify, ping, supported, live, _injectButton: injectButton };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectButton);
  else injectButton();
})();
