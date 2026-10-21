# Firvanra — Second AirPay Merchant ("AirPay 2") Implementation Report

Date: 2026-10-21 · Branch: `main` (uncommitted working tree; nothing pushed or deployed)

---

## 1. Existing payment architecture (before this change)

| Layer | What exists |
|---|---|
| Deployment | Two Vercel projects. `firvanra` (frontend, Vite SPA) on `https://firvanra.online`; `firvanra-api` (Express) on `https://api.firvanra.online`. The frontend rewrites `/api/*` to the API domain and sends everything else to `index.html`. |
| Orders | `backend/routes/orders.js`: an in-memory `Map` (`orders`). `GET /api/orders/:id` returns the **whole** order object. |
| AirPay (original) | `backend/services/airpay.js`: credentials bound **at import time** from `AIRPAY_*`. OAuth2 → AES-256-CBC `encdata` + SHA-256 `checksum` + `privatekey` → hosted form. Routes in `backend/routes/payment.js`: `POST /api/payment/airpay/initiate`, `POST /api/payment/airpay/callback` (CRC32 `ap_SecureHash`, fails closed), dev-only simulate. No server-side verify, no forwarding. |
| SabPaisa PG 3.0 | Redirect checkout; HMAC webhook; Transaction Enquiry decides `paid`. Verified payloads are relayed to `https://kkchat.in/callback/cpm/sapa/collection`. |
| PayU | Hosted form; reverse-hash browser return; webhook plus Verify Payment API decides `paid`. |
| Body parsing | `server.js`: global `express.json` (captures `req.rawBody`) and `express.urlencoded`. |
| Frontend | `utils/payment.js` (provider catalogue, `submitHostedPaymentForm`, `handleCheckoutResult`), `api.js` (per-provider initiators), `Checkout.jsx`, `OrderStatus.jsx` (polls the order; clears the cart only on `paid`). |

## 2. AirPay 2 architecture

```text
Checkout (provider "airpay_2")
  └─ POST /api/payment/airpay-2/initiate {orderId}
        └─ services/airpay2.js  (merchant-2 config only)
             OAuth2 → encdata/checksum/privatekey → {type:"form", gateway:"airpay_2", action, method, fields}
  └─ existing submitHostedPaymentForm → AirPay hosted checkout

AirPay 2 ── Response URL (browser, form POST) ─┐
        └── IPN URL (server, JSON POST) ───────┤
                                               v
https://firvanra.online/callback/cpm/arp_firvanra/collection
   (frontend Vercel rewrite → https://api.firvanra.online/callback/cpm/arp_firvanra/collection)
                                               v
routes/airpay2.js  handleAirpay2Callback   [own raw-body parser]
   1. parse (JSON or form)          → 400 if malformed
   2. completeness + merchant_id + ap_SecureHash (CRC32)   → 400, not forwarded
   3. Verify API (server-side, merchant-2 creds)          → 503 if unavailable or not found
   4. verified record must match orderid / ap_transactionid / merchant / amount → 400
   5. settle the LOCAL order if one exists and AirPay 2 started it (amount + currency checked)
   6. forward the ORIGINAL raw bytes to KKChat only if the verified status confirms the callback's status
             services/kkchatForwarder.js → https://kkchat.in/callback/cpm/arp_firvanra/collection
```

The original AirPay files are **not modified**. `services/airpay2.js` is a config-parameterized copy of the same crypto primitives. It is a copy because `services/airpay.js` binds merchant-1 credentials at import time, and making that module shareable would have meant changing it.

## 3. Environment variables (names only)

Required. All six must be set, or initiate returns **503**; there is no fallback to `AIRPAY_*`.

| AirPay value | Variable |
|---|---|
| Merchant ID | `AIRPAY_MID_2` |
| Username | `AIRPAY_USERNAME_2` |
| Password | `AIRPAY_PASSWORD_2` |
| Secret (privatekey) | `AIRPAY_API_KEY_2` (see the assumption below) |
| OAuth client ID | `AIRPAY_CLIENT_ID_2` |
| OAuth client secret | `AIRPAY_CLIENT_SECRET_2` |

All six are present in `backend/.env`. A smoke test with the real config reached the order lookup, which means the configuration check passed. **No values were printed, logged or committed.**

Optional. These are new; each defaults to AirPay's documented value and never to a merchant-1 variable:

