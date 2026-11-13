# Firvanra

Hosted payment-flow application demonstrating end-to-end checkout against three
Indian payment gateways: **AirPay**, **SabPaisa PG 3.0**, and **PayU Hosted
Checkout**.

The browser never sees a merchant key, salt or secret. Every payment field is
signed server-side, and every provider callback is verified server-side before
an order's status changes.

## Architecture

```
Browser
   │
   ▼
https://firvanra.online                 ← frontend Vercel project (Vite SPA)
   │
   ├── /*            → React SPA (index.html fallback)
   │
   └── /api/*        → Vercel rewrite
                         │
                         ▼
              https://api.firvanra.online/api/*   ← backend Vercel project
                         │
                         ▼
                      Express
```

Two Vercel projects are deployed from this one repository:

| Project         | Root directory | Public domain              |
| --------------- | -------------- | -------------------------- |
| `firvanra`      | `frontend`     | `https://firvanra.online`      |
| `firvanra-api`  | `backend`      | `https://api.firvanra.online`  |

The frontend calls **relative** `/api/...` URLs only. A Vercel rewrite in
[frontend/vercel.json](frontend/vercel.json) proxies `/api/*` to the backend
domain, so the browser treats the API as same-origin. No CORS preflight enters
the payment flow, and provider callbacks get clean URLs on the main domain.

## Frontend stack

- React 18
- Vite 5
- React Router 6 (`/`, `/checkout`, `/order/:id`)

## Backend stack

- Node.js 24.x
- Express 4
- ES Modules
- axios, crc-32, nanoid, dotenv

## Payment providers

| Provider  | Integration                           | Browser callback                        | S2S webhook                            |
| --------- | ------------------------------------- | --------------------------------------- | -------------------------------------- |
| AirPay    | v4 Simple Transaction (OAuth2 + AES)  | `POST /api/payment/airpay/callback`     | — (callback only)                      |
| SabPaisa  | PG 3.0 REST + Transaction Enquiry     | `GET`/`POST /api/payment/sabpaisa/callback` | `POST /api/payment/sabpaisa/webhook` |
| PayU      | Hosted Checkout (SHA-512 hash)        | `POST /api/payment/payu/callback`       | `POST /api/payment/payu/webhook`       |
| HDFC SmartGateway (UPI only) | Payment Page, Basic Auth + Order Status API | `GET`/`POST /payments/hdfc/return` | `POST /api/webhooks/hdfc` (Basic auth) |
| ISGPay (UAT only) | NG Redirection v1.6: AES-256-ECB EncData + SHA-256 SecureHash, Sale Status API | `POST /api/payments/isgpay/return` | `POST /api/payments/isgpay/callback` |

ISGPay is a **UAT demo, not production-ready**. It is off unless `ISGPAY_ENABLED=true`
(exact string). Only a hash-verified Sale Status response (`ResponseCode=00`, matching
amount/ids) marks an order paid. Attempts live in process memory, so a restart, redeploy or
another Vercel instance loses them, and the customer sees "Payment session unavailable".
The callback URL must be registered with ISGPay separately; setting the env var does not register it.
`ISGPAY_VERSION` is optional and explicit: unset sends no `Version` (v1.6 tables list none); set
(the legacy kit uses `1`) adds it to the sale and status requests. It is never retried automatically.
Two explicit UAT diagnostics are documented in `backend/.env.example`: `ISGPAY_SALE_PAYLOAD=kit_minimal`
(required sale fields only) and `ISGPAY_STATUS_TRANSPORT=kit_query` (the kit's status request placement).
Sanitized `[isgpay sale_submit|return_received|callback_received|status_request|status_response]`
log lines carry field names, lengths and check results only, never secrets or customer data.

**ISGPay UAT test procedure (one manual sandbox payment)**

- Return and callback URLs go through the frontend domain, which rewrites `/api/*` to the backend:
  `https://firvanra.online/api/payments/isgpay/return` and `.../callback`.
- Coming back from the hosted page is **not** success. A test passes only when the backend logs a
  `status_response` with `signature: "raw"` or `"url_decoded"` and `ResponseCode` `00`, the order
  moves to `paid` via `GET /api/orders/:id`, and the payment appears in the ISGPay UAT merchant
  panel with the same TxnRefNo and amount.
- An empty Status response (HTTP 200, no body) is inconclusive: the order **stays pending**. Never
  mark it paid or failed by hand.
- Return and callback have no guaranteed arrival order, and either may be missing or duplicated.
  Each one only triggers a Status query, so judge the result from the Status API, not from which
  event arrived first.
- If the order page shows "Payment session unavailable" (the in-memory attempt is gone), **do not
  start another payment**. First look up the original TxnRefNo (from the `sale_submit` log) in the
  ISGPay UAT panel and settle what happened to it; a second attempt risks a double charge.

Signature verification **fails closed** throughout: a callback that arrives
without a verifiable hash is rejected, never treated as successful.

## Local development

```bash
# Backend
cd backend
npm install
cp .env.example .env     # then fill in your own credentials
npm run dev              # http://localhost:4000

# Frontend (separate terminal)
cd frontend
npm install
npm run dev              # http://localhost:5173
```

In development, Vite proxies `/api` to `http://localhost:4000` (see
[frontend/vite.config.js](frontend/vite.config.js)), so the same relative `/api`
contract works locally and in production.

## Environment setup

All configuration lives in `backend/.env`. Start from
[backend/.env.example](backend/.env.example), which lists every variable with
inline notes and **no real values**.

`backend/.env` is gitignored and must never be committed. The frontend requires
**no** environment variables — payment credentials are server-side only, and
there must never be a `VITE_`-prefixed copy of any key, salt or secret (anything
`VITE_`-prefixed is inlined into the public JS bundle).

Two variables deserve attention:

- `AIRPAY_INSECURE_TLS` — must be `false` or omitted. Setting it to `true`
  disables TLS certificate verification and is a local demo escape hatch only.
- `SABPAISA_WEBHOOK_SECRET` — required for S2S webhook HMAC verification. It
  must be obtained from SabPaisa; it is **not** the same value as
  `SABPAISA_SECRET_KEY`. Browser callbacks and Transaction Enquiry work without
  it; the webhook endpoint does not.

## Testing

```bash
cd backend  && npm test     # 248 tests
cd frontend && npm test     #  38 tests
cd frontend && npm run build
```

Tests use fake credentials against throwaway localhost servers. **No test
contacts a live payment gateway and no test performs a real payment.**

## Vercel deployment

See [VERCEL_DEPLOYMENT.md](VERCEL_DEPLOYMENT.md) for exact step-by-step
instructions, the full environment-variable checklist, and the provider
dashboard URLs to register.

## Demo-state limitation

Orders are stored in process memory (`orders = new Map()` in
[backend/routes/orders.js](backend/routes/orders.js)).

**This is intentional for this payment-flow demonstration, not an oversight.**
Orders are not durable across Vercel process replacement or scaling: one
serverless instance does not see orders created by another, and any instance may
be recycled at any time. The implementation exists to demonstrate the gateway
integrations end to end — it is not durable commerce storage. No database is
part of this project's scope.
