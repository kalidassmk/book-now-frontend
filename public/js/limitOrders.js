/**
 * public/js/limitOrders.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages the display of active limit orders being monitored by the server.
 */

const limitOrders = (() => {
    const ordersMap = new Map();

    /**
     * Update the list with data from the server.
     * @param {object} order { orderId, symbol, side, limitPrice, qty, status, time, source }
     */
    function update(order) {
        const id = order.orderId;
        if (!id) return;

        const status = order.status;
        if (status === 'FILLED' || status === 'CANCELED' || status === 'EXPIRED') {
            if (ordersMap.has(id)) {
                // UX Improvement: Fade out card before removing
                const el = document.querySelector(`.order-card[data-id="${id}"]`);
                if (el) el.classList.add('fade-out');
                
                setTimeout(() => {
                    ordersMap.delete(id);
                    if (status === 'FILLED') {
                        showToast(`✅ Order FILLED: ${order.symbol} @ ${order.limitPrice}`, 'success');
                    }
                    render();
                }, 300);
            }
        } else {
            // Merge logic: If exists, update. If new, add.
            const existing = ordersMap.get(id);
            ordersMap.set(id, { ...existing, ...order });
        }
        render();
    }

    function render() {
        const area = document.getElementById('limit-orders-area');
        if (!area) return;

        if (ordersMap.size === 0) {
            area.innerHTML = '<div class="no-pos-small">No pending orders</div>';
            return;
        }

        const html = Array.from(ordersMap.values()).map(o => {
            const sideClass = o.side === 'BUY' ? 'pos' : 'neg';
            const sourceLabel = o.source === 'BOT' ? '🤖' : '👤';
            return `
                <div class="pos-card order-card" data-id="${o.orderId}">
                    <div class="p-head">
                        <span class="p-sym">${o.symbol} <small style="opacity:0.5">${sourceLabel}</small></span>
                        <span class="p-side ${sideClass}">${o.side}</span>
                    </div>
                    <div class="p-row">
                        <span>Price</span>
                        <span class="p-val">${fmt(o.limitPrice)}</span>
                    </div>
                    <div class="p-row">
                        <span>Status</span>
                        <span class="p-status status-${o.status.toLowerCase()}">
                            ${o.status === 'NEW' ? 'PENDING' : (o.status === 'PARTIALLY_FILLED' ? 'PARTIAL' : o.status)}
                        </span>
                    </div>
                    <button class="btn-cancel" onclick="limitOrders.cancel(${o.orderId}, '${o.symbol}')">Cancel Order</button>
                </div>
            `;
        }).join('');

        area.innerHTML = html;
    }

    async function cancel(orderId, symbol) {
        if (!confirm(`Cancel order ${orderId} for ${symbol}?`)) return;

        try {
            const res = await fetch('/api/order/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderId, symbol })
            });
            const data = await res.json();
            if (data.ok) {
                showToast(`🚫 Order ${orderId} cancelled`, 'success');
                // Update UI immediately (Point 4)
                update({ orderId, symbol, status: 'CANCELED' });
            } else {
                showToast(`❌ Cancel failed: ${data.error}`, 'error');
            }
        } catch (err) {
            showToast('Network error on cancel', 'error');
        }
    }

    return { update, cancel };
})();

// Socket listener
if (typeof socket !== 'undefined') {
    socket.on('order-update', (order) => limitOrders.update(order));
}
