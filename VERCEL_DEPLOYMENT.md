# Firvanra — Vercel Deployment Guide

Manual deployment instructions for the two Vercel projects built from this one
repository.

**Repository:** `https://github.com/vishnuweb-a/firnvia.git`

| Project        | Root directory | Framework       | Production domain             |
| -------------- | -------------- | --------------- | ----------------------------- |
| `firvanra-api` | `backend`      | Other (Node.js) | `https://api.firvanra.online` |
| `firvanra`     | `frontend`     | Vite            | `https://firvanra.online`     |

Deploy the **backend first** — the frontend rewrite targets the backend domain.

---

## Architecture

```
Browser
   │
   ▼
https://firvanra.online
   │
   ├── /*       → Vite SPA (index.html fallback)
   │
   └── /api/*   → Vercel rewrite → https://api.firvanra.online/api/* → Express
```

`frontend/vercel.json` holds the rewrite. The `/api/:path*` rule is listed
**before** the SPA fallback, and the fallback uses a negative lookahead
(`/((?!api/).*)`) so an API path can never be rewritten to `index.html`. Static
assets under `/assets/*` are served from the filesystem before rewrites apply.

Provider callbacks therefore use clean URLs on the main domain
(`https://firvanra.online/api/payment/...`), which the rewrite forwards to the
backend. This is why `PUBLIC_BASE_URL` is the **frontend** domain, not the API
domain.

---

## Part 1 — Backend project (`firvanra-api`)

### 1. Import the repository

1. Vercel dashboard → **Add New** → **Project**
2. Import `https://github.com/vishnuweb-a/firnvia.git`
3. Project name: `firvanra-api`

### 2. Configure the build

| Setting           | Value             |
| ----------------- | ----------------- |
| Root Directory    | `backend`         |
| Framework Preset  | Other             |
| Build Command     | *(leave empty)*   |
| Install Command   | `npm install`     |
| Output Directory  | *(leave empty)*   |
| Production Branch | `main`            |
| Node.js Version   | `24.x`            |

`backend/vercel.json` declares `server.js` as a single `@vercel/node` function
and routes all paths to it, so the whole Express app — including the
`express.json({ verify })` raw-body capture that SabPaisa webhook HMAC
verification depends on — runs unchanged.

`server.js` skips `app.listen()` when the `VERCEL` environment variable is
present (Vercel sets it automatically) and exports the app instead. Do **not**
set `VERCEL` yourself, and do **not** set `PORT` — Vercel controls the runtime
port.

### 3. Add environment variables