| Variable | Default |
|---|---|
| `AIRPAY_ENCRYPTION_KEY_2` | `md5(username~:~password)`, same rule as merchant 1 |
| `AIRPAY_OAUTH_URL_2` | `https://kraken.airpay.co.in/airpay/pay/v4/api/oauth2/` |
| `AIRPAY_PAY_URL_2` | `https://payments.airpay.co.in/pay/v4/` |
| `AIRPAY_VERIFY_URL_2` | `https://kraken.airpay.co.in/airpay/pay/v4/api/verify/` |

**Assumption:** merchant 2 has no `AIRPAY_SECRET_2`. The configured `AIRPAY_API_KEY_2` is treated as the AirPay secret used in `privatekey = sha256(secret@username:|:password)`. If the hosted page rejects the `privatekey`, confirm this mapping with AirPay.

**Vercel:** these variables must also exist in the **`firvanra-api`** Vercel project's Production environment. Only the local `.env` was inspected.

## 4. Files created

- `backend/services/airpay2.js`: merchant-2 config, crypto, OAuth, checkout form, callback integrity check, status classification, Verify API client.
- `backend/services/kkchatForwarder.js`: fixed-destination relay with timeout, bounded retry and in-memory dedup.
- `backend/routes/airpay2.js`: `POST /initiate` router plus the callback/IPN handler.
- `backend/routes/payment.airpay2.test.js`: 41 tests.
- `frontend/src/airpay2.payment.test.js`: 5 tests.
- `docs/FIRVANRA_SECOND_AIRPAY_IMPLEMENTATION_REPORT.md`: this report.

## 5. Existing files minimally modified

| File | Change |
|---|---|
| `backend/server.js` | +11 lines: import; register `POST`/`GET` on the callback path **before** the global body parsers; mount `/api/payment/airpay-2`. Nothing existing reordered or removed. |
| `backend/package.json` | Adds the new test file to `npm test`. |
| `frontend/vercel.json` | Adds one rewrite for the exact callback path, placed before the SPA catch-all. The existing rules are unchanged. |
| `frontend/src/utils/payment.js` | Adds `{ id: "airpay_2", name: "AirPay 2" }` to the provider list, after AirPay. |
| `frontend/src/api.js` | Adds the `airpay_2` initiator → `/payment/airpay-2/initiate`. |
| `frontend/package.json` | Adds the new test file to `npm test`. |
| `frontend/src/utils/payment.test.js` | Updates the provider-catalogue assertion from 3 to 4 ids. This is an intended change, not a hidden regression. |

Not modified: `services/airpay.js`, `routes/payment.js`, `services/sabpaisa.js`, `services/payu.js`, `routes/orders.js`, `Checkout.jsx`, `OrderStatus.jsx`, `backend/vercel.json`, and every other existing test.

## 6. Initiation endpoint

`POST /api/payment/airpay-2/initiate`, body `{ "orderId": "FIR-…" }`

| Case | Response |
|---|---|
| `orderId` missing or not a string | 400 |
| Any `*_2` credential missing | 503 `AirPay 2 is unavailable.`; the server log names the missing variables, never values. Never simulated. |
| Unknown order | 404 |
| Order already paid | 409 |
| Order total not a positive number | 400 |
| OAuth or network failure | 502 `Could not reach AirPay 2.` |
| Success | 200 `{type:"form", gateway:"airpay_2", action:"<pay url>?token=…", method:"POST", fields:{privatekey, merchant_id, encdata, checksum}}` |

The amount is always `order.total.toFixed(2)` from the stored order; request-body amounts are ignored. Buyer splitting, `currency_code: "356"` and `iso_currency: "INR"` match the original exactly. The order gets `gateway:"airpay_2"`, `airpay2OrderId`, `airpay2Amount`, `airpay2AttemptedAt`, `paymentAttemptedAt`, `updatedAt` and `status:"pending"`. No secrets are stored, which matters because the order is publicly readable.

`Checkout.jsx` needed no change: the response has `type:"form"`, which `handleCheckoutResult` already routes to `submitHostedPaymentForm`. The cart is still cleared only by `OrderStatus` on an authoritative `paid`.

## 7. Callback / IPN

The route `POST /callback/cpm/arp_firvanra/collection` is public and needs no authentication. `GET` returns 405 and never touches state.

