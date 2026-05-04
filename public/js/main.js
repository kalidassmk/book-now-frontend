/**
 * public/js/main.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Application bootstrap and WebSocket event hub.
 *
 * Responsibilities:
 *   1. Open the Socket.io connection
 *   2. Route incoming socket events to the correct renderer module
 *   3. Update the topbar stats on every 'update' event
 *   4. Expose service-control functions used by HTML button onclicks:
 *        stopSpringService()  → POST /api/service/stop
 *        clearRedisCache()    → POST /api/redis/flush
 *        startSpringService() → POST /api/service/start
 *
 * All actual rendering is delegated to the other JS modules:
 *   renderScanner()   → js/scanner.js
 *   renderPositions() → js/positions.js
 *   tradeLog.*        → js/tradeLog.js
 *   applyConfig()     → js/config.js
 *
 * This file should contain NO rendering logic. If you find yourself
 * building HTML strings here, move it to the appropriate module.
 */

// ── Socket connection ─────────────────────────────────────────────────────────

const socket = io();   // Connects to the server that served this page
window.socket = socket; // Expose globally for other modules (wallet.js, etc.)
let currentCurrency = 'USDT'; // 'USDT' or 'INR'
window.lastUpdateData = null;

// ── Connection lifecycle ──────────────────────────────────────────────────────

socket.on('connect',    () => { console.log('[Socket] Connected ✅'); window.utils.setLiveStatus(true); });
socket.on('disconnect', () => { console.warn('[Socket] Disconnected ❌'); window.utils.setLiveStatus(false); });

function toggleCurrency() {
    currentCurrency = currentCurrency === 'USDT' ? 'INR' : 'USDT';
    document.getElementById('currency-label').textContent = currentCurrency + ' Mode';
    if (window.lastUpdateData) {
        renderScanner(window.lastUpdateData.coins || []);
        renderPositions(window.lastUpdateData.activePositions || []);
        const allActive = [...(window.lastUpdateData.activePositions || []), ...(window.lastUpdateData.botPositions || [])];
        renderBotPositions(allActive);
        renderBotSells(window.lastUpdateData.botSells || []);
        _updateStats(window.lastUpdateData.stats || {});
    }
}

// ── Main data update (every POLL_MS from broadcaster) ────────────────────────

socket.on('update', (data) => {
    // Log updates every 10 ticks to avoid flooding
    // window.lastUpdateData = data;

    window.lastUpdateData = data;
    
    // Check for Scalper Signals
    if (data.scalperSignals) {
        Object.values(data.scalperSignals).forEach(sig => {
            if (sig && sig.signal === 'BUY') {
                const now = Date.now();
                if (!window._lastScalperToast || now - window._lastScalperToast > 30000) {
                    toast(`🚀 SCALPER BUY SIGNAL: ${sig.symbol} @ ${sig.price}`, 'g');
                    window._lastScalperToast = now;
                }
            }
        });
    }

    // Update the timestamp in the topbar
    const tsEl = document.getElementById('live-ts-header') || document.getElementById('live-ts');
    if (tsEl) tsEl.textContent = new Date(data.ts).toLocaleTimeString();

    // Delegate rendering to each module
    const coins = data.coins || [];
    const sortedCoins = window.scannerSort ? window.scannerSort.sortCoins([...coins]) : coins;
    renderScanner(sortedCoins, data.scalperSignals || {});
    
    // Deduplicate by symbol to prevent double-showing Manual + Bot entries
    const merged = new Map();
    [...(data.activePositions || []), ...(data.botPositions || [])]
        .filter(p => p.status !== 'CANCELED' && p.status !== 'EXPIRED' && p.status !== 'REJECTED')
        .forEach(p => {
        const existing = merged.get(p.symbol);
        // Prioritize FILLED over anything else, then PARTIALLY_FILLED over NEW
        if (!existing || p.status === 'FILLED' || (existing.status !== 'FILLED' && p.status === 'PARTIALLY_FILLED')) {
            merged.set(p.symbol, p);
        }
    });
    const allActive = Array.from(merged.values());

    // Send only real filled positions (bot + manual) to the sidebar "Positions" tab
    const filledSidebarPositions = allActive.filter(p => p.status === 'FILLED');
    renderPositions(filledSidebarPositions);

    orders.recalcLive(data.coins || []);

    renderBotSells(data.botSells || []);
    _updateStats(data.stats || {});
});

