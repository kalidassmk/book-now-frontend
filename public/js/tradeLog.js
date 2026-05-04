/**
 * public/js/tradeLog.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Renders the trade history log panel.
 *
 * Shows the most recent trades (newest first) with:
 *   - BUY / SELL action badge
 *   - Symbol name
 *   - P&L percentage (for sells) or entry price (for buys)
 *   - SIM badge for simulated trades
 *   - Timestamp
 */

/** In-memory copy of all trades received from the server */
let _trades = [];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Replace the full trade list and re-render.
 * Called when the socket sends the full 'trades' snapshot on connect.
 *
 * @param {Array<object>} trades
 */
function setTrades(trades) {
    _trades = trades || [];
    _render();
}

/**
 * Prepend a new trade to the list and re-render.
 * Called on each 'trade' socket event.
 *
 * @param {object} trade
 */
function addTrade(trade) {
    _trades.unshift(trade);
    _render();
}

// ── Private helpers ───────────────────────────────────────────────────────────

/** Re-render the full trade log. Cap at 50 visible rows. */
function _render() {
    const el = document.getElementById('trade-log');

    if (!_trades.length) {
        el.innerHTML = '<div class="no-pos">No trades yet</div>';
        return;
    }

    el.innerHTML = _trades.slice(0, 50).map(_buildEntry).join('');
}

/**
 * Build one trade log row.
 *
 * @param {object} t  Trade object
 * @returns {string}  HTML string
 */
function _buildEntry(t) {
    const isBuy   = t.action === 'BUY';
    const pnl     = parseFloat(t.pnlPct || 0);
    const pnlCls  = pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : '';
    const pnlStr  = t.pnlPct
                  ? (pnl > 0 ? '+' : '') + t.pnlPct + '%'
                  : fmt(t.price);   // for BUY entries, show entry price

    return `
    <div class="trade-entry">
      <span class="te-action ${isBuy ? 'te-buy' : 'te-sell'}">${t.action}</span>
      <span class="te-sym">${t.symbol}</span>
      <span class="te-pnl ${pnlCls}">${pnlStr}</span>
      ${t.simulation ? '<span class="te-sim">SIM</span>' : ''}
      <span class="te-time">${new Date(t.time).toLocaleTimeString()}</span>
    </div>`;
}