- **Body formats:** reads the raw bytes itself (`express.raw`, 100 kB limit) and parses JSON or `application/x-www-form-urlencoded`. Per AirPay's v4 docs, the IPN is a JSON POST and the browser return is a form POST.
- **Channel:** `Content-Type: application/json` is treated as an IPN and gets JSON plus status codes. Anything else is treated as a browser return: 303 to `/order/:id?status=pending&gateway=airpay_2[&returnStatus=…]` when a local order exists, otherwise a neutral "Payment response received" page. Customers are never redirected to KKChat.

| Situation | IPN response | Browser response | Order | Forwarded |
|---|---|---|---|---|
| Malformed or empty body, required field missing | 400 | 400 page | — | no |
| `merchant_id` present but ≠ `AIRPAY_MID_2` | 400 | 400 page | — | no |
| `ap_SecureHash` mismatch (incl. merchant-1-signed) | 400 | 400 page | — | no |
| `*_2` config missing | 503 | 503 page | — | no |
| Verify API timeout, network or logical error, or no record | 503 | order page (pending) / neutral page | unchanged | no |
| Verify record contradicts callback (orderid, txn, merchant, amount) | 400 | 400 page | unchanged | no |
| Verified success | 200 | 303 `returnStatus=success` | `paid` | yes |
| Verified failure (400/401/405) | 200 | 303 `returnStatus=failure` | `failed` (never over `paid`) | yes |
| Verified pending (211/402/403) | 200 | 303 | `pending` (never over `paid`) | yes |
| Callback says success, verify says not yet | 503 (re-send) | 303 | per verify | no |
| Callback superseded (e.g. late "failed" after verified success) | 200 `forwarded:false` | 303 | unchanged (`paid`) | no |
| Duplicate of an already-forwarded event | 200 `duplicate:true` | 303 | idempotent (`paidAt` unchanged) | no (deduped) |
| KKChat delivery failed | **502** (re-send) | 303 (customer unaffected) | settlement kept | failed |

## 8. KKChat forwarding

`services/kkchatForwarder.js`:

