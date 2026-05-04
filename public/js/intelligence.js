/**
 * public/js/intelligence.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Renders the Intelligence Radar dashboard.
 * Listens for the 'update' event and populates the grid.
 */

window.intelligence = {
    render(data) {
        const grid = document.getElementById('intelligence-grid');
        if (!grid || !data.behavioralSentiment) return;

        const sentimentData = data.behavioralSentiment;
        const volumeScores = data.volumeScores || {};
        
        // Symbols to highlight (e.g., BTC, ETH, SOL)
        const prioritySymbols = ['BTC', 'ETH', 'SOL'];
        const allSymbols = Object.keys(sentimentData).sort((a, b) => {
            const aIdx = prioritySymbols.indexOf(a);
            const bIdx = prioritySymbols.indexOf(b);
            if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
            if (aIdx !== -1) return -1;
            if (bIdx !== -1) return 1;
            return a.localeCompare(b);
        });

        if (allSymbols.length === 0) return;

        // Clear only if needed (to prevent flickering)
        if (grid.querySelector('.i-glow') && allSymbols.length > 0) {
            grid.innerHTML = '';
        }

        allSymbols.forEach(symbol => {
            const s = sentimentData[symbol];
            const v = volumeScores[symbol] || {};
            
            let card = document.getElementById(`i-card-${symbol}`);
            if (!card) {
                card = document.createElement('div');
                card.id = `i-card-${symbol}`;
                card.className = 'i-card';
                grid.appendChild(card);
            }

            const score = s.score || 0;
            const confidence = s.confidence || 0;
            const regime = s.regime || 'UNKNOWN';
            const sentimentStr = (s.sentiment || 'NEUTRAL').toLowerCase().replace(' ', '-');
            
            const volScore = v.score || 0;
            const volDecision = v.decision || 'AVOID 🔴';

            card.innerHTML = `
                <div class="i-card-title">
                    <span>📡 ENGINE MONITOR</span>
                    <span style="margin-left: auto; font-family: var(--mono); font-size: 10px;">${new Date(s.timestamp).toLocaleTimeString()}</span>
                </div>
                <div class="i-symbol">
                    <span>${symbol}</span>
                    <span class="i-sentiment-badge s-${sentimentStr}">${s.sentiment || 'NEUTRAL'}</span>
                </div>
                <div class="i-quads">
                    <!-- Q1: Behavioral -->
                    <div class="i-quad">
                        <div class="i-quad-label">Behavioral</div>
                        <div class="i-quad-val" style="color: var(--neon-cyan)">${regime}</div>
                        <div class="i-quad-label" style="margin-top:10px">Confidence</div>
                        <div class="i-progress-wrap">
                            <div class="i-progress-fill" style="width: ${confidence}%"></div>
                        </div>
                        <div style="font-size: 10px; margin-top: 4px; text-align: right; color: var(--dim)">${confidence}%</div>
                    </div>
                    
                    <!-- Q2: Scoring -->
                    <div class="i-quad">
                        <div class="i-quad-label">Global Score</div>
                        <div class="i-quad-val" style="font-size: 24px; color: ${score > 70 ? 'var(--neon-green)' : score < 30 ? 'var(--neon-red)' : '#fff'}">
                            ${score.toFixed(1)}
                        </div>
                        <div class="i-quad-label" style="margin-top:5px">0-100 RANGE</div>
                    </div>

                    <!-- Q3: Volume -->
                    <div class="i-quad">
                        <div class="i-quad-label">Volume Analysis</div>
                        <div class="i-quad-val" style="color: ${volDecision.includes('BUY') ? 'var(--neon-green)' : 'var(--dim)'}">
                            ${volDecision}
                        </div>
                        <div style="font-size: 11px; margin-top: 5px; color: var(--dim)">Score: ${volScore}</div>
                    </div>

                    <!-- Q4: Multi-Timeframe -->
                    <div class="i-quad">
                        <div class="i-quad-label">Timeframes (5m/15m/1h)</div>
                        <div style="display: flex; gap: 5px; margin-top: 5px;">
                            <div title="5m" style="flex:1; height: 15px; background: ${this.getScoreColor(s.timeframes?.['5m'])}"></div>
                            <div title="15m" style="flex:1; height: 15px; background: ${this.getScoreColor(s.timeframes?.['15m'])}"></div>
                            <div title="1h" style="flex:1; height: 15px; background: ${this.getScoreColor(s.timeframes?.['1h'])}"></div>
                        </div>
                        <div style="display: flex; justify-content: space-between; font-size: 8px; color: var(--dim); margin-top: 2px;">
                            <span>5m</span><span>1h</span>
                        </div>
                    </div>
                </div>
                <div style="margin-top: 15px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 10px; display: flex; justify-content: space-between; align-items: center;">
                    <button class="btn btn-buy" onclick="orders.fillManual('${symbol}USDT', ${s.currentPrice || 0}); ui.goto('home')" style="font-size: 10px; padding: 2px 8px;">TRADE</button>
                    <span style="font-size: 10px; color: var(--dim);">Master Consensus v4.2</span>
                </div>
            `;
        });
    },

    /**
     * Enhanced Modal Rendering for all 16+ Algorithm Results
     */
    /**
     * Enhanced Modal Rendering for all 16+ Algorithm Results
     */
    async renderModal(symbol) {
        window.modalSymbol = symbol;
        const modal = document.getElementById('analysis-modal');
        const loading = document.getElementById('modal-loading');
        const content = document.getElementById('modal-content');

        if (!modal) return;
        
        // Reset & show
        loading.style.display = 'flex';
        content.style.display = 'none';
        modal.style.display = 'flex';

        // Helper to safely set element properties
        const setIf = (id, prop, val, isClass = false) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (isClass) el.className = val;
            else el[prop] = val;
        };

        try {
            // 1. Fetch deep analysis (Price/Vol/News)
            const r = await fetch(`/api/analyze/${encodeURIComponent(symbol)}`);
            const data = await r.json();
            if (!data.ok) throw new Error(data.error);
            const a = data.analysis;

            // 2. Extract real-time Intelligence data from lastUpdateData
            const coinKey = symbol.replace('USDT', '');
            const intelligenceData = (window.lastData && window.lastData.behavioralSentiment) ? window.lastData.behavioralSentiment[coinKey] || {} : {};
            
            // --- HEADER ---
            setIf('modal-symbol', 'textContent', symbol);
            const score = a.buyScore || 0;
            const scoreEl = document.getElementById('modal-score');
            if (scoreEl) {
                scoreEl.textContent = score;
                scoreEl.style.color = score >= 5 ? 'var(--neon-green)' : score <= 2 ? 'var(--neon-red)' : '#fff';
            }
            
            const srFill = document.getElementById('sr-fill');
            if (srFill) {
                const dash = 201;
                const offset = dash - (dash * (score / 7));
                srFill.style.strokeDashoffset = offset;
                srFill.style.stroke = score >= 5 ? 'var(--green)' : score <= 2 ? 'var(--red)' : 'var(--blue)';
            }

            const rec = a.recommendation || 'NEUTRAL';
            setIf('modal-rec-label', 'textContent', rec.replace('_',' '));
            setIf('modal-rec-badge', 'textContent', rec.replace('_',' '));
            setIf('modal-rec-badge', 'className', `modal-rec-badge rec-${rec.toLowerCase().replace('_','-')}`, true);
            setIf('modal-reason', 'textContent', a.reason || 'No specific signals detected.');

            // --- PRICE HISTORY ---
            setIf('m-high', 'textContent', fmt(a.high2m));
            setIf('m-curr', 'textContent', fmt(a.currentPrice));
            setIf('m-low', 'textContent', fmt(a.low2m));
            setIf('m-avg', 'textContent', fmt(a.avg2m));
            setIf('m-t7', 'textContent', (a.trend7d > 0 ? '+' : '') + a.trend7d + '%');
            setIf('m-t7', 'className', `mpg-val ${a.trend7d >= 0 ? 'green' : 'red'}`, true);
            setIf('m-t30', 'textContent', (a.trend30d > 0 ? '+' : '') + a.trend30d + '%');
            setIf('m-t30', 'className', `mpg-val ${a.trend30d >= 0 ? 'green' : 'red'}`, true);

            // --- GAUGE ---
            const pos = Math.min(100, Math.max(0, a.pricePosition ?? 50));
            setIf('gauge-fill', 'style', `width: ${pos}%`);
            setIf('gauge-needle', 'style', `left: ${pos}%`);
            setIf('gauge-pct', 'textContent', `${pos.toFixed(1)}%`);

            // --- VOLUME ---
            setIf('m-v24', 'textContent', window.utils.fmtVol(a.vol24hUsdt));
            setIf('m-v7', 'textContent', window.utils.fmtVol(a.vol7dAvgUsdt));
            setIf('m-v30', 'textContent', window.utils.fmtVol(a.vol30dAvgUsdt));
            setIf('m-vr', 'textContent', (a.volumeRatio || 1).toFixed(2) + 'x');
            setIf('vol-bar-fill', 'style', `width: ${Math.min(100, (a.volumeRatio || 1) * 33)}%`);
            setIf('vol-bar-label', 'textContent', `${(a.volumeRatio || 1).toFixed(1)}x avg`);

            // --- NEWS ---
            const newsGrid = document.getElementById('m-news-grid');
            const newsTitle = document.getElementById('m-news-title');
            if (a.newsAnalysis) {
                if (newsGrid) newsGrid.style.display = 'grid';
                if (newsTitle) newsTitle.style.display = 'block';
                setIf('m-news-sentiment', 'textContent', a.newsAnalysis.sentiment || 'NEUTRAL');
                setIf('m-news-score', 'textContent', (a.newsAnalysis.score || a.newsAnalysis.final_score || 0).toFixed(2));
                setIf('m-news-articles', 'textContent', a.newsAnalysis.details?.articles?.length || 0);
                setIf('m-news-signal', 'textContent', a.newsAnalysis.decision || 'HOLD');
                setIf('m-news-signal', 'style', `color: ${a.newsAnalysis.decision === 'BUY' ? 'var(--green)' : a.newsAnalysis.decision === 'SELL' ? 'var(--red)' : 'var(--blue)'}`);
            } else {
                if (newsGrid) newsGrid.style.display = 'none';
                if (newsTitle) newsTitle.style.display = 'none';
            }

            // --- QUADRANT DEEP INTEL (FOR PRO VIEW) ---
            setIf('q-regime', 'textContent', intelligenceData.regime || 'UNKNOWN');
            setIf('q-fakeout', 'textContent', intelligenceData.fakeoutRisk || 'LOW');
            setIf('q-fakeout', 'className', `q-val ${intelligenceData.fakeoutRisk?.toLowerCase() || 'low'}`, true);

            loading.style.display = 'none';
            content.style.display = 'block';
        } catch (e) {
            console.error('[Modal] Error:', e);
            toast(`❌ Analysis Error: ${e.message}`, 'r');
            modal.style.display = 'none';
        }
    },

    getScoreColor(score) {
        if (!score) return 'rgba(255,255,255,0.05)';
        if (score > 70) return 'var(--neon-green)';
        if (score > 55) return 'rgba(0, 255, 136, 0.4)';
        if (score < 30) return 'var(--neon-red)';
        if (score < 45) return 'rgba(255, 49, 49, 0.4)';
        return 'rgba(255,255,255,0.2)';
    }
};
