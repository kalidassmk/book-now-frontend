/**
 * public/js/positions.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Renders the active positions panel (right side, top section).
 *
 * Each open position is shown as a card with:
 *   - Live P&L percentage (large, colour-coded)
 *   - Progress bar toward profit target
 *   - Buy price, current price, target, stop-loss
 *   - Hold duration
 *   - "Sell Now" button for immediate exit
 */

/**
 * Re-render the active positions panel.
 * Called every 'update' WebSocket event.
 *
 * @param {Array<object>} posArr  Active position objects from server
 */
function renderPositions(posArr) {
    const el = document.getElementById('positions-area');

    if (!posArr || posArr.length === 0) {
        el.innerHTML = '<div class="no-pos">No open positions</div>';
        return;
    }

    el.innerHTML = posArr.map(_buildCard).join('');
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Build the HTML card for one open position.
 *
 * @param {object} p  Position object (enriched by tradeStore.getEnrichedPositions)
 * @returns {string}  HTML string
 */
function _buildCard(p) {
    const pnlClass = p.pnlPct >= 0 ? 'pos' : 'neg';
    const pnlStr   = (p.pnlPct >= 0 ? '+' : '') + p.pnlPct + '%';

    // Progress toward take-profit (0–100%), capped and floored
    const progress = _calcProgress(p.currentPrice, p.buyPrice, p.target);

    return `
    <div class="pos-card">
      <!-- Header: symbol + signal + hold time -->
      <div class="pos-header">
        <span class="pos-sym">${p.symbol}</span>
        <span class="pos-sig">${p.signal || '—'} · ${p.heldSec}s</span>
      </div>

      <!-- Large P&L display -->
      <div class="pos-pnl ${pnlClass}">${pnlStr}</div>
      <div style="font-size:10px;text-align:center;margin-top:-4px;margin-bottom:8px;color:var(--dim)">
        <span class="${pnlClass}">${currentCurrency === 'USDT' ? '$' + (p.profitUsdt || 0) : '₹' + (p.profitInr || 0)}</span>
      </div>

      <!-- Progress bar toward take-profit -->
      <div style="height:3px;background:var(--border);border-radius:2px;margin-bottom:8px">
        <div style="
          height:100%;
          width:${progress}%;
          background:var(--green);
          border-radius:2px;
          transition:width .5s">
        </div>
      </div>

      <!-- Price details -->
      <div class="pos-row">
        <span class="lbl">Buy @</span>
        <span class="val">${fmt(p.buyPrice)}</span>
      </div>
      <div class="pos-row">
        <span class="lbl">Current</span>
        <span class="val">${fmt(p.currentPrice)}</span>
      </div>
      <div class="pos-row">
        <span class="lbl">Target</span>
        <span class="val" style="color:var(--green)">${fmt(p.target)}</span>
      </div>
      <div class="pos-row">
        <span class="lbl">Stop</span>
        <span class="val" style="color:var(--red)">${fmt(p.stop)}</span>
      </div>

      <!-- Manual sell button -->
      <button class="sell-now"
              style="margin-top:8px"
              onclick="orders.quickSell(event,'${p.symbol}',${p.currentPrice})">
        Sell Now
      </button>
    </div>`;
}

/**
 * Calculate progress percentage from buy price toward the target price.
 * Returns a value clamped between 0–100.
 *
 * @param {number} current
 * @param {number} buy
 * @param {number} target
 * @returns {number}  0-100
 */
function _calcProgress(current, buy, target) {
    if (!target || !buy || target === buy) return 0;
    const pct = ((current - buy) / (target - buy)) * 100;
    return parseFloat(Math.min(100, Math.max(0, pct)).toFixed(1));
}