socket.on('trade-executed', (trade) => {
    utils.debugLog(trade.symbol, "Trade Executed ✅", trade);
    showExecModal(trade);
});

socket.on('order-update', (order) => {
    utils.debugLog(order.symbol, "Order Status Update 🔄", order);
});

function showExecModal(t) {
    const modal = document.getElementById('exec-modal');
    const msg   = document.getElementById('exec-msg');
    msg.innerHTML = `<b>${t.symbol}</b> order filled @ <b>${t.buyPrice}</b><br><br>How do you want to sell?`;
    
    // Set up button actions
    document.getElementById('exec-sell-market').onclick = () => {
        orders.quickSell(t.symbol);
        closeExecModal();
    };
    document.getElementById('exec-sell-limit').onclick = () => {
        orders.fillManual(t.symbol, t.buyPrice);
        orders.setMode('LIMIT');
        closeExecModal();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    modal.style.display = 'flex';
}

function closeExecModal() {
    document.getElementById('exec-modal').style.display = 'none';
}



// ── Trade events (fired immediately on buy/sell) ──────────────────────────────

socket.on('trade', (trade) => {
    tradeLog.addTrade(trade);
    _toastTrade(trade);
});

// ── Config sync (on connect and after POST /api/config) ──────────────────────

socket.on('config', (cfg) => {
    applyConfig(cfg);
});

// ── Full trade history (received once on connect) ─────────────────────────────

socket.on('trades', (data) => {
    tradeLog.setTrades(data.trades || []);
});

// ── Service status events (fired by stop/start endpoints) ────────────────────

socket.on('service-status', (data) => {
    _updateSvcStatus(data.running);
    if (data.running) {
        toast('✅ Spring Boot service started', 'g');
    } else {
        toast('⏹ Spring Boot service stopped', 'y');
    }
});

// Fired when a Redis flush completes on the server (updates other open tabs)
socket.on('redis-flushed', () => {
    toast('🗑️ Redis cache cleared', 'y');
});

// ── Poll service status once on page load ─────────────────────────────────────

(async function initServiceStatus() {
    try {
        const res  = await fetch('/api/service/status');
        const data = await res.json();
        _updateSvcStatus(data.running);
    } catch { /* server not yet ready */ }
})();

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Update all stat pills in the topbar.
 * @param {object} s  Stats object from server
 */
function _updateStats(s) {
    // Fast mover count — shows "10 / 47" if more exist than are displayed
    document.getElementById('s-count').textContent = s.fastDisplayed || s.fastCount || 0;
    const totalEl = document.getElementById('s-total-fast');
    totalEl.textContent = (s.fastCount > (s.fastDisplayed || 0))
        ? `/ ${s.fastCount}`
        : '';

    // Open positions count
    document.getElementById('s-pos').textContent = s.positions || 0;

    // Realized P&L (colour changes with sign)
    const pnl   = parseFloat(s.totalPnL || 0);
    const pnlEl = document.getElementById('s-pnl');
    pnlEl.textContent = (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(4);
    pnlEl.className   = 'sp-val ' + (pnl >= 0 ? 'green' : 'red');

    // Auto-trade status
    const autoEl = document.getElementById('s-auto');
    autoEl.textContent = s.autoEnabled ? '✅ ON' : 'OFF';
    autoEl.style.color = s.autoEnabled ? 'var(--green)' : 'var(--dim)';

    // Wallet count
    const walletEl = document.getElementById('s-wallet-count');
    if (walletEl) walletEl.textContent = s.walletAssets || 0;
}

/**
 * Show a contextual toast when a trade fires.
 * @param {object} t  Trade event object
 */
function _toastTrade(t) {
    if (t.action === 'BUY') {
        toast(`🟢 BUY ${t.symbol} @ ${fmt(t.price)}`, 'g');
    } else {
        const profit = parseFloat(t.pnlPct || 0) > 0;
        toast(`${profit ? '💰' : '🔴'} SELL ${t.symbol} ${t.pnlPct ? t.pnlPct + '%' : ''} | $${t.realizedPnL || 0}`, profit ? 'g' : 'r');
    }
}
// ── Bot Positions Renderer ────────────────────────────────────────────────────
/**
 * Render active positions into the horizontal #bot-positions strip.
 * This is the feature requested to be restored.
 */
function renderBotPositions(positions) {
    const area = document.getElementById('bot-positions');
    const countEl = document.getElementById('bot-pos-count');
    if (!area) return;

    if (countEl) countEl.textContent = `${positions.length} total`;

    if (!positions.length) {
        area.innerHTML = '<div class="bot-strip-empty">No active bot trades right now</div>';
        return;
    }

    const cardsHtml = positions.map(p => {
        const isExecuted = p.status === 'FILLED';
        const isPending  = p.status === 'NEW' || p.status === 'PARTIALLY_FILLED';
        
        // 🔹 2. Order State Handling
        let displayStatus = p.status;
        if (p.status === 'NEW') displayStatus = 'PENDING';
        else if (p.status === 'PARTIALLY_FILLED') displayStatus = 'PARTIAL';
        else if (p.status === 'FILLED') displayStatus = 'BOUGHT';

        // 🔹 4. P&L Calculation (FIX)
        const pnl = isExecuted ? (p.pnlPct ?? 0) : 0;
        const profit = pnl >= 0;
        const pnlStr = isExecuted ? (pnl > 0 ? `+${pnl.toFixed(2)}%` : `${pnl.toFixed(2)}%`) : '0.00%';
        
        let pnlLabel = '0.00';
        if (isExecuted) {
            pnlLabel = currentCurrency === 'USDT' 
                ? (p.pnlUsdt != null ? (p.pnlUsdt >= 0 ? `+$${p.pnlUsdt.toFixed(2)}` : `-$${Math.abs(p.pnlUsdt).toFixed(2)}`) : 'Est. P&L')
                : (p.pnlInr != null ? (p.pnlInr >= 0 ? `+₹${p.pnlInr.toFixed(2)}` : `-₹${Math.abs(p.pnlInr).toFixed(2)}`) : 'Est. P&L');
        } else {
            pnlLabel = currentCurrency === 'USDT' ? '$0.00' : '₹0.00';
        }

        const isManual = p.isManual ? 'manual' : '';
        const badgeLabel = p.isManual ? 'MANUAL' : 'BOT';
        
        // 🔹 6. Optional UI Hint (SAFE)
        let showHint = "";
        if (!isExecuted && p.currentPrice <= p.buyPrice) {
            showHint = `<div class="price-reached-hint">Price Reached - Waiting for Fill</div>`;
        }

        // 🔹 3. Button Logic
        let actionButton = "";
        if (isExecuted) {
            actionButton = `
                <button class="bc-sell-btn" style="background:var(--green); border-color:var(--green); color:#000" onclick="event.stopPropagation(); botSell('${p.symbol}', this)">
                    💰 SELL
                </button>`;
        } else if (isPending) {
            actionButton = `
                <button class="bc-sell-btn" style="background:rgba(239, 68, 68, 0.15); border-color:#ef4444; color:#ef4444" onclick="event.stopPropagation(); limitOrders.cancel('${p.orderId}', '${p.symbol}')">
                    🚫 CANCEL
                </button>`;
        }

        return `
        <div class="bot-card ${isExecuted ? (profit ? 'in-profit' : 'in-loss') : 'is-pending'}" onclick="analyzeCoin('${p.symbol}')">
          <div class="bc-top">
            <div class="bc-sym">${p.symbol}</div>
            <div class="bc-badge ${isManual}">${badgeLabel}</div>
            <div class="bot-strip-hint" style="margin-left:auto">${displayStatus}</div>
          </div>
          
          ${showHint}

          <div class="bc-pnl-wrap" style="display: ${isExecuted ? 'block' : 'none'}">
            <div class="bc-pnl-num ${profit ? 'pos' : 'neg'}">${pnlStr}</div>
            <div class="bc-pnl-label">${pnlLabel}</div>
          </div>
          
          <div class="bc-prices">
            <div class="bc-price-item">
              <span class="bc-price-lbl">${isExecuted ? 'BUY PRICE' : 'LIMIT PRICE'}</span>
              <span class="bc-price-val" style="color:var(--blue)">${fmt(p.buyPrice)}</span>
            </div>
            <div class="bc-price-item">
              <span class="bc-price-lbl">CURRENT</span>
              <span class="bc-price-val ${isExecuted ? (profit ? 'green' : 'amber') : ''}">${fmt(p.currentPrice)}</span>
            </div>
            ${p.executedQty ? `
            <div class="bc-price-item">
              <span class="bc-price-lbl">FILLED</span>
              <span class="bc-price-val">${parseFloat(p.executedQty).toFixed(4)} / ${parseFloat(p.origQty || 0).toFixed(4)}</span>
            </div>` : ''}
          </div>
          
          <div class="bc-actions">
            ${actionButton}
          </div>
        </div>
        `;
    }).join('');

    area.innerHTML = `<div class="bot-strip-track">${cardsHtml}</div>`;
}

// ── Bot Sell History Renderer ─────────────────────────────────────────────────

/**
 * Called by the Sell Now button on each bot position card.
 * Calls POST /api/bot/sell — Spring Boot handles TradeState;
 * falls back to direct Redis manipulation if Spring Boot is down.
 *
 * @param {string} symbol   e.g. "SOLUSDT"
 * @param {HTMLElement} btn The button element (to show spinner/disabled state)
 */
async function botSell(symbol, btn) {
    if (!confirm(`Sell ${symbol} at current market price?`)) return;

    const orig = btn.innerHTML;
    btn.disabled  = true;
    btn.innerHTML = '<span class="spinning">⟳</span> Selling…';

    try {
        const r = await fetch('/api/bot/sell', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ symbol }),
        });
        const data = await r.json();

        if (data.ok) {
            const pnl = data.pnlPct != null ? ` ${data.pnlPct > 0 ? '+' : ''}${data.pnlPct}%` : '';
            toast(`💰 Sold ${symbol}${pnl}`, 'g');
            // Card will disappear on next tick when BUY hash is updated
        } else {
            toast(`❌ Sell failed: ${data.error || 'unknown error'}`, 'r');
            btn.disabled  = false;
            btn.innerHTML = orig;
        }
    } catch (e) {
        toast(`❌ Network error: ${e.message}`, 'r');
        btn.disabled  = false;
        btn.innerHTML = orig;
    }
}

