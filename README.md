# vapi-price-api

Minimal **x402 paid API** for the Vapi **"List your API on vAPI"** quest (500 pts).

- **Endpoint:** `GET /price?symbol=BTC` — live crypto price in USD (CoinGecko free public API, no key).
- **Price:** **$0.001 USDC per call**, network **Base** (`eip155:8453`, chain 8453), x402 **v2**, scheme **exact** (EIP-3009 `transferWithAuthorization`).
- **Payout wallet (`payTo`):** `0xd7d8299ea24a1ff9225ee04587dbc42506a302b6` (user's app wallet).
- **USDC on Base:** `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals, so $0.001 = **1000** base units).
- **OpenAPI doc:** `GET /openapi.json` (free; vAPI discovery accepts an OpenAPI URL).
- **Stack:** Node.js 20.6+ · Express 4 · official `@x402/express` 2.30.0 / `@x402/evm` / `@x402/core` middleware. No private key anywhere — the server only holds the payout address.

## How it works (x402 v2)

1. Client calls `GET /price?symbol=BTC` with no payment.
2. Server answers **HTTP 402** with a `PAYMENT-REQUIRED` header: base64-encoded
   `PaymentRequired` JSON (`x402Version: 2`, `accepts: [{scheme: "exact",
   network: "eip155:8453", amount: "1000", asset: <Base USDC>, payTo: <wallet>,
   maxTimeoutSeconds: 300}]`).
3. Client signs an EIP-3009 authorization and retries with a `PAYMENT-SIGNATURE` header.
4. The middleware asks the facilitator to **verify** the payment, serves the price,
   then asks the facilitator to **settle** it on-chain. The facilitator pays the gas;
   the buyer only signs. USDC moves straight from buyer to `payTo`.

## Run locally

```bash
npm install
cp .env.example .env   # optional: defaults already point at the right wallet/facilitator
npm start              # or: npm run dev (loads .env)
```

Server listens on `http://localhost:4021` by default.

| Env var | Default | Meaning |
|---|---|---|
| `PAY_TO` | `0xd7d8299ea24a1ff9225ee04587dbc42506a302b6` | Payout wallet (USDC on Base) |
| `FACILITATOR_URL` | `https://facilitator.payai.network` | x402 facilitator (verify + settle) |
| `FACILITATOR_TIMEOUT_MS` | `15000` | Facilitator call timeout (library default is 90000) |
| `PORT` | `4021` | Listen port |
| `COINGECKO_URL` | `https://api.coingecko.com/api/v3` | Price upstream (free, no key) |
| `PRICE_CACHE_TTL_MS` | `30000` | Price cache TTL; cache is also warmed at startup and refreshed in the background |

## Endpoints

| Route | Auth | Description |
|---|---|---|
| `GET /price?symbol=BTC` | **$0.001 USDC** | Live USD price. `symbol` defaults to `BTC`. Supported: BTC, ETH, SOL, BNB, USDC, USDT, XRP, DOGE, ADA, LINK. |
| `GET /openapi.json` | free | OpenAPI 3.0.3 document; `servers` is set to the live host at request time. |
| `GET /health` | free | `{"status":"ok", ...}` |
| `GET /` | free | API info, price, supported symbols. |

Response (paid, 200):

```json
{
  "symbol": "BTC",
  "coingeckoId": "bitcoin",
  "priceUsd": 75903,
  "currency": "USD",
  "source": "coingecko",
  "cached": false,
  "asOf": "2026-11-08T10:48:30.000Z",
  "paid": { "amount": "$0.001", "asset": "USDC", "network": "base" }
}
```

## Facilitator — read this before deploying

The facilitator verifies and settles payments. **Not every facilitator works on Base mainnet:**

| Facilitator | Base mainnet (`eip155:8453`, exact) | Auth | Notes |
|---|---|---|---|
| `https://facilitator.payai.network` (**default**) | ✅ verified live 2026-11-08 via its `/supported` endpoint | none | Recognised production facilitator in the x402 ecosystem docs. |
| `https://facilitator.xpay.sh` | ✅ verified live 2026-11-08 | none | Smaller/ newer operator. |
| `https://facilitator.0xarchive.io` | ✅ verified live 2026-11-08 | none | Smaller/ newer operator. |
| `https://api.cdp.coinbase.com/platform/v2/x402` | ✅ (Coinbase docs) | CDP API keys (Ed25519 JWT) | Official production facilitator; needs a Coinbase Developer Platform account + API keys; 1,000 tx/month free, then $0.001/tx. |
| `https://x402.org/facilitator` | ❌ **testnet only** — its `/supported` list has no `eip155:8453` | none | Do NOT use for mainnet. The @x402 packages ship it as the default; this project overrides it. |

Change it with `FACILITATOR_URL`. If the facilitator is slow/unreachable, a paid
request fails **closed** after `FACILITATOR_TIMEOUT_MS` with
`502 {"error":"Facilitator verify request timed out after 15000ms"}` — no price is served and nothing settles.

## Local test results (2026-11-08, Node v24.22.1)

Server started with defaults; all tests below ran against `http://localhost:4021`.

**Test 1 — no payment → HTTP 402 with correct x402 requirements** ✅

```
$ curl -s -i http://localhost:4021/price?symbol=BTC
HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQYXltZW50IHJlcXVpcmVkIiwicmVzb3VyY2UiOnsidXJsIjoiaHR0cDovL2xvY2FsaG9zdDo0MDIxL3ByaWNlP3N5bWJvbD1CVEMiLCJkZXNjcmlwdGlvbiI6IkxpdmUgY3J5cHRvIHByaWNlIGluIFVTRC4gJDAuMDAxIFVTREMgcGVyIGNhbGwsIHBhaWQgb24gQmFzZSB2aWEgeDQwMi4iLCJtaW1lVHlwZSI6ImFwcGxpY2F0aW9uL2pzb24ifSwiYWNjZXB0cyI6W3sic2NoZW1lIjoiZXhhY3QiLCJuZXR3b3JrIjoiZWlwMTU1Ojg0NTMiLCJhbW91bnQiOiIxMDAwIiwiYXNzZXQiOiIweDgzMzU4OWZDRDZlRGI2RTA4ZjRjN0MzMkQ0ZjcxYjU0YmRBMDI5MTMiLCJwYXlUbyI6IjB4ZDdkODI5OWVhMjRhMWZmOTIyNWVlMDQ1ODdkYmM0MjUwNmEzMDJiNiIsIm1heFRpbWVvdXRTZWNvbmRzIjozMDAsImV4dHJhIjp7Im5hbWUiOiJVU0QgQ29pbiIsInZlcnNpb24iOiIyIn19XX0=
Cache-Control: no-store
```

Decoded `PAYMENT-REQUIRED` header (verified field by field):

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "http://localhost:4021/price?symbol=BTC",
    "description": "Live crypto price in USD. $0.001 USDC per call, paid on Base via x402.",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "amount": "1000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0xd7d8299ea24a1ff9225ee04587dbc42506a302b6",
      "maxTimeoutSeconds": 300,
      "extra": { "name": "USD Coin", "version": "2" }
    }
  ]
}
```

Checks: `scheme` = `exact` ✅ · `network` = `eip155:8453` (Base) ✅ ·
`amount` = `"1000"` = $0.001 USDC (6 decimals) ✅ ·
`asset` = Base USDC `0x8335…2913` ✅ · `payTo` = user's app wallet ✅.

**Test 2 — invalid payment → rejected, no price served** ✅

- Garbage `PAYMENT-SIGNATURE: not-a-valid-payment` → `402 {"error":"Payment required"}`.
- Well-formed but fake x402 v2 payload (bad 65-byte signature, fake EIP-3009
  authorization) → `402 {"error":"No matching payment requirements"}` when the
  payload lacked the required `accepted` field, and after adding a correct
  `accepted` object the middleware proceeded to facilitator verification — see Test 2b.
- v1-style `X-PAYMENT: garbage` header → `402`, ignored (server speaks v2).

**Test 2b — valid-shaped fake payment reaches facilitator verification, then fails closed** ✅ (with a sandbox caveat)

With a correctly-shaped v2 payload (proper `accepted` + EIP-3009 authorization
fields, garbage signature), the middleware called the facilitator's `/verify`.
In this sandbox the call could not complete: **outbound HTTP POST is blocked here**
(proven: `POST https://httpbin.org/post` also hangs, while GETs work fine).
After the configured 15 s timeout the server answered:

