const wallet = {
    balances: [],

    init() {
        console.log("[Wallet Module] Initializing and preparing for live data...");
        
        window.addEventListener('load', () => {
            if (window.socket) {
                console.log("[Wallet Module] Connected to Socket.io. Listening for 'update' events.");
                window.socket.on('update', (data) => {
                    if (data.balances) {
                        // console.log(`[Wallet Module] Received live update: ${data.balances.length} assets found in payload.`);
                        this.balances = data.balances;
                        this.render();
                    }
                });
            } else {
                console.warn("[Wallet Module] Critical Error: Socket.io instance not found on window object.");
            }
        });
    },

    render() {
        const sidebar = document.getElementById('wallet-body');
        const portfolio = document.getElementById('p-wallet-body');
        
        // console.log(`[Wallet Module] Rendering status: Sidebar found? ${!!sidebar}, Portfolio found? ${!!portfolio}`);
        
        if (!sidebar && !portfolio) {
            console.warn("[Wallet Module] CRITICAL: No target containers ('wallet-body' or 'p-wallet-body') found in DOM. Rendering aborted.");
            return;
        }
        
        const assets = this.balances || [];
        // console.log(`[Wallet Module] Processing ${assets.length} assets for render.`);
        
        if (assets.length === 0) {
            console.log("[Wallet Module] No assets available to render yet. Showing sync message.");
            const emptyMsg = `<tr><td colspan="5" style="text-align:center;padding:40px;color:var(--muted)">No assets found. Waiting for Binance sync...</td></tr>`;
            if (sidebar) sidebar.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--muted)">Syncing...</td></tr>`;
            if (portfolio) portfolio.innerHTML = emptyMsg;
            return;
        }

        // console.log(`[Wallet Module] Starting render of ${assets.length} assets.`);

        const sorted = assets.sort((a, b) => {
            const totalA = parseFloat(a.free || 0) + parseFloat(a.locked || 0);
            const totalB = parseFloat(b.free || 0) + parseFloat(b.locked || 0);
            return totalB - totalA;
        });

        if (sidebar) sidebar.innerHTML = sorted.map(b => this._renderRow(b, 'sidebar')).join('');
        if (portfolio) portfolio.innerHTML = sorted.map(b => this._renderRow(b, 'portfolio')).join('');
    },

    _renderRow(b, target) {
        const free = parseFloat(b.free || 0);
        const locked = parseFloat(b.locked || 0);
        const total = free + locked;
        
        // console.log(`[Wallet Module] Row Render: ${b.asset} | Free: ${free} | Target: ${target}`);
        
        let statusHtml = '';
        if (free > 0 && free < 0.01) {
            statusHtml = `<span style="color:var(--muted);font-size:10px">Small Dust</span>`;
        } else if (free >= 0.01) {
            statusHtml = `<span style="color:var(--green);font-weight:600">Available</span>`;
        } else {
            statusHtml = `<span style="color:var(--muted)">Locked</span>`;
        }

        if (target === 'portfolio') {
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
        } else {
            const isDust = free > 0 && free < 1.0 && !['USDT', 'INR', 'BNB', 'BTC', 'ETH'].includes(b.asset);
            const actionBtn = isDust 
                ? `<button class="btn-tiny" style="background:#f0b90b;color:#000;margin-left:5px" onclick="wallet.openDustModal('${b.asset}', ${free})">Transfer</button>`
                : '';
            return `
                <tr>
                    <td style="font-weight:600">${b.asset}</td>
                    <td>${free.toFixed(4)}</td>
                    <td style="color:var(--muted)">${total.toFixed(4)}</td>
                    <td>${statusHtml} ${actionBtn}</td>
                </tr>
            `;
        }
    },

    openDustModal(asset, amount) {
        document.getElementById('dust-asset-name').value = asset;
        document.getElementById('dust-amount').value = amount;
        document.getElementById('dust-modal').style.display = 'flex';
        
        const confirmBtn = document.getElementById('dust-confirm-btn');
        confirmBtn.onclick = () => this.confirmDustTransfer(asset);
    },

    closeDustModal() {
        document.getElementById('dust-modal').style.display = 'none';
    },

    async confirmDustTransfer(asset) {
        const btn = document.getElementById('dust-confirm-btn');
        btn.disabled = true;
        btn.textContent = 'Transferring...';

        try {
            const res = await fetch('/api/wallet/dust-transfer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ asset })
            });
            const data = await res.json();

            if (data.ok) {
                showToast(`Successfully converted ${asset} to BNB!`, 'success');
                this.closeDustModal();
            } else {
                showToast(`Transfer failed: ${data.error || 'Unknown error'}`, 'error');
            }
        } catch (err) {
            showToast(`Network error: ${err.message}`, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Confirm Transfer';
        }
    }
};

window.wallet = wallet;
wallet.init();
