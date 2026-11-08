/**
 * vapi-price-api — minimal x402 paid API for the Vapi "List your API on vAPI" quest.
 *
 * One paid endpoint:
 *   GET /price?symbol=BTC   -> live crypto price in USD (CoinGecko, free public API)
 *   Price: $0.001 USDC per call, network Base (eip155:8453), exact scheme (EIP-3009).
 *   Payout wallet (payTo) is set via PAY_TO (default: the user's app wallet).
 *
 * x402 v2 flow (official @x402/express middleware):
 *   - No payment  -> HTTP 402 + PAYMENT-REQUIRED header (base64 PaymentRequired JSON)
 *   - With payment -> middleware verifies the PAYMENT-SIGNATURE via the facilitator
 *     (POST /verify), serves the price, then settles (POST /settle). The server
 *     never holds a private key and never touches the buyer's funds.
 *
 * Free routes: GET / (info), GET /health, GET /openapi.json (OpenAPI 3.0 doc).
 *
 * Env vars (see .env.example):
 *   PAY_TO           payout wallet address (default 0xd7d8299ea24a1ff9225ee04587dbc42506a302b6)
 *   FACILITATOR_URL  x402 facilitator (default https://facilitator.payai.network)
 *   FACILITATOR_TIMEOUT_MS  facilitator call timeout in ms (default 15000)
 *   PORT             listen port (default 4021)
 *   COINGECKO_URL    CoinGecko base URL (default https://api.coingecko.com/api/v3)
 *   PRICE_CACHE_TTL_MS  price cache TTL (default 30000)
 */

import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const NETWORK = "eip155:8453"; // Base mainnet (CAIP-2)
const PRICE = "$0.001"; // 1000 base units of USDC (6 decimals)
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const PAY_TO =
  process.env.PAY_TO ?? "0xd7d8299ea24a1ff9225ee04587dbc42506a302b6";
const FACILITATOR_URL =
  process.env.FACILITATOR_URL ?? "https://facilitator.payai.network";
// Fail fast if the facilitator is slow/unreachable (library default is 90s).
const FACILITATOR_TIMEOUT_MS = Number(
  process.env.FACILITATOR_TIMEOUT_MS ?? 15_000,
);
const PORT = Number(process.env.PORT ?? 4021);
const COINGECKO_URL =
  process.env.COINGECKO_URL ?? "https://api.coingecko.com/api/v3";
const CACHE_TTL_MS = Number(process.env.PRICE_CACHE_TTL_MS ?? 30_000);

// CoinGecko id per symbol (free /simple/price endpoint, no API key).
const SYMBOL_TO_ID = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  BNB: "binancecoin",
  USDC: "usd-coin",
  USDT: "tether",
  XRP: "ripple",
  DOGE: "dogecoin",
  ADA: "cardano",
  LINK: "chainlink",
};