- **Destination** is the constant `https://kkchat.in/callback/cpm/arp_firvanra/collection`. Nothing in the request (query, headers, body fields) can change it; this is tested.
- **Payload:** POSTs the **original raw request bytes** with the **original `Content-Type`**. Transaction ids, merchant id, status, amount and `ap_SecureHash` reach KKChat byte-for-byte; tested with deliberately odd JSON whitespace. No fields are added, so KKChat can re-verify the hash itself.
- **Timeouts and retries:** 4 s timeout per attempt, at most 2 attempts. It retries only on network errors, timeouts, 5xx and 429, with no retry on other 4xx. `redirect: "manual"`, so a redirect does not count as a delivery.
- **Dedup:** keyed on `ap_transactionid:transaction_status`. It remembers only **successful** deliveries (so a failed relay can be retried by AirPay's re-send) and shares one in-flight delivery between a racing browser return and IPN. It holds at most 5000 keys, oldest evicted first.
- **Logs:** AirPay transaction id, HTTP status, error class and attempt count. No buyer data, hashes or credentials.
- **Independence:** local settlement happens before forwarding and is never rolled back because of a forwarding outcome.
- **Eligibility:** only callbacks that pass the hash check **and** whose status AirPay's Verify API confirms are forwarded. Invalid, unverified or superseded events are never forwarded.

## 9. Local and unknown orders

- **Local order started by AirPay 2** (`gateway === "airpay_2"` and `airpay2OrderId` matches): the amount must equal `order.total.toFixed(2)` and `currency_code`, if present, must be `356`. A paid order is re-confirmed only by the transaction that paid it.
- **Local order with the same id but another gateway:** never modified. The authentic event is still forwarded.
- **No local order** (e.g. KKChat's own transactions on this merchant): no order is created and no other order is touched. The callback is validated (hash, then Verify API) and forwarded.
- An authentic payment whose amount differs from the local order total does **not** settle the order, but is still forwarded.

## 10. Security and verification

- `ap_SecureHash` is `crc32(orderid:ap_transactionid:amount:transaction_status:message:MID:USERNAME)`, with `:customer_vpa` appended for UPI, computed with merchant-2's MID and username. **CRC32 is not authentication:** it is linear and forgeable. It is used only as a first filter.
- **Authority** is AirPay's Order Confirmation / Verify API (`docs.airpay.co.in/v4/payments/order-confirmation`). The request is a form POST of `merchant_id`, `encdata{orderid, ap_transactionid}`, `checksum` and `privatekey` to `…/api/verify/?token=<oauth token>`. Both plain-JSON and encrypted `{response}` replies are handled. HTTP 200 with `status_code ≠ 200` is treated as an error.
- Only `transaction_status 200` together with `transaction_payment_status` absent or `SUCCESS` counts as `paid`. Any other 200 combination (e.g. `AUTHORIZE`) is treated as pending.
- Merchant-1 credentials are never read by the new code; tests assert that the OAuth call, privatekey and merchant id are merchant 2's.
- Credentials are never in responses, logs or order objects. Upstream error bodies are not echoed.
- Merchant 1's `AIRPAY_INSECURE_TLS` switch does not apply to AirPay 2: TLS verification is always on.

## 11. Vercel routing

- **Frontend project (`firvanra.online`):** the new rewrite `/callback/cpm/arp_firvanra/collection` → `https://api.firvanra.online/callback/cpm/arp_firvanra/collection` sits **before** `/((?!api/).*)` → `/index.html`. Without it, AirPay's POST would hit the SPA fallback. A Vercel external rewrite proxies the method, headers and body.
- **Backend project:** `backend/vercel.json` already rewrites everything to `server.js`, so no change was needed.
- Settlement does not depend on any HTTP redirect: the IPN plus the Verify API is the server-side path.

## 12. Test results

All tests were run locally on Node v24.18.0.

| Suite | Before | After |
|---|---|---|
| Backend `npm test` (PayU, SabPaisa, original AirPay production gates, preflight e2e, health, **AirPay 2**) | 248 pass / 0 fail | **289 pass / 0 fail** (248 existing + 41 new) |
| Frontend `npm test` (payment utils, api, checkout flow, **AirPay 2**) | 38 pass / 0 fail | **43 pass / 0 fail** (38 existing + 5 new) |
| Frontend `npm run build` | — | success |
| Lint | — | no lint tooling is configured in either package |

The 41 new backend tests cover:

- **Credentials:** merchant-2 credentials are selected and merchant-1 credentials are not; a missing credential gives 503 for each of the six variables.
- **Initiation:** the amount comes from the server, the v4 form fields are correct, invalid and paid orders are rejected, OAuth failure gives 502, and no secrets appear on the public order.
- **Callback outcomes:** the exact route, form and JSON bodies, success, failure, pending, unknown local order, an order from another gateway, invalid or tampered hash, wrong merchant or merchant-1 signature, malformed and incomplete payloads, and UPI VPA hashes.
- **Ordering and duplicates:** duplicate and concurrent callbacks, out-of-order callbacks, and already-paid protection.
- **Verify API:** the request shape, an encrypted response, unavailable, timeout, logical error, not found, and mismatch.
- **KKChat forwarding:** the exact URL, method, raw bytes and content type; 5xx retry and re-send; no retry on 4xx; network errors; timeouts; dedup; and a destination that cannot be steered.
- **Isolation:** the original AirPay and sapa callbacks are unchanged, and global body parsing is intact.

## 13. In-memory Map limits (production)

- Orders exist only in the Vercel function instance that created them. A callback or IPN that runs on another instance, or after a cold start, sees **no local order**. It is then handled as "unknown": validated, verified and forwarded to KKChat, but **the Firvanra order stays `pending`** on the instance that holds it. This is the main functional limit of the no-database constraint.
- KKChat dedup and in-flight coalescing are per instance and lost on restart. Duplicate forwards across instances are possible, so KKChat should be idempotent on `ap_transactionid`.
- There is no durable retry queue. If both delivery attempts fail and AirPay does not re-send the IPN, that relay is lost. AirPay's IPN retry and acknowledgement contract is **not documented**, so 502/503 is the best available "please re-send" signal; this is unconfirmed.
- No durable delivery, crash-proof idempotency or guaranteed retry is claimed.

## 14. Manual merchant-dashboard actions

These have **not** been performed; I have no dashboard access.

1. In the AirPay 2 merchant panel, set **both** the Response (success/failure) URL and the IPN URL to `https://firvanra.online/callback/cpm/arp_firvanra/collection`.
2. Ask AirPay to confirm that the **Verify / Order Confirmation API is enabled** for this MID. The docs say it works only on a **live** MID. Without it, nothing settles and nothing is forwarded.
3. Ask AirPay to confirm the `privatekey` secret is the value stored as `AIRPAY_API_KEY_2`.
4. Ask AirPay to confirm the IPN's acknowledgement and retry behaviour, and whether the IPN content type is JSON.
5. Ask AirPay to whitelist `firvanra.online` for this MID if the hosted page requires a registered domain.
6. In Vercel → `firvanra-api` → Environment Variables (Production), add the six `*_2` variables, then redeploy.
7. Deploy the frontend so the new rewrite takes effect.
8. Confirm with KKChat that it accepts the standard AirPay payload (JSON IPN and form browser return) at its URL, returns 2xx on success, and is idempotent on `ap_transactionid`.

## 15. Live-payment acceptance checklist

- [ ] `curl -i -X GET https://firvanra.online/callback/cpm/arp_firvanra/collection` returns **405** JSON from Express, not the SPA HTML.
- [ ] `curl -i -X POST -H 'Content-Type: application/json' -d '{}' https://firvanra.online/callback/cpm/arp_firvanra/collection` returns **400** JSON.
- [ ] Checkout shows AirPay, AirPay 2, SabPaisa and PayU; the original AirPay still opens merchant 1.
- [ ] AirPay 2 opens AirPay's hosted page showing merchant 2 and the correct amount.
- [ ] A small real ₹1 test (owner-run, with owner approval) is followed by browser-return and IPN log lines `[airpay2 callback] verified` and `[airpay2 forward] delivered`.
- [ ] The order page reaches **paid** (if the same instance handled it), and the cart clears only then.
- [ ] A cancelled or failed attempt gives `failed` or `pending`, never `paid`, and the cart survives.
- [ ] KKChat confirms receipt of both the success and the failure payloads.
- [ ] A KKChat-originated transaction on this MID (no Firvanra order) is forwarded and creates no order.
- [ ] Regression check: one payment each through the original AirPay, SabPaisa and PayU.

## 16. Rollback

- **Fast, partial:** remove `airpay_2` from `PAYMENT_PROVIDERS` in `frontend/src/utils/payment.js` and redeploy the frontend. The checkout option disappears, while callbacks and IPNs for KKChat keep working.
- **Disable initiation:** unset any `*_2` variable in Vercel. Initiate returns 503, and callbacks return 503 and are not forwarded.
- **Full:** revert the changes in §5 and delete the files in §4 (`git checkout -- <files>` / `git revert <commit>`), redeploy both projects, and point the AirPay 2 dashboard URLs elsewhere. Merchant 1, SabPaisa and PayU need no action.

## 17. Unresolved issues and assumptions

1. **Verify API dependence.** Settlement and forwarding are both gated on the Verify API. If it is not enabled for this MID, or the documented path differs (the docs show both `/airpay/pay/v4/api/verify/` and `/pay/v4/api/verify/`), **no** callback is forwarded to KKChat. Override the path with `AIRPAY_VERIFY_URL_2` if AirPay specifies another.
2. **`AIRPAY_API_KEY_2` is assumed to be the privatekey secret** (§3).
3. **Callback format:** if AirPay sends callbacks as an encrypted `response` field (not documented for callbacks), they will be rejected as incomplete (400, logged). The fields `TRANSACTIONID`/`USERNAME` in AirPay's hash formula are assumed to be `orderid` and the merchant username, as in the original integration.
4. **Missing `merchant_id`:** a callback without `merchant_id` is accepted at the integrity step, because the hash binds the MID, and then confirmed by the Verify API.
5. **GET browser returns:** if AirPay ever returns the browser by GET, the customer sees a 405. The docs show POST only.
6. **Unknown IPN acknowledgement contract:** the 502/503 choices are reasoned, not confirmed by AirPay.
7. **Cross-instance order visibility** (§13).
8. Pre-existing and out of scope, left untouched: `backend/.env.example` contains what look like real merchant-1 identifiers (`AIRPAY_MERCHANT_ID`, `AIRPAY_CLIENT_ID`), and `routes/payment.js` still has the "TEMPORARY DIAGNOSTIC" PayU log from commit `f89e198`.
