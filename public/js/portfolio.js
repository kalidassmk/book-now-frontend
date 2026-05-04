/**
 * public/js/portfolio.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Portfolio view component — handles rendering of balances and open orders
 * in the full-screen portfolio page.
 *
 * This is a separate component from wallet.js and account.js, which handle
 * the sidebar versions. This one is for the dedicated portfolio view.
 */

const portfolio = {
    init() {
        console.log("[Portfolio Component] Initializing portfolio view...");

        // Listen for socket updates
        if (window.socket) {
            window.socket.on('update', (data) => {
                if (data.balances) {
                    this.renderBalances(data.balances);
                }
                if (data.openOrders) {
                    this.renderOpenOrders(data.openOrders);
                }
            });
        }
    },

    renderBalances(balances) {
        const tbody = document.getElementById('p-wallet-body');
        if (!tbody) return;

        if (!balances || balances.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="p-empty">No balances found</td></tr>';
            return;
        }

        const sorted = balances.sort((a, b) => {
            const totalA = parseFloat(a.free || 0) + parseFloat(a.locked || 0);
            const totalB = parseFloat(b.free || 0) + parseFloat(b.locked || 0);
            return totalB - totalA;
        });

        tbody.innerHTML = sorted.map(b => this._renderBalanceRow(b)).join('');
    },

    _renderBalanceRow(b) {
        const free = parseFloat(b.free || 0);
        const locked = parseFloat(b.locked || 0);
        const total = free + locked;

        let statusHtml = '';
        if (free > 0 && free < 0.01) {
            statusHtml = `<span style="color:var(--muted);font-size:10px">Small Dust</span>`;
        } else if (free >= 0.01) {
            statusHtml = `<span style="color:var(--green);font-weight:600">Available</span>`;
        } else {
            statusHtml = `<span style="color:var(--muted)">Locked</span>`;
        }

        const isDust = free > 0 && free < 1.0 && !['USDT', 'INR', 'BNB', 'BTC', 'ETH'].includes(b.asset);
        const actionBtn = isDust
            ? `<button class="btn-tiny" style="background:#f0b90b;color:#000" onclick="wallet.openDustModal('${b.asset}', ${free})">Transfer</button>`
            : '';

        return `
            <tr>
                <td style="font-weight:700; color:#fff; font-size:15px">${b.asset}</td>
                <td class="mono" style="color:var(--green)">${free.toFixed(8)}</td>
                <td class="mono" style="color:var(--muted)">${locked.toFixed(8)}</td>
                <td class="mono" style="text-align:right; font-weight:600">$0.00</td>
                <td>${statusHtml} ${actionBtn}</td>
            </tr>
        `;
    },

    renderOpenOrders(orders) {
        const tbody = document.getElementById('p-orders-body');
        if (!tbody) return;

        if (!orders || orders.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="p-empty">No pending orders found</td></tr>';
            return;
        }

        tbody.innerHTML = orders.map(o => this._renderOrderRow(o)).join('');
    },

    _renderOrderRow(o) {
        const qty = o.quantity || o.origQty || 0;
        const price = o.price || 0;
        const sideClass = o.side === 'BUY' ? 'green' : 'red';

        return `
            <tr>
                <td style="font-weight:700; color:var(--yellow); font-size:15px">${o.symbol}</td>
                <td style="font-weight:600; color:var(--${sideClass})">${o.side}</td>
                <td class="mono" style="color:#fff">${utils.fmt(price)}</td>
                <td class="mono">${utils.fmt(qty)}</td>
                <td><span class="status-pill ${o.status?.toLowerCase() || 'new'}" style="padding:4px 10px">${o.status || 'NEW'}</span></td>
                <td>
                    <button class="btn-cancel" onclick="account.cancelOrder('${o.symbol}', '${o.orderId}')" style="background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.3)">Cancel</button>
                </td>
            </tr>
        `;
    }
};

window.portfolio = portfolio;
portfolio.init();
