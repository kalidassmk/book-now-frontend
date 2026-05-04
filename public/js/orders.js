/**
 * public/js/orders.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Manual order placement module.
 *
 * Exposes functions called by:
 *   - Quick BUY button in each scanner table row
 *   - Quick SELL button on position cards
 *   - The manual override form (bottom of right panel)
 *
 * Exported to the window.orders namespace so HTML onclick attributes
 * can call them without conflict.
 */

/** Namespace to avoid polluting window globals */
const orders = (() => {

    // ── Internal State ────────────────────────────────────────────────────────
    let currentMode = localStorage.getItem('tradeMode') || 'LIMIT'; 
    let selectedSymbol = '';

    // ── Public ────────────────────────────────────────────────────────────────

    /**
     * Quick BUY from a scanner table row button.
     * Pre-fills the manual form and sends the order immediately.
     *
     * @param {string} symbol
     * @param {Event}  event  Click event (stopped to prevent row selection)
     */
    async function quickBuy(symbol, event) {
        if (event) event.stopPropagation();
        
        let price = 0;
        let buyAmount = 12; // Default USDT fallback
        let target = 0;

        try {
            const res = await fetch('/api/v1/config');
            const cfg = await res.json();
            if (cfg) {
                buyAmount = cfg.buyAmountUsdt || 12;
            }
        } catch (err) {
            console.error('[Orders] QuickBuy config fetch failed:', err);
        }

        // Get price for calculation
        if (currentMode === 'LIMIT') {
            const inp = document.getElementById(`limit-${symbol}`);
            price = inp ? parseFloat(inp.value) : 0;
        } else {
            // Market mode - try to find in scanner data
            if (window.lastUpdateData && window.lastUpdateData.coins) {
                const coin = window.lastUpdateData.coins.find(c => c.symbol === symbol);
                if (coin) price = parseFloat(coin.price);
            }
        }

        if (!price || price <= 0) {
            return toast(`❌ Cannot calculate quantity: Price for ${symbol} is unknown`, 'r');
        }

        // Calculate Qty = USDT / Price
        const qty = buyAmount / price;

        toast(`Placing ${currentMode} Buy: ${symbol} ($${buyAmount.toFixed(2)})...`, 'y');
        await _sendBuy(symbol, (currentMode === 'LIMIT' ? price : 0), qty); 
    }

    /**
     * Quick SELL from a scanner row or position card button.
     *
     * @param {Event}  e
     * @param {string} symbol
     * @param {number} price   Current market price
     */
    async function quickSell(e, symbol, price) {
        e.stopPropagation();
        await _sendSell(symbol, price);
    }

    /**
     * Fill the manual order form with a coin's symbol and price.
     * Called when a scanner table row is clicked.
     *
     * @param {string} symbol
     * @param {number} price
     */
    async function fillManual(symbol, price) {
        updateSymbol(symbol);
        // Do NOT force LIMIT mode here, respect currentMode
        document.getElementById('m-price').value = price || '';
        document.getElementById('m-total').value = 12; // Instant default to prevent flicker
        
        try {
            // Fetch latest master config
            const configRes = await fetch('/api/v1/config');
            const cfg = await configRes.json();
            
            // Check if we already own this coin (to fill the SELL form)
            let ownedQty = 0;
            let buyPrice = price; // fallback

            // Access global data from main.js or wallet.js
            if (window.lastUpdateData) {
                // Check active bot/manual positions
                const pos = [...(window.lastUpdateData.activePositions || []), ...(window.lastUpdateData.botPositions || [])]
                            .find(p => p.symbol === symbol && p.status === 'FILLED');
                if (pos) {
                    ownedQty = pos.executedQty || pos.qty;
                    buyPrice = pos.buyPrice;
                }
            }

            if (cfg) {
                // 1. Fill BUY form defaults
                document.getElementById('m-total').value = cfg.buyAmountUsdt || 12;
                _calcTarget(price, cfg);
                recalc('BUY');

                // 2. SMART SELL: If we own the coin, fill the SELL form
                if (ownedQty > 0) {
                    const sellQtyInp = document.getElementById('s-qty');
                    const sellPriceInp = document.getElementById('m-target');
                    
                    sellQtyInp.value = ownedQty;
                    
                    // Calculate target price based on buy price and profit config
                    if (cfg.profitAmountUsdt > 0) {
                        const target = parseFloat(buyPrice) + (cfg.profitAmountUsdt / ownedQty);
                        sellPriceInp.value = target.toFixed(8);
                    } else {
                        const pct = cfg.profitPct || 1.5;
                        sellPriceInp.value = (parseFloat(buyPrice) * (1 + pct/100)).toFixed(8);
                    }
                    
                    // Trigger sell total recalculation
                    recalc('SELL');
                    toast(`📌 Position detected: Pre-filled Sell for ${ownedQty} ${symbol.replace('USDT','')}`, 'g');
                }
            }
        } catch (err) {
            console.error('[Orders] Failed to pre-fill from config:', err);
            if (price) _calcTarget(price);
            recalc('BUY');
        }
    }

    /**
     * Update the active symbol labels in the terminal.
     */
    function updateSymbol(sym) {
        selectedSymbol = sym.toUpperCase();
        const labels = document.querySelectorAll('.term-sym-label');
        labels.forEach(l => l.textContent = selectedSymbol);

        // Update units (e.g. Amount in SOL)
        const baseCoin = selectedSymbol.replace('USDT', '').replace('BUSD', '');
        document.getElementById('m-qty-unit').textContent = baseCoin;
        document.getElementById('s-qty-unit').textContent = baseCoin;
    }

    /**
     * Fetch the current market price for the symbol and fill the price field.
     */
    async function useMarketPrice() {
        const symbol = document.getElementById('m-sym').value.trim().toUpperCase();
        if (!symbol) return toast('Enter symbol first', 'y');

        try {
            const res = await fetch(`/api/analyze/${symbol}`);
            const data = await res.json();
            if (data && data.currentPrice) {
                document.getElementById('m-price').value = data.currentPrice;
                _calcTarget(data.currentPrice);
                toast(`Market price: ${data.currentPrice}`, 'g');
            } else {
                toast('Price not available yet', 'r');
            }
        } catch (err) {
            toast('Failed to fetch market price', 'r');
        }
    }

    function _calcTarget(buyPrice, cfg) {
        const targetInput = document.getElementById('m-target');
        const buyPriceNum = parseFloat(buyPrice);
        if (buyPriceNum > 0) {
            if (cfg && cfg.profitAmountUsdt > 0) {
                // Formula: Target = BuyPrice + (ProfitAmount / Quantity)
                // Quantity = Total / BuyPrice
                const total = parseFloat(document.getElementById('m-total').value) || 12;
                const qty = total / buyPriceNum;
                const target = buyPriceNum + (cfg.profitAmountUsdt / qty);
                targetInput.value = target.toFixed(8);
            } else {
                const pct = (cfg && cfg.profitPct > 0) ? cfg.profitPct : 1.5;
                targetInput.value = (buyPriceNum * (1 + pct / 100)).toFixed(8);
            }
        }
    }

    /**
     * Recalculate quantity or total based on inputs.
     * @param {string} side 'BUY' or 'SELL'
     * @param {string} trigger 'total' (default) or 'qty'
     */
    function recalc(side, trigger = 'total') {
        const prefix = (side === 'BUY') ? 'm' : 's';
        
        let price = 0;
        if (currentMode === 'MARKET') {
            price = parseFloat(document.getElementById('m-price').value) || 0;
        } else {
            const priceInp = (side === 'BUY') ? 'm-price' : 'm-target';
            price = parseFloat(document.getElementById(priceInp).value) || 0;
        }
        
        const qtyInp = `${prefix}-qty`;
        const totalInp = `${prefix}-total`;
        const estDiv = `${prefix}-est`;
        const unit = document.getElementById(`${prefix}-qty-unit`).textContent;

        if (trigger === 'total') {
            const totalStr = document.getElementById(totalInp).value;
            const total = parseFloat(totalStr) || 0;
            if (price > 0 && total > 0) {
                const qty = total / price;
                document.getElementById(qtyInp).value = qty.toFixed(6);
                if (document.getElementById(estDiv)) document.getElementById(estDiv).textContent = `≈ ${qty.toFixed(6)} ${unit}`;
            } else if (totalStr === '') {
                // Don't clear qty if user is clearing total, or wait for config
                // document.getElementById(qtyInp).value = '';
            }
        } else {
            const qtyStr = document.getElementById(qtyInp).value;
            const qty = parseFloat(qtyStr) || 0;
            if (price > 0 && qty > 0) {
                const total = qty * price;
                document.getElementById(totalInp).value = total.toFixed(2);
                if (document.getElementById(estDiv)) document.getElementById(estDiv).textContent = `≈ ${qty.toFixed(6)} ${unit}`;
            }
        }
    }

    /**
     * Triggered on every WebSocket update to keep terminal prices fresh
     * if in Market mode or if the user hasn't edited the price yet.
     */
    function recalcLive(coins) {
        if (!selectedSymbol) return;
        const coin = coins.find(c => c.symbol === selectedSymbol);
        if (!coin) return;

        // In Market mode, keep the underlying (hidden) price input synced with the live ticker
        if (currentMode === 'MARKET') {
            document.getElementById('m-price').value = coin.price;
            recalc('BUY');
            recalc('SELL');
        }
    }

    /**
     * Submit the manual BUY form (called by the BUY button in the form).
     */
    async function manualBuy() {
        const symbol = selectedSymbol;
        if (!symbol) return toast('Select a coin first', 'y');

        const price  = currentMode === 'LIMIT' ? parseFloat(document.getElementById('m-price').value) : 0;
        const total  = parseFloat(document.getElementById('m-total').value) || 0;
        const qty    = parseFloat(document.getElementById('m-qty').value);
        const target = parseFloat(document.getElementById('m-target').value) || 0;

        // Safety: Binance min notional is usually $5. We'll enforce $5.01 floor.
        if (total < 5.01) {
            return toast(`❌ Total must be at least $5.01 (Current: $${total.toFixed(2)})`, 'r');
        }

        if (currentMode === 'LIMIT' && !price) return toast('Enter limit buy price', 'r');
        if (!qty || qty <= 0) return toast('Enter quantity/amount', 'r');
        
        toast(`Sending ${currentMode} BUY ${selectedSymbol}...`, 'y');
        await _sendBuy(symbol, price, qty, target);
    }

    /**
     * Submit the manual SELL form (called by the SELL button in the form).
     */
    async function manualSell() {
        const symbol = selectedSymbol;
        if (!symbol) return toast('Select a coin first', 'y');

        const price = currentMode === 'LIMIT' ? parseFloat(document.getElementById('m-target').value) : 0;
        const qty   = parseFloat(document.getElementById('s-qty').value);

        if (currentMode === 'LIMIT' && (!price || price <= 0)) return toast('Enter sell price', 'r');
        if (!qty || qty <= 0) return toast('Enter quantity to sell', 'r');

        const modeStr = currentMode === 'LIMIT' ? 'LIMIT' : 'MARKET';
        toast(`Sending ${modeStr} SELL ${selectedSymbol}...`, 'y');
        await _sendSell(symbol, price, qty);
    }

    /**
     * Set the trading mode (MARKET or LIMIT) and update UI.
     */
    function setMode(mode) {
        currentMode = mode;
        localStorage.setItem('tradeMode', mode);
        
        const isLimit = (mode === 'LIMIT');

        // Update tabs
        const tabs = document.querySelectorAll('.t-tab');
        tabs.forEach(t => {
            const match = t.textContent.toUpperCase() === mode;
            t.classList.toggle('active', match);
        });

        // Toggle price fields in terminal for symmetry
        const pField = document.getElementById('term-row-price');
        const sField = document.getElementById('term-row-sell-price');
        if (pField) pField.style.display = isLimit ? 'flex' : 'none';
        if (sField) sField.style.display = isLimit ? 'flex' : 'none';

        // Disable price input if Market
        const priceInp = document.getElementById('m-price');
        if (priceInp) priceInp.disabled = !isLimit;

        // Toggle table column
        const th = document.getElementById('th-limit-price');
        if (th) th.style.display = isLimit ? '' : 'none';
        
        const tds = document.querySelectorAll('.td-limit-price');
        tds.forEach(td => td.style.display = isLimit ? '' : 'none');

        // Update row buttons
        const buyBtns = document.querySelectorAll('.btn-buy');
        buyBtns.forEach(btn => btn.textContent = isLimit ? 'LIMIT BUY' : 'BUY');

        // If a symbol is already selected, re-fill to ensure config-based defaults (like buy amount) are applied to the new mode
        if (selectedSymbol) {
            const currentPrice = parseFloat(document.getElementById('m-price').value);
            fillManual(selectedSymbol, currentPrice);
        }
    }

    // Initialize UI on load
    setTimeout(() => setMode(currentMode), 500);

    /**
     * Fetch the 2-month low for the symbol and fill the price field.
     */
    async function use2mLow() {
        const symbol = document.getElementById('m-sym').value.trim().toUpperCase();
        if (!symbol) return toast('Enter symbol first', 'y');

        try {
            toast(`Fetching analysis for ${symbol}...`, 'y');
            const res = await fetch(`/api/analyze/${symbol}`);
            const data = await res.json();
            if (data && data.metrics && data.metrics.low2m) {
                document.getElementById('m-price').value = data.metrics.low2m;
                toast(`2m Low found: ${data.metrics.low2m}`, 'g');
            } else {
                toast('Could not find 2m low in analysis', 'r');
            }
        } catch (err) {
            toast('Failed to fetch 2m low', 'r');
        }
    }

    // ── Private ───────────────────────────────────────────────────────────────

    /** POST a BUY order to the server. */
    async function _sendBuy(symbol, price, qty, target) {
        try {
            const res  = await fetch('/api/buy', _post({ symbol, price, qty, target }));
            const data = await res.json();
            if (!data.ok) toast(data.error || 'Buy failed', 'r');
            else {
                const modeStr = price > 0 ? `Limit @ ${price}` : 'Market';
                toast(`✅ ${modeStr} Buy Placed: ${symbol}`, 'g');
            }
        } catch (err) {
            toast('Network error on BUY', 'r');
            console.error('[Orders] BUY error:', err);
        }
    }

    /** POST a SELL order to the server. */
    async function _sendSell(symbol, price, qty) {
        try {
            const res  = await fetch('/api/sell', _post({ symbol, price, qty }));
            const data = await res.json();
            if (!data.ok) toast(data.error || 'Sell failed', 'r');
            else {
                const modeStr = price > 0 ? `Limit @ ${price}` : 'Market';
                toast(`✅ ${modeStr} Sell Placed: ${symbol}`, 'g');
            }
        } catch (err) {
            toast('Network error on SELL', 'r');
            console.error('[Orders] SELL error:', err);
        }
    }

    /** Fill the manual order form fields. */
    function _fillForm(symbol, price) {
        document.getElementById('m-sym').value   = symbol;
        document.getElementById('m-price').value = price || '';
    }

    /** Build a standard fetch POST options object. */
    function _post(body) {
        return {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(body),
        };
    }

    // Return public interface
    return { quickBuy, quickSell, fillManual, manualBuy, manualSell, use2mLow, useMarketPrice, setMode, updateSymbol, recalc, recalcLive, getMode: () => currentMode };
})();