if (!/^0x[0-9a-fA-F]{40}$/.test(PAY_TO)) {
  console.error(`PAY_TO is not a valid EVM address: ${PAY_TO}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Price source (CoinGecko, cached so a paid call almost never waits on upstream)
// ---------------------------------------------------------------------------

const cache = new Map(); // id -> { price, at }

async function fetchPriceFromCoinGecko(id) {
  const url = `${COINGECKO_URL}/simple/price?ids=${encodeURIComponent(
    id,
  )}&vs_currencies=usd`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`CoinGecko HTTP ${res.status}`);
  }
  const data = await res.json();
  const price = data?.[id]?.usd;
  if (typeof price !== "number") {
    throw new Error(`CoinGecko: no USD price for ${id}`);
  }
  return price;
}

async function getPrice(id) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { price: hit.price, cached: true, at: new Date(hit.at).toISOString() };
  }
  const price = await fetchPriceFromCoinGecko(id);
  cache.set(id, { price, at: Date.now() });
  return { price, cached: false, at: new Date().toISOString() };
}

// Background refresh so the cache is warm even before the first paid call.
async function warmCache() {
  for (const id of new Set(Object.values(SYMBOL_TO_ID))) {
    try {
      const price = await fetchPriceFromCoinGecko(id);
      cache.set(id, { price, at: Date.now() });
    } catch (err) {
      console.warn(`[cache] warm-up failed for ${id}: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// x402 setup (official v2 middleware)
// ---------------------------------------------------------------------------

const facilitator = new HTTPFacilitatorClient({
  url: FACILITATOR_URL,
  timeoutMs: FACILITATOR_TIMEOUT_MS,
});
const resourceServer = new x402ResourceServer(facilitator).register(
  NETWORK,
  new ExactEvmScheme(),
);

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.disable("x-powered-by");

// Paid route: GET /price — $0.001 USDC on Base, exact scheme.
app.use(
  paymentMiddleware(
    {
      "GET /price": {
        accepts: {
          scheme: "exact",
          price: PRICE,
          network: NETWORK,
          payTo: PAY_TO,
        },
        description:
          "Live crypto price in USD. $0.001 USDC per call, paid on Base via x402.",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

// --- Free routes -----------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let openApiDoc;
try {
  openApiDoc = JSON.parse(
    fs.readFileSync(path.join(__dirname, "openapi.json"), "utf8"),
  );
} catch (err) {
  console.error(`Could not load openapi.json: ${err.message}`);
  process.exit(1);
}

app.get("/", (req, res) => {
  res.json({
    name: "vapi-price-api",
    description:
      "Live crypto prices, $0.001 USDC per call on Base (x402 v2, exact scheme).",
    price: { amount: PRICE, asset: "USDC", assetAddress: USDC_BASE, network: "base", chainId: 8453 },
    payTo: PAY_TO,
    endpoints: {
      price: "GET /price?symbol=BTC  (paid, $0.001 USDC)",
      openapi: "GET /openapi.json  (free)",
      health: "GET /health  (free)",
    },
    symbols: Object.keys(SYMBOL_TO_ID),
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", network: NETWORK, facilitator: FACILITATOR_URL });
});

app.get("/openapi.json", (req, res) => {
  // Serve the doc with the live server URL so vAPI discovery sees the real host.
  const doc = JSON.parse(JSON.stringify(openApiDoc));
  const proto = req.headers["x-forwarded-proto"] ?? req.protocol;
  doc.servers = [{ url: `${proto}://${req.get("host")}` }];
  res.json(doc);
});

// --- Paid handler (runs only after the x402 middleware verified payment) ---

app.get("/price", async (req, res) => {
  const symbol = String(req.query.symbol ?? "BTC").toUpperCase();
  const id = SYMBOL_TO_ID[symbol];
  if (!id) {
    return res.status(400).json({
      error: "unsupported_symbol",
      message: `Unknown symbol ${symbol}. Supported: ${Object.keys(SYMBOL_TO_ID).join(", ")}`,
    });
  }
  try {
    const { price, cached, at } = await getPrice(id);
    res.json({
      symbol,
      coingeckoId: id,
      priceUsd: price,
      currency: "USD",
      source: "coingecko",
      cached,
      asOf: at,
      paid: { amount: PRICE, asset: "USDC", network: "base" },
    });
  } catch (err) {
    // Upstream down: the payment was already verified, so say so plainly.
    // (The background cache refresh makes this rare; see README.)
    console.error(`[price] upstream error for ${id}: ${err.message}`);
    res.status(502).json({
      error: "upstream_unavailable",
      message: "Price source (CoinGecko) is temporarily unavailable. Please retry.",
    });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "not_found", message: `No route ${req.method} ${req.path}` });
});

app.listen(PORT, async () => {
  console.log(`vapi-price-api listening on http://localhost:${PORT}`);
  console.log(`  paid:    GET /price?symbol=BTC  — ${PRICE} USDC on Base (x402 v2 exact)`);
  console.log(`  payTo:   ${PAY_TO}`);
  console.log(`  facilitator: ${FACILITATOR_URL}`);
  console.log(`  openapi: GET /openapi.json`);
  await warmCache();
  console.log(`  price cache warmed (${cache.size} symbols)`);
});
