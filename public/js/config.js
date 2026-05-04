/**
 * public/js/config.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Master Dynamic Trading Configuration Handler.
 * This script syncs the Dashboard UI with the Redis-backed Spring Bot config.
 */

/**
 * Fetch the master config from Redis on load and apply to UI.
 */
async function loadMasterConfig() {
    try {
        const res = await fetch('/api/v1/config');
        const cfg = await res.json();
        
        if (cfg) {
            _el('ck-auto').checked          = cfg.autoBuyEnabled;
            _el('cfg-buy-amount').value     = cfg.buyAmountUsdt || 12;
            _el('cfg-profit').value         = cfg.profitPct || 0;
            _el('cfg-profit-amount').value  = cfg.profitAmountUsdt || 0.20;
            _el('cfg-stop').value           = cfg.tslPct || 2.0;
            
            _updateModeBadge(!cfg.autoBuyEnabled);
            console.log('[Config] Master configuration loaded from Redis');
        }
    } catch (err) {
        console.error('[Config] Failed to load master config:', err);
    }
}

/**
 * Read all form values and POST them to the Redis-backed API.
 * This instantly updates the Java bot's behavior.
 */
async function saveConfig() {
    const body = {
        autoBuyEnabled:    _el('ck-auto').checked,
        buyAmountUsdt:     parseFloat(_el('cfg-buy-amount').value),
        profitPct:         parseFloat(_el('cfg-profit').value),
        profitAmountUsdt:  parseFloat(_el('cfg-profit-amount').value),
        tslPct:            parseFloat(_el('cfg-stop').value),
        limitBuyOffsetPct: 0.3
    };

    try {
        const res = await fetch('/api/v1/config', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(body),
        });
        const data = await res.json();
        
        if (data.success) {
            _updateModeBadge(!body.autoBuyEnabled);
            
            const targetStr = body.profitAmountUsdt > 0 
                ? `$${body.profitAmountUsdt.toFixed(2)}` 
                : `${body.profitPct}%`;
                
            const statusMsg = body.autoBuyEnabled ? '⚡ BOT LIVE' : '⏸ BOT PAUSED';
            const color = body.autoBuyEnabled ? 'g' : 'y';
            
            if (window.toast) {
                toast(`${statusMsg}: Spend $${body.buyAmountUsdt} | Target ${targetStr}`, color);
            }
            console.log('[Config] Master config saved to Redis:', body);
        }
    } catch (err) {
        if (window.toast) toast('Failed to sync with Bot', 'r');
        console.error('[Config] Save error:', err);
    }
}

// ── Private helpers ───────────────────────────────────────────────────────────

/** Shorthand element selector */
function _el(id) { return document.getElementById(id); }

/**
 * Update the SIM/LIVE badge based on Auto status.
 * @param {boolean} isPaused
 */
function _updateModeBadge(isPaused) {
    const badge = _el('mode-badge');
    if (!badge) return;
    badge.textContent = isPaused ? 'PAUSED' : 'AUTO';
    badge.className   = 'mode-badge ' + (isPaused ? 'mode-sim' : 'mode-live');
}

// Load config on startup
window.addEventListener('load', loadMasterConfig);
