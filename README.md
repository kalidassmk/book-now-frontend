# BookNow Fast Trade Dashboard

Real-time WebSocket trading dashboard for the BookNow crypto bot.
Scans Redis for fast-moving signals, auto-trades top movers, and shows live P&L.

---

## Quick Start

```bash
# 1. Install dependencies
cd dashboard
npm install

# 2. Copy env file and edit if needed
cp .env.example .env

# 3. Start the dashboard (requires python-engine + Redis running)
npm start

# 4. Open in browser
open http://localhost:3000
```

---

## Architecture

```
dashboard/
│
├── server.js                   ← Express + Socket.io + Redis + python-engine proxy
├── binance-worker.js           ← !miniTicker WS cache + listenKey lifecycle
│
├── public/                     ← Frontend (Vanilla JS, no framework)
│   ├── index.html              ← HTML shell only
│   ├── css/dashboard.css
│   └── js/
│       ├── utils.js            ← Shared: fmt(), fmtTime(), toast()
│       ├── scanner.js          ← Scanner table renderer
│       ├── positions.js        ← Position card renderer
│       ├── tradeLog.js         ← Trade history renderer
│       ├── config.js           ← Config form: applyConfig(), saveConfig()
│       ├── orders.js           ← Order placement
│       └── main.js             ← Bootstrap: socket + event routing
│
├── package.json
└── README.md
```

The dashboard owns its own Express + Socket.io stack and proxies trading
calls to the python-engine on `:8083` via `ENGINE_BASE`. See
`server.js` for the proxy routes.

---

## Data Flow

```
Every 1 second:

  Redis (FAST_MOVE, LT2MIN, ULTRA_FAST_*)
         │
         ▼
  scanner.js::scanFastMovers()
    ├─ Fetches 7 keys in parallel
    ├─ Merges signals by priority
    ├─ Enriches with live price + position
    └─ Applies display limit (Top N)
         │
         ▼
  autoTrader.js::evaluate()       ← if autoConfig.enabled
    ├─ Buy: new fast mover + slot available + has price
    └─ Sell: hit target | hit stop | time limit
         │
         ▼
  broadcaster.js::_tick()
    └─ io.emit('update', { coins, positions, stats })
    └─ io.emit('trade', ...)   ← per new buy/sell event


New client connects:
  broadcaster.js → socket.emit('config', ...)
  broadcaster.js → socket.emit('trades', ...)
```

---

## Redis Keys

| Key | Type | Written by | Description |
|-----|------|-----------|-------------|
| `FAST_MOVE` | Hash | FastMoveFilter.java | Algorithm-flagged fast movers |
| `LT2MIN_0_TO_3` | Hash | ULF0To3.java | Coins rising 0→3% in under 2 min |
| `ULTRA_FAST_0_TO_2` | Hash | ULF0To3.java | Skipped 0-1% band |
| `ULTRA_FAST_2_TO_3` | Hash | ULF0To3.java | Skipped 1-2% band |
| `ULTRA_FAST_0_TO_3` | Hash | ULF0To3.java | Full skip 0→3% |
| `CURRENT_PRICE` | Hash | MessageConsumer.java | Live prices for all coins |
| `BUY` | Hash | RuleOne/RuleTwo/RuleThree | Bot's own open positions |

---

## REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/config` | Get current auto-trade settings |
| `POST` | `/api/config` | Update any/all settings (partial merge) |
| `POST` | `/api/buy` | Manual buy: `{ symbol, price, qty? }` |
| `POST` | `/api/sell` | Manual sell: `{ symbol, price }` |
| `GET` | `/api/trades` | Full trade history + total P&L |

---

## Socket.io Events

### Server → Client

| Event | Payload | When |
|-------|---------|------|
| `update` | `{ coins, activePositions, stats, ts }` | Every 1 second |
| `trade` | Single trade object | Immediately on auto-buy/sell |
| `config` | Full config object | On connect + after POST /api/config |
| `trades` | `{ trades[], totalPnL }` | Once on connect |

### Client → Server

None. The client is read-only via WebSocket. All writes go through REST API.

---

## Auto-Trade Config

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `false` | Master switch |
| `profitPct` | `1.5` | Take-profit threshold (%) |
| `stopLossPct` | `0.8` | Stop-loss threshold (%) |
| `maxPositions` | `5` | Max simultaneous open positions |
| `displayLimit` | `10` | Max coins shown in the scanner table |
| `simulationMode` | `true` | `true` = log only, no real orders |
| `timeLimitMinutes` | `5` | Auto-exit profitable position after N min |

---

## Signal Priority

Signals are sorted highest → lowest priority. Higher priority signals appear first in the scanner.

| Signal | Source Key | Meaning |
|--------|-----------|---------|
| `LT2MIN_0>3` | `LT2MIN_0_TO_3` | 0→3% in under 2 min (strongest) |
| `UF_0>3` | `ULTRA_FAST_0_TO_3` | Ultra-fast full jump |
| `UF_0>2` | `ULTRA_FAST_0_TO_2` | Skipped 0-1% band |
| `UF_2>3` | `ULTRA_FAST_2_TO_3` | Skipped 1-2% band |
| `FAST_MOVE` | `FAST_MOVE` | Algorithm-flagged (baseline) |

---

## Adding a New Signal Type

1. Add the Redis key to `src/config/settings.js` → `REDIS_KEYS`
2. Fetch it in `src/services/scanner.js` → `scanFastMovers()` parallel fetch
3. Call `assign()` in `_mergeSignals()` with your new label
4. Add the CSS class in `public/css/dashboard.css`
5. Map it in `public/js/scanner.js` → `SIGNAL_CLASS`
