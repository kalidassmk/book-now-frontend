/*
 * nifty100.js
 * ─────────────────────────────────────────────────────────────────
 * Static NIFTY 100 universe — NSE symbols the scanner watches.
 *
 * Why hardcode and not fetch:
 *   * The constituents change quarterly; refreshing a static list
 *     once a quarter is less code than maintaining an API endpoint.
 *   * The scanner only needs the symbol list; sectors are optional
 *     metadata for nicer grouping.
 *   * 100 symbols × 1 quote/instrument = 100 entries per /quote call,
 *     well under Kite's 500-instrument limit. Fits in one round-trip.
 *
 * If you want a wider universe (NIFTY 500), drop the rest below the
 * existing entries — the scanner's only assumption is the array shape.
 * Sector tag is informational only.
 *
 * Source: NSE NIFTY 100 index constituents (refresh quarterly).
 * Last updated: 2026-06-10.
 */

window.NIFTY100 = [
  // ── Banking & Financial Services ─────────────────────────────────
  { sym: "HDFCBANK",    sector: "Banking" },
  { sym: "ICICIBANK",   sector: "Banking" },
  { sym: "SBIN",        sector: "Banking" },
  { sym: "KOTAKBANK",   sector: "Banking" },
  { sym: "AXISBANK",    sector: "Banking" },
  { sym: "INDUSINDBK",  sector: "Banking" },
  { sym: "BANKBARODA",  sector: "Banking" },
  { sym: "PNB",         sector: "Banking" },
  { sym: "IDFCFIRSTB",  sector: "Banking" },
  { sym: "FEDERALBNK",  sector: "Banking" },
  { sym: "BAJFINANCE",  sector: "NBFC" },
  { sym: "BAJAJFINSV",  sector: "NBFC" },
  { sym: "SBILIFE",     sector: "Insurance" },
  { sym: "HDFCLIFE",    sector: "Insurance" },
  { sym: "ICICIPRULI",  sector: "Insurance" },
  { sym: "ICICIGI",     sector: "Insurance" },
  { sym: "LICI",        sector: "Insurance" },

  // ── IT ───────────────────────────────────────────────────────────
  { sym: "TCS",         sector: "IT" },
  { sym: "INFY",        sector: "IT" },
  { sym: "HCLTECH",     sector: "IT" },
  { sym: "WIPRO",       sector: "IT" },
  { sym: "TECHM",       sector: "IT" },
  { sym: "LTIM",        sector: "IT" },
  { sym: "PERSISTENT",  sector: "IT" },
  { sym: "COFORGE",     sector: "IT" },

  // ── Oil & Gas ────────────────────────────────────────────────────
  { sym: "RELIANCE",    sector: "Oil & Gas" },
  { sym: "ONGC",        sector: "Oil & Gas" },
  { sym: "IOC",         sector: "Oil & Gas" },
  { sym: "BPCL",        sector: "Oil & Gas" },
  { sym: "GAIL",        sector: "Oil & Gas" },

  // ── Auto ─────────────────────────────────────────────────────────
  { sym: "MARUTI",      sector: "Auto" },
  { sym: "M&M",         sector: "Auto" },
  { sym: "TATAMOTORS",  sector: "Auto" },
  { sym: "BAJAJ-AUTO",  sector: "Auto" },
  { sym: "EICHERMOT",   sector: "Auto" },
  { sym: "HEROMOTOCO",  sector: "Auto" },
  { sym: "TVSMOTOR",    sector: "Auto" },
  { sym: "ASHOKLEY",    sector: "Auto" },

  // ── FMCG ─────────────────────────────────────────────────────────
  { sym: "HINDUNILVR",  sector: "FMCG" },
  { sym: "ITC",         sector: "FMCG" },
  { sym: "NESTLEIND",   sector: "FMCG" },
  { sym: "BRITANNIA",   sector: "FMCG" },
  { sym: "DABUR",       sector: "FMCG" },
  { sym: "GODREJCP",    sector: "FMCG" },
  { sym: "VBL",         sector: "FMCG" },
  { sym: "TATACONSUM",  sector: "FMCG" },

  // ── Pharma & Healthcare ──────────────────────────────────────────
  { sym: "SUNPHARMA",   sector: "Pharma" },
  { sym: "DIVISLAB",    sector: "Pharma" },
  { sym: "CIPLA",       sector: "Pharma" },
  { sym: "DRREDDY",     sector: "Pharma" },
  { sym: "APOLLOHOSP",  sector: "Healthcare" },
  { sym: "TORNTPHARM",  sector: "Pharma" },
  { sym: "ZYDUSLIFE",   sector: "Pharma" },

  // ── Metals ───────────────────────────────────────────────────────
  { sym: "TATASTEEL",   sector: "Metals" },
  { sym: "JSWSTEEL",    sector: "Metals" },
  { sym: "HINDALCO",    sector: "Metals" },
  { sym: "VEDL",        sector: "Metals" },
  { sym: "COALINDIA",   sector: "Metals" },
  { sym: "JINDALSTEL",  sector: "Metals" },

  // ── Cement ───────────────────────────────────────────────────────
  { sym: "ULTRACEMCO",  sector: "Cement" },
  { sym: "SHREECEM",    sector: "Cement" },
  { sym: "GRASIM",      sector: "Cement" },
  { sym: "AMBUJACEM",   sector: "Cement" },

  // ── Power & Utilities ────────────────────────────────────────────
  { sym: "NTPC",        sector: "Power" },
  { sym: "POWERGRID",   sector: "Power" },
  { sym: "ADANIPOWER",  sector: "Power" },
  { sym: "TATAPOWER",   sector: "Power" },

  // ── Telecom ──────────────────────────────────────────────────────
  { sym: "BHARTIARTL",  sector: "Telecom" },
  { sym: "INDUSTOWER",  sector: "Telecom" },

  // ── Adani Group ──────────────────────────────────────────────────
  { sym: "ADANIENT",    sector: "Conglomerate" },
  { sym: "ADANIPORTS",  sector: "Infrastructure" },
  { sym: "ADANIGREEN",  sector: "Renewable" },

  // ── Consumer Durables & Retail ──────────────────────────────────
  { sym: "TITAN",       sector: "Consumer" },
  { sym: "DMART",       sector: "Retail" },
  { sym: "TRENT",       sector: "Retail" },
  { sym: "ABFRL",       sector: "Retail" },
  { sym: "BAJAJHLDNG",  sector: "Holding" },
  { sym: "HAVELLS",     sector: "Consumer" },

  // ── Engineering, Defence, Infra ─────────────────────────────────
  { sym: "LT",          sector: "Engineering" },
  { sym: "SIEMENS",     sector: "Engineering" },
  { sym: "ABB",         sector: "Engineering" },
  { sym: "BHEL",        sector: "Engineering" },
  { sym: "HAL",         sector: "Defence" },
  { sym: "BEL",         sector: "Defence" },
  { sym: "POLYCAB",     sector: "Cable" },

  // ── Chemicals & Paint ───────────────────────────────────────────
  { sym: "ASIANPAINT",  sector: "Paint" },
  { sym: "BERGEPAINT",  sector: "Paint" },
  { sym: "PIDILITIND",  sector: "Chemicals" },
  { sym: "SRF",         sector: "Chemicals" },
  { sym: "UPL",         sector: "Agro" },

  // ── Tech / Internet / Consumer Tech ─────────────────────────────
  { sym: "ZOMATO",      sector: "Tech" },
  { sym: "NYKAA",       sector: "Tech" },
  { sym: "PAYTM",       sector: "Tech" },
  { sym: "POLICYBZR",   sector: "Tech" },
  { sym: "NAUKRI",      sector: "Tech" },

  // ── Capital Goods / Misc Large Cap ──────────────────────────────
  { sym: "PFC",         sector: "NBFC" },
  { sym: "RECLTD",      sector: "NBFC" },
  { sym: "CHOLAFIN",    sector: "NBFC" },
  { sym: "MUTHOOTFIN",  sector: "NBFC" },
  { sym: "JIOFIN",      sector: "Financial" },
  { sym: "IRFC",        sector: "Financial" },
  { sym: "MOTHERSON",   sector: "Auto Anc" },
  { sym: "BOSCHLTD",    sector: "Auto Anc" },

  // ── Misc additions (Nifty 100 expansions) ───────────────────────
  { sym: "DLF",         sector: "Real Estate" },
  { sym: "INDIGO",      sector: "Aviation" },
  { sym: "PIIND",       sector: "Chemicals" },
  { sym: "GODREJPROP",  sector: "Real Estate" },
  { sym: "TATACOMM",    sector: "Telecom" },
];

/* Default MCX commodity underlyings the scanner watches. Same set the
 * CommodityService treats as the standard tradable list. */
window.MCX_UNDERLYINGS = [
  "CRUDEOIL", "NATURALGAS", "GOLD", "SILVER",
  "COPPER", "ZINC", "ALUMINIUM", "LEAD",
];
