/**
 * public/js/utils.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared utility functions used across all front-end modules.
 *
 * Nothing in here has side effects. Pure functions only.
 */

/**
 * Format a crypto price for display.
 * Adapts decimal places based on price magnitude.
 *
 * @param {number|string} v
 * @returns {string}
 */
function fmt(v) {
    if (!v || isNaN(v)) return '—';
    const n = parseFloat(v);
    if (n === 0)         return '0';
    if (n < 0.00001)     return n.toExponential(4);
    if (n < 0.001)       return n.toFixed(8);
    if (n < 1)           return n.toFixed(6);
    if (n < 100)         return n.toFixed(4);
    return n.toFixed(2);
}

/**
 * Format a volume number (e.g. 1,200,000 -> 1.2M)
 */
function fmtVol(v) {
    if (!v || isNaN(v)) return '—';
    const n = parseFloat(v);
    if (n >= 1000000000) return (n / 1000000000).toFixed(2) + 'B';
    if (n >= 1000000)    return (n / 1000000).toFixed(2) + 'M';
    if (n >= 1000)       return (n / 1000).toFixed(1) + 'K';
    return n.toFixed(0);
}

/**
 * Format milliseconds as a human-readable duration.
 * e.g. 3661000 → "1h1m1s"
 *
 * @param {number} ms
 * @returns {string}
 */
function fmtTime(ms) {
    if (!ms || ms < 0) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60)    return `${s}s`;
    if (s < 3600)  return `${Math.floor(s / 60)}m${s % 60}s`;
    return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

/**
 * Show a dismissable toast notification in the bottom-right corner.
 *
 * @param {string} message
 * @param {'g'|'r'|'y'} type  g=green, r=red, y=yellow
 */
function toast(message, type = 'g') {
    const el = document.createElement('div');
    el.className = `toast-item ${type}`;
    el.textContent = message;
    document.getElementById('toast').prepend(el);
    setTimeout(() => el.remove(), 4500);
}

/**
 * Symbol-based debugging logger.
 * Categorizes logs by ticker so you can filter in DevTools.
 *
 * @param {string} symbol e.g. "SOLUSDT"
 * @param {string} message
 * @param {any} data
 */
function debugLog(symbol, message, data = null) {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = `[${timestamp}] [${symbol}]`;
    if (data) {
        console.log(`%c${prefix} %c${message}`, "color: #3b82f6; font-weight: bold", "color: inherit", data);
    } else {
        console.log(`%c${prefix} %c${message}`, "color: #3b82f6; font-weight: bold", "color: inherit");
    }
}

// Global exposure
window.utils = { 
    fmt, 
    fmtVol,
    fmtTime, 
    toast, 
    debugLog,
    setLiveStatus: (isConnected) => {
        const dot = document.getElementById('live-dot');
        const label = document.getElementById('live-label');
        if (!dot || !label) return;

        if (isConnected) {
            dot.classList.add('live');
            label.textContent = 'Live';
            label.style.color = 'var(--green)';
        } else {
            dot.classList.remove('live');
            label.textContent = 'Connecting';
            label.style.color = 'var(--muted)';
        }
    }
};