// Listen for bot-sell events (from other tabs or server push)
socket.on('bot-sell', ({ symbol }) => {
    toast(`🤖 Bot sold ${symbol}`, 'g');
});


/**
 * Render Spring Boot completed sell records into #bot-sells-area.
 * Each row shows: symbol, sell price, buy price, profit/loss badge.
 *
 * @param {Array} sells  Array of bot sell objects from server
 */
function renderBotSells(sells) {
    const area    = document.getElementById('bot-sells-area');
    const countEl = document.getElementById('bot-sell-count');
    if (!area) return;

    if (countEl) countEl.textContent = sells.length;

    if (!sells.length) {
        area.innerHTML = '<div class="no-pos">No bot sells yet</div>';
        return;
    }

    area.innerHTML = sells.map(s => {
        const pnl      = s.pnlPct ?? 0;
        const profit   = pnl >= 0;
        const pnlStr   = pnl > 0 ? `+${pnl.toFixed(3)}%` : `${pnl.toFixed(3)}%`;
        const usdtStr  = s.pnlUsdt != null
            ? (s.pnlUsdt >= 0 ? `+$${s.pnlUsdt.toFixed(4)}` : `-$${Math.abs(s.pnlUsdt).toFixed(4)}`)
            : '';
        const sp       = s.sellPrice ? fmt(s.sellPrice) : '—';
        const bp       = s.buyPrice  ? fmt(s.buyPrice)  : '—';
        const tsStr    = s.ts
            ? new Date(typeof s.ts === 'object' ? s.ts.time ?? Date.now() : s.ts).toLocaleTimeString()
            : '—';

        return `
        <div class="bot-sell-row">
          <div class="bsr-left">
            <span class="bsr-sym">${s.symbol}</span>
            <span class="bsr-ts">${tsStr}</span>
          </div>
          <div class="bsr-mid">
            <span class="bsr-lbl">Buy</span><span class="bsr-val">${bp}</span>
            <span class="bsr-lbl" style="margin-left:6px">Sell</span><span class="bsr-val">${sp}</span>
          </div>
          <div class="bsr-right">
            <span class="bsr-pnl ${profit ? 'pos' : 'neg'}">${pnlStr}</span>
            <span class="bsr-usdt ${profit ? 'pos' : 'neg'}">${currentCurrency === 'USDT' ? (s.pnlUsdt >= 0 ? `+$${s.pnlUsdt.toFixed(4)}` : `-$${Math.abs(s.pnlUsdt).toFixed(4)}`) : '₹' + (s.pnlInr || 0)}</span>
          </div>
        </div>`;
    }).join('');
}