```
HTTP/1.1 502 Bad Gateway
{"error":"Facilitator verify request timed out after 15000ms"}
```

No price was served and nothing settled — fail-closed, as designed. On a host with
normal egress the same code path verifies the signature with the facilitator and
returns 402 for a bad signature / 200 + settlement for a good one. A real paid
call has **not** been tested end-to-end (no real money was spent, by design).

**Test 3 — `GET /openapi.json` serves valid OpenAPI** ✅

Valid JSON, `openapi: 3.0.3`, paths `/health`, `/openapi.json`, `/price`;
`/price` documents the `symbol` query param (enum of 10 symbols, default `BTC`)
and responses `200, 400, 402, 502`; the 402 description documents the
`PAYMENT-REQUIRED` header. `servers` is injected from the request host
(`http://localhost:4021` locally; the public HTTPS URL after deploy).

**Test 4 — other routes** ✅

- `GET /price?symbol=ETH` (no payment) → `402`.
- `GET /health` → `200 {"status":"ok","network":"eip155:8453",...}`.
- `GET /` → `200` API info.
- `GET /nope` → `404`.
- CoinGecko direct check: `{"bitcoin":{"usd":75903},"ethereum":{"usd":2236.85}}`
  (upstream live; the server's startup cache warmed 7/10 symbols — see Limitations).

## Deployment options (free public HTTPS host)

The API must be reachable at a public HTTPS URL for vAPI discovery. **Every
option below needs the user's own account to deploy** — there is no account-free
way to run a persistent Node server on public HTTPS. No account has been created
here; deployment is a later step for the user.

Free-tier facts below were checked against provider docs / comparisons dated
Sep–Nov 2026; free tiers change often, so re-confirm before deploying.

| Host | Free tier (2026) | Sleeps? | Card at sign-up? | Pros | Cons |
|---|---|---|---|---|---|
| **Render** (recommended first) | Free web service: 750 instance-hours/mo, 512 MB RAM, 5 GB bandwidth/mo | Yes — spins down after 15 min idle, ~1 min to wake | **No** | No card; Express runs as-is from a GitHub repo; simplest honest start | Sleeps when idle (vAPI's checker may hit a cold start); 5 GB bandwidth cap |
| **Railway** | $5 trial credit (30 days), then $1/mo credit, no rollover | No sleep by default — the credit runs out instead | No (trial/free) | Smoothest deploy flow; stays awake while credit lasts | Not free-forever; $1/mo credit is tiny — a busy month can exhaust it; 1 project / 3 services on free |
| **Koyeb** | 1 free web service, 512 MB / 0.1 vCPU | Yes — scales to zero after 1 h idle, wakes in seconds | **Yes** ($29 pre-auth hold) | Wakes fast; clean container deploys | Card required just to sign up; only Frankfurt/Washington regions on free |
| Vercel Hobby | Serverless functions (not a long-running server) | n/a (per-request) | No | Free, no sleep | Express app needs rework into serverless functions; cold starts; not a natural fit for this server |
| Fly.io | — | — | — | — | **Free allowances ended Oct 2024 — not free anymore. Skip.** |

**Recommendation:** deploy on **Render** (no card, Express as-is, `npm start`).
Caveat: the 15-minute sleep means the first request after idle takes ~1 minute.
If vAPI's "Check endpoint" hits a sleeping instance it may time out — wake the
service once (open the public URL in a browser) right before listing, or use
Railway's $5 trial credit while it lasts. Either way, set the env vars
(`PAY_TO` is already the default; `FACILITATOR_URL` is already the default) and
confirm the public URL serves the 402 + `/openapi.json` before pasting it into vAPI.

## Limitations / honest notes

- **No end-to-end paid call has been run.** A real USDC payment was never made
  (hard limit for this build). The 402, the invalid-payment rejections and the
  facilitator-timeout fail-closed path are all verified locally; the
  verify → serve → settle happy path on mainnet is the standard @x402 v2 flow
  and will be proven by the first real $0.001 call after deploy (or by a
  Base Sepolia test run with test USDC from the Circle faucet).
- **Sandbox POST egress is blocked**, so facilitator `/verify` could not be
  exercised from this machine at all (even `POST https://httpbin.org/post`
  hangs; GETs work). This is an environment limit, not a code problem.
- **CoinGecko free tier rate-limits** (HTTP 429) — this VM's shared IP hit it
  during cache warm-up (3/10 symbols failed on one run, then succeeded later).
  The 30 s cache + background refresh keeps paid calls fast, but if CoinGecko
  429s at request time and the cache is empty, the endpoint returns 502
  (after payment was verified — the payment would still settle). For a
  $0.001 endpoint this is acceptable; a paid CoinGecko plan or a second
  price source would remove it.
- **Facilitator trust:** a third-party facilitator verifies/settles and pays
  the gas. It never holds funds, but if it is down, paid calls fail (502).
  The CDP facilitator (Coinbase, needs API keys) is the production-grade
  alternative.
- **Sleeping free hosts:** see the Render note above — wake the service before
  running vAPI's "Check endpoint".
- **Nothing is listed on vAPI yet.** Listing (wizard: Discover → Describe →
  Payout → Saved at `https://api.vapinetwork.ai/call/my-apis/new`) and the
  payout-wallet confirmation are manual steps for the user after deploy.

## Files

```
~/workspace/vapi-api/
  server.mjs        Express + @x402 v2 server (paid /price, free /, /health, /openapi.json)
  openapi.json      OpenAPI 3.0.3 document for /price (servers URL injected at runtime)
  package.json      deps pinned: @x402/{express,evm,core} 2.30.0, express 4.22.3
  .env.example      all env vars (no secrets needed)
  .gitignore        node_modules/, .env
  README.md         this file
```
