const account = {
    orderLists: [],

    init() {
        console.log("[Account Module] Initializing live data listeners...");
        
        window.addEventListener('load', () => {
            if (window.socket) {
                console.log("[Account Module] Connected to Socket.io. Tracking orders and OCO lists.");
                window.socket.on('update', (data) => {
                    if (data.openOrders) {
                        this.openOrders = data.openOrders;
                        this.renderOpenOrders();
                    }
                    if (data.tradeHistory || data.orderLists) {
                        this.tradeHistory = data.tradeHistory || this.tradeHistory || [];
                        this.orderLists = data.orderLists || this.orderLists || [];
                        this.renderTradeHistory();
                    }
                });
            } else {
                console.warn("[Account Module] Critical Error: Socket.io not found on window object.");
            }
        });
    },

    renderOpenOrders() {
        const list = document.getElementById('open-orders-list');
        const portfolio = document.getElementById('p-orders-body');
        
        // console.log(`[Account Module] Rendering Orders: Sidebar found? ${!!list}, Portfolio found? ${!!portfolio}`);
        
        if (!list && !portfolio) {
            console.warn("[Account Module] No order containers found in DOM. Skipping render.");
            return;
        }
        
        const orders = this.openOrders || [];

        if (orders.length === 0) {
            // console.log("[Account Module] No open orders to render. Showing placeholder.");
            const emptyMsg = '<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--muted)">No open orders</td></tr>';
            if (list) list.innerHTML = emptyMsg;
            if (portfolio) portfolio.innerHTML = '<tr><td colspan="6" class="p-empty">No pending orders found</td></tr>';
            return;
        }

        // console.log(`[Account Module] Processing ${orders.length} open orders for rendering.`);

        const htmlList = orders.map(o => this._renderOrderRow(o, 'list')).join('');
        const htmlPortfolio = orders.map(o => this._renderOrderRow(o, 'portfolio')).join('');

        if (list) list.innerHTML = htmlList;
        if (portfolio) portfolio.innerHTML = htmlPortfolio;
    },

    _renderOrderRow(o, target) {
        const qty = o.quantity || o.origQty || 0;
        const price = o.price || 0;
        const sideClass = o.side === 'BUY' ? 'green' : 'red';

        if (target === 'portfolio') {
            return `
                <tr class="${o.atRisk ? 'at-risk' : ''}">
                    <td style="font-weight:700; color:var(--yellow); font-size:15px">${o.symbol}</td>
                    <td style="font-weight:600; color:var(--${o.side === 'BUY' ? 'green' : 'red'})">${o.side}</td>
                    <td class="mono" style="color:#fff">${utils.fmt(price)}</td>
                    <td class="mono">${utils.fmt(qty)}</td>
                    <td><span class="status-pill ${o.status?.toLowerCase() || 'new'}" style="padding:4px 10px">${o.status || 'NEW'}</span></td>
                    <td>
                        <button class="btn-cancel" onclick="account.cancelOrder('${o.symbol}', '${o.orderId}')" style="background:rgba(239,68,68,0.1); border:1px solid rgba(239,68,68,0.3)">Cancel</button>
                    </td>
                </tr>
            `;
        } else {
            return `
                <tr class="${o.atRisk ? 'at-risk' : ''}">
                    <td class="symbol" style="color:var(--yellow)">${o.symbol}</td>
                    <td class="${sideClass}">${o.side || '---'}</td>
                    <td class="mono">${utils.fmt(price)}</td>
                    <td class="mono">${utils.fmt(qty)}</td>
                    <td><span class="status-pill ${o.status?.toLowerCase() || 'new'}">${o.status || 'NEW'}</span></td>
                    <td>
                        <button class="btn-cancel" onclick="account.cancelOrder('${o.symbol}', '${o.orderId}')">Cancel</button>
                    </td>
                </tr>
            `;
        }
    },

    /**
     * [AUDIT] This function renders the rich trade history data.
     */
    renderTradeHistory() {
        const list = document.getElementById('trade-history-list');
        if (!list) return;

        const trades = this.tradeHistory || [];
        const orderLists = this.orderLists || [];
        
        // Merge and sort everything by time descending
        let allItems = [...trades, ...orderLists];
        allItems.sort((a, b) => (b.time || b.transactionTime) - (a.time || a.transactionTime));

        if (allItems.length === 0) {
            list.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--muted)">No history found</td></tr>';
            return;
        }

        let html = '';
        allItems.forEach(item => {
            const isTrade = !!item.price; 
            const time = new Date(item.time || item.transactionTime).toLocaleString();
            
            if (isTrade) {
                const sideClass = (item.side === 'BUY' || item.isBuyer) ? 'green' : 'red';
                const total = item.totalQuota || (parseFloat(item.price) * parseFloat(item.qty || item.quantity));
                html += `
                    <tr>
                        <td class="symbol" style="font-weight:700">${item.symbol}</td>
                        <td class="${sideClass}" style="font-weight:bold">${item.side || (item.isBuyer ? 'BUY' : 'SELL')}</td>
                        <td class="mono">${parseFloat(item.price).toFixed(6)}</td>
                        <td class="mono">${parseFloat(item.qty || item.quantity).toFixed(4)}</td>
                        <td class="mono" style="font-size:10px; color:var(--muted)">${item.commission || item.fee || '---'} ${item.commissionAsset || item.feeAsset || ''}</td>
                        <td class="mono" style="font-weight:600">$${parseFloat(total || 0).toFixed(2)}</td>
                        <td class="dim" style="font-size:10px">${time}</td>
                    </tr>
                `;
            } else {
                // Flatten OCO groups
                const orders = item.orders || [];
                orders.forEach(o => {
                    html += `
                        <tr>
                            <td class="symbol" style="font-weight:700">${item.symbol}</td>
                            <td class="dim">OCO</td>
                            <td class="mono">---</td>
                            <td class="mono">---</td>
                            <td class="mono">---</td>
                            <td class="mono" style="color:var(--muted)">ID: ${o.orderId}</td>
                            <td class="dim" style="font-size:10px">${time}</td>
                        </tr>
                    `;
                });
            }
        });

        list.innerHTML = html || '<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--muted)">No orders found</td></tr>';
    },

    async fetchTradeHistoryManual() {
        console.log("%c===============================================================", "color: #f0b90b; font-weight: bold");
        console.log(`%c[UI] ======= START OCO LIST FETCH =======`, "color: #f0b90b; font-weight: bold");
        console.log("%c===============================================================", "color: #f0b90b; font-weight: bold");

        try {
            const url = `/api/trade/order-list?limit=100`;
            const res = await fetch(url);
            const data = await res.json();
            
            if (Array.isArray(data)) {
                this.orderLists = data.sort((a, b) => b.transactionTime - a.transactionTime);
                this.renderTradeHistory();
                
                console.log("%c===============================================================", "color: #0ecb81; font-weight: bold");
                console.log(`%c[UI] ======= SUCCESS: FOUND ${data.length} OCO LISTS =======`, "color: #0ecb81; font-weight: bold");
                console.log("%c===============================================================", "color: #0ecb81; font-weight: bold");
            } else {
                throw new Error(data.error || 'Invalid response');
            }
        } catch (e) {
            console.error("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
            console.error(`[UI] ERROR FETCHING ORDER LISTS: ${e.message}`);
            console.error("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
        }
    },

    async cancelOrder(symbol, orderId) {
        if (!confirm(`Cancel order ${orderId} for ${symbol}?`)) return;

        try {
            utils.toast(`Cancelling order ${orderId}...`, 'y');
            const res = await fetch('/api/open-orders/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ symbol, orderId })
            });
            const data = await res.json();

            if (data.ok) {
                utils.toast(`Order ${orderId} cancelled!`, 'g');
            } else {
                utils.toast(`Cancel failed: ${data.error || 'Unknown error'}`, 'r');
            }
        } catch (e) {
            utils.toast('Failed to reach server', 'r');
        }
    }
};

window.account = account;
account.init();