/**
 * Reflect the Spring Boot running state in the topbar status dot.
 * @param {boolean} running
 */
function _updateSvcStatus(running) {
    const dot   = document.getElementById('svc-dot');
    const label = document.getElementById('svc-status-label');
    if (!dot || !label) return;

    dot.className = 'svc-dot ' + (running ? 'running' : 'stopped');
    label.textContent = running ? 'Running' : 'Stopped';
}

// ── Service control buttons ───────────────────────────────────────────────────

/**
 * Generic helper: disables a button, shows a spinner icon, calls the API,
 * restores the button, and shows a toast result.
 *
 * @param {string}   btnId      ID of the <button> element
 * @param {string}   iconId     ID of the icon <span> inside the button (optional)
 * @param {string}   spinnerGlyph  Character shown while loading
 * @param {string}   url        Fetch URL
 * @param {string}   method     HTTP method
 * @param {function} onSuccess  (json) => void
 * @param {function} onError    (errMsg) => void
 */
async function _svcCall(btnId, iconId, spinnerGlyph, url, method, onSuccess, onError) {
    const btn    = document.getElementById(btnId);
    const iconEl = iconId ? document.getElementById(iconId) : null;
    const origIcon = iconEl ? iconEl.textContent : null;

    // Loading state
    btn.disabled = true;
    if (iconEl) { iconEl.textContent = spinnerGlyph; iconEl.classList.add('spinning'); }

    try {
        const res  = await fetch(url, { method });
        const json = await res.json();
        if (json.ok !== false) {
            onSuccess(json);
        } else {
            onError(json.error || 'Unknown error');
        }
    } catch (err) {
        onError('Could not reach server');
    } finally {
        // Restore button
        btn.disabled = false;
        if (iconEl) { iconEl.classList.remove('spinning'); iconEl.textContent = origIcon; }
    }
}