Add every variable from the [checklist below](#backend-environment-variable-checklist)
to the **Production** environment. Copy secret values directly from your local
`backend/.env` — never from this document, and never into a committed file.

### 4. Deploy

Click **Deploy** and wait for the build to finish.

### 5. Attach the custom domain

1. Project → **Settings** → **Domains**
2. Add `api.firvanra.online`
3. Create the DNS record Vercel shows at your DNS provider (a `CNAME` for the
   `api` subdomain pointing at `cname.vercel-dns.com`)
4. Wait for Vercel to report the domain as **Valid Configuration**

Attach the domain through Vercel's normal custom-domain flow. Do **not** set up
a redirect from the custom domain to the generated `*.vercel.app` URL.

### 6. Verify the backend

```bash
curl https://api.firvanra.online/api/health
# → {"ok":true,"service":"firvanra-api"}
```

The generated `*.vercel.app` URL keeps working, but it is deliberately not
referenced anywhere in application source.

---

## Part 2 — Frontend project (`firvanra`)

### 7. Import the same repository

1. Vercel dashboard → **Add New** → **Project**
2. Import the **same** repo: `https://github.com/vishnuweb-a/firnvia.git`
3. Project name: `firvanra`

### 8. Configure the build

| Setting           | Value           |
| ----------------- | --------------- |
| Root Directory    | `frontend`      |
| Framework Preset  | Vite            |
| Build Command     | `npm run build` |
| Output Directory  | `dist`          |
| Install Command   | `npm install`   |
| Production Branch | `main`          |
| Node.js Version   | `24.x`          |

### 9. Environment variables

**None.** See [frontend environment variables](#frontend-environment-variable-checklist).

### 10. Deploy

Click **Deploy**.

### 11. Attach the custom domain

1. Project → **Settings** → **Domains**
2. Add `firvanra.online` (and `www.firvanra.online` if desired)
3. Create the DNS records Vercel shows (an `A` record for the apex domain, or
   follow Vercel's nameserver instructions)
4. Wait for **Valid Configuration**

Again: attach the domain to the project directly — no redirect to
`*.vercel.app`.

### 12. Verify the full path

```bash
# The rewrite reaches Express through the frontend domain:
curl https://firvanra.online/api/health
# → {"ok":true,"service":"firvanra-api"}
```

Then in a browser:

- `https://firvanra.online/` — home page renders, products load
- `https://firvanra.online/checkout` — checkout page, payment selector renders
- `https://firvanra.online/order/test` — **refresh the page directly.** It must
  render the SPA (showing an order-not-found state), not a Vercel 404. This
  confirms the SPA fallback works.
- Confirm CSS and JS load from `/assets/*` with no 404s in the network tab.

---

## Backend environment variable checklist

Set all of these in the **`firvanra-api`** project, Production environment.

**Never paste a secret value into this file, a commit, a README, or a ticket.**
For every row marked `SECRET`, copy the value from your local `backend/.env`.

### General

| Variable          | Type       | Status | Vercel value / action          |
| ----------------- | ---------- | ------ | ------------------------------ |
| `NODE_ENV`        | NON-SECRET | Set    | `production`                   |
| `PUBLIC_BASE_URL` | NON-SECRET | Set    | `https://firvanra.online`      |
| `FRONTEND_URL`    | NON-SECRET | Set    | `https://firvanra.online`      |
| `PORT`            | —          | Omit   | Do not set — Vercel controls the port |

`PUBLIC_BASE_URL` is the **frontend** domain on purpose: provider callbacks are
generated from it, and they should be clean main-domain URLs that the frontend
rewrite forwards to the API.

`NODE_ENV=production` also hard-disables the `/simulate` endpoints. Those
endpoints fail closed — an unset or unrecognized `NODE_ENV` is treated as
production — but set it explicitly.

### AirPay — secrets

| Variable                | Type   | Status | Vercel value / action      |
| ----------------------- | ------ | ------ | -------------------------- |
| `AIRPAY_MERCHANT_ID`    | SECRET | Set    | Copy from `backend/.env`   |
| `AIRPAY_CLIENT_ID`      | SECRET | Set    | Copy from `backend/.env`   |
| `AIRPAY_CLIENT_SECRET`  | SECRET | Set    | Copy from `backend/.env`   |
| `AIRPAY_USERNAME`       | SECRET | Set    | Copy from `backend/.env`   |
| `AIRPAY_PASSWORD`       | SECRET | Set    | Copy from `backend/.env`   |
| `AIRPAY_SECRET`         | SECRET | Set    | Copy from `backend/.env`   |
| `AIRPAY_ENCRYPTION_KEY` | SECRET | Optional | Copy from `backend/.env`. May be left blank — the code derives `md5(username~:~password)`. Set only if AirPay issued a separate key. |

### AirPay — non-secret config

| Variable              | Type       | Status | Vercel value / action                                     |
| --------------------- | ---------- | ------ | --------------------------------------------------------- |
| `AIRPAY_OAUTH_URL`    | NON-SECRET | Set    | `https://kraken.airpay.co.in/airpay/pay/v4/api/oauth2`    |
| `AIRPAY_PAY_URL`      | NON-SECRET | Set    | `https://payments.airpay.co.in/pay/v4/`                   |
| `AIRPAY_INSECURE_TLS` | NON-SECRET | **Set to `false`** | `false`, or omit the variable entirely      |

Both AirPay URLs above are production endpoints (verified against the local
config) — no `sandbox`/`test` host is present.

> ⚠️ **`AIRPAY_INSECURE_TLS`**
> The local `backend/.env` currently has `AIRPAY_INSECURE_TLS=true`, which
> disables TLS certificate verification for AirPay calls. **Do not copy that
> value to Vercel.** Set `false`, or omit it — the code defaults to full
> certificate verification when the value is anything other than the string
> `"true"`.

### SabPaisa — secrets

| Variable                   | Type   | Status | Vercel value / action      |
| -------------------------- | ------ | ------ | -------------------------- |
| `SABPAISA_CLIENT_CODE`     | SECRET | Set    | Copy from `backend/.env`   |
| `SABPAISA_API_KEY`         | SECRET | Set    | Copy from `backend/.env`   |
| `SABPAISA_SECRET_KEY`      | SECRET | Set    | Copy from `backend/.env`   |
| `SABPAISA_WEBHOOK_SECRET`  | SECRET | **OWNER ACTION REQUIRED** | **REQUIRED — VALUE MUST BE OBTAINED/CONFIRMED FROM SABPAISA** |

> ⚠️ **`SABPAISA_WEBHOOK_SECRET` — OWNER ACTION REQUIRED**
>
> This variable is **missing from the local runtime configuration** and its
> value is not known. It has not been invented or guessed.
>
> It must **not** be filled in with `SABPAISA_SECRET_KEY` unless SabPaisa has
> explicitly confirmed that the merchant account uses the same value for both
> the API checksum secret and the webhook signing secret.
>
> Impact until it is supplied: the SabPaisa **browser callback** and
> **Transaction Enquiry** paths work normally, so checkout completes and orders
> settle. Only the server-to-server webhook endpoint
> (`POST /api/payment/sabpaisa/webhook`) cannot verify signatures and will
> reject deliveries.

### SabPaisa — non-secret config

| Variable                 | Type       | Status | Vercel value / action                                          |
| ------------------------ | ---------- | ------ | -------------------------------------------------------------- |
| `SABPAISA_PAY_URL`       | NON-SECRET | Set    | `https://merchant-api.sabpaisa.in/api/v2/payments`             |
| `SABPAISA_ENQUIRY_URL`   | NON-SECRET | Set    | `https://merchant-api.sabpaisa.in/api/v2/payments/enquiry`     |

### PayU — secrets

| Variable             | Type   | Status | Vercel value / action      |
| -------------------- | ------ | ------ | -------------------------- |
| `PAYU_KEY`           | SECRET | Set    | Copy from `backend/.env`   |
| `PAYU_SALT`          | SECRET | Set    | Copy from `backend/.env`   |
| `PAYU_CLIENT_ID`     | SECRET | Set    | Copy from `backend/.env`   |
| `PAYU_CLIENT_SECRET` | SECRET | Set    | Copy from `backend/.env`   |

### PayU — non-secret config

| Variable            | Type       | Status | Vercel value / action                                      |
| ------------------- | ---------- | ------ | ---------------------------------------------------------- |
| `PAYU_ENV`          | NON-SECRET | Set    | `production`                                               |
| `PAYU_PAYMENT_URL`  | NON-SECRET | Set    | `https://secure.payu.in/_payment`                          |
| `PAYU_VERIFY_URL`   | NON-SECRET | Set    | `https://info.payu.in/merchant/postservice.php?form=2`     |

These are the production PayU hosts — no `test.payu.in` reference remains in the
runtime configuration.

---

## Frontend environment variable checklist

**NONE required.**

The frontend calls relative `/api/*` URLs and the Vercel rewrite supplies the
backend origin, so no API base URL needs to be injected at build time. The
source was inspected and contains no `import.meta.env` / `VITE_` reads.

**Never add any of these to the frontend project** — Vite inlines every
`VITE_`-prefixed variable into the public JavaScript bundle, which would publish
the merchant credentials to every visitor:

```
VITE_PAYU_KEY
VITE_PAYU_SALT
VITE_SABPAISA_API_KEY
VITE_SABPAISA_SECRET_KEY
VITE_AIRPAY_SECRET
```

A frontend test (`src/pages/checkout.flow.test.js`) asserts that no such token
appears in the built bundle.

---

## Provider dashboard checklist

Register these URLs in each provider's merchant dashboard. They all use the main
domain, and the frontend rewrite forwards them to the backend.

### PayU

| Purpose     | URL                                                        |
| ----------- | ---------------------------------------------------------- |
| Webhook     | `https://firvanra.online/api/payment/payu/webhook`         |
| Callback    | `https://firvanra.online/api/payment/payu/callback`        |

Register the webhook URL and enable the relevant payment success/failure events.
The return (`surl`/`furl`) URLs are generated by the application from
`PUBLIC_BASE_URL` at request time and are submitted with each transaction — no
dashboard entry is needed for them, but the callback path is listed above for
allowlisting.

### SabPaisa

| Purpose     | URL                                                            |
| ----------- | -------------------------------------------------------------- |
| Webhook     | `https://firvanra.online/api/payment/sabpaisa/webhook`         |
| Callback    | `https://firvanra.online/api/payment/sabpaisa/callback`        |

The webhook signing secret configured at SabPaisa must match
`SABPAISA_WEBHOOK_SECRET` in the backend Vercel project. The callback endpoint
accepts both `GET` and `POST`. The return URL is generated by the application
from `PUBLIC_BASE_URL`.

### AirPay

| Purpose     | URL                                                        |
| ----------- | ---------------------------------------------------------- |
| Callback    | `https://firvanra.online/api/payment/airpay/callback`      |

**Note on how this URL is configured.** Unlike PayU and SabPaisa, the AirPay
integration does **not** transmit a callback/return URL with the transaction.
`buildCheckoutForm()` in `backend/services/airpay.js` submits only
`privatekey`, `merchant_id`, `encdata` and `checksum` — no success or failure URL
field. The application exposes the endpoint at
`POST /api/payment/airpay/callback` (registered in `backend/routes/payment.js`),
and AirPay must be told that URL **out of band, in the AirPay merchant
dashboard**, as the account's configured success/response URL.

Confirm with AirPay which exact field names their callback posts. The verifier
reads both v4 lowercase (`orderid`, `ap_transactionid`, `transaction_status`,
`ap_SecureHash`) and legacy uppercase variants, and **fails closed** if
`ap_SecureHash` is absent.

---

## Known demo limitation

Orders are held in process memory intentionally for this payment-flow demo.
They are not durable across Vercel process replacement/scaling.
No database was requested for this project.

Practically, on Vercel this means an order created by one serverless instance may
not be visible to a later request served by a different instance. For a reliable
single-session demonstration, exercise checkout promptly after creating an order.
This is a known and accepted property of the demo, not a deployment defect.

---

## Remaining production actions

1. Obtain/configure `SABPAISA_WEBHOOK_SECRET` from SabPaisa.
2. Ensure `AIRPAY_INSECURE_TLS=false` (or omitted) in Vercel — do not copy the
   local `true`.
3. Configure all Vercel production environment variables in `firvanra-api`.
4. Attach `api.firvanra.online` to the backend project.
5. Attach `firvanra.online` to the frontend project.
6. Confirm `https://firvanra.online/api/health` reaches the backend.
7. Register the provider webhook/callback URLs in each merchant dashboard.