/**
 * ⏹ Stop the Spring Boot service.
 * Called by the Stop button in the topbar.
 */
async function stopSpringService() {
    await _svcCall(
        'btn-svc-stop', null, null,
        '/api/service/stop', 'POST',
        (json) => {
            _updateSvcStatus(false);
            toast('⏹ Spring Boot stopped', 'y');
        },
        (err) => toast(`❌ Stop failed: ${err}`, 'r')
    );
}

/**
 * 🗑️ Flush all Redis keys and restart the Redis connection.
 * Called by the Clear Cache button in the topbar.
 */
async function clearRedisCache() {
    await _svcCall(
        'btn-flush-redis', 'flush-icon', '⟳',
        '/api/redis/flush', 'POST',
        (json) => toast('🗑️ All Redis keys deleted ✅', 'g'),
        (err)  => toast(`❌ Flush failed: ${err}`, 'r')
    );
}

/**
 * ▶ Start the Spring Boot service.
 * Called by the Start button in the topbar.
 */
async function startSpringService() {
    await _svcCall(
        'btn-svc-start', null, null,
        '/api/service/start', 'POST',
        (json) => {
            _updateSvcStatus(true);
            toast(`✅ Spring Boot started (pid ${json.pid || '?'})`, 'g');
        },
        (err) => toast(`❌ Start failed: ${err}`, 'r')
    );
}

// ── Coin Analysis Modal ───────────────────────────────────────────────────────

const REC_COLOURS = {
    STRONG_BUY: '#22c55e',
    BUY:        '#86efac',
    NEUTRAL:    '#f59e0b',
    WAIT:       '#fb923c',
    DONT_BUY:   '#ef4444',
};

/**
 * Open the analysis modal and fetch 2-month stats for a symbol.
 * Called by scanner rows and bot card buttons.
 *
 * @param {string} symbol  e.g. "SOLUSDT"
 */
async function analyzeCoin(symbol) {
    if (window.intelligence) {
        window.intelligence.renderModal(symbol);
    } else {
        toast('Intelligence module not loaded', 'r');
    }
}

function closeAnalysisModal(event) {
    if (event && event.target !== document.getElementById('analysis-modal')) return;
    document.getElementById('analysis-modal').style.display = 'none';
}

/**
 * Sidebar Tab Switcher
 * @param {string} tab 'live' or 'history'
 */
function switchSideTab(tab) {
    document.querySelectorAll('.s-tab').forEach(t => {
        t.classList.toggle('active', t.textContent.toLowerCase().includes(tab));
    });
    document.querySelectorAll('.side-tab-content').forEach(c => {
        c.classList.toggle('active', c.id === 'side-tab-' + tab);
    });
}

// ── Startup ─────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
    // Initializations if needed
});
