# AirPay 2 — Callback, IPN & KKChat Forwarding Audit

Date: 2026-10-22 · Baseline commit: `0062baa` plus the working-tree changes described here · Nothing deployed, committed, or run against live AirPay or KKChat.

Companion to `docs/FIRVANRA_SECOND_AIRPAY_IMPLEMENTATION_REPORT.md`, which describes the original AirPay 2 build.

**Evidence labels used throughout:**

| Label | Meaning |
|---|---|
| **[code]** | Read from source in this repository. |
| **[test]** | Asserted by an automated test that passes. |
| **[prod-log]** | Seen in a production log line supplied by the owner. |
| **[provider-doc]** | Confirmed by official AirPay documentation. **Nothing in this document carries this label.** `docs.airpay.co.in/v4` returned 403 during this audit and 403/404 in the previous one. |
| **[UNVERIFIED]** | Assumed, inferred, or claimed elsewhere without evidence available here. |

---

## 1. AirPay 1 reference analysis

AirPay 1 is implemented in `backend/services/airpay.js` and `backend/routes/payment.js`. AirPay 1 was read only and is unchanged.

```text
AirPay 1
  ├─ Payment initiation   POST /api/payment/airpay/initiate      payment.js:81
  │                         buildCheckoutForm()                    airpay.js:121
  ├─ Browser return       POST /api/payment/airpay/callback      payment.js:111
  └─ IPN / webhook        NONE — no route, no handler
        v
  verifyCallback(req.body)  CRC32 ap_SecureHash only               airpay.js:159
        v
  order.status = paid | failed (in-memory Map)                     payment.js:117-126
        v
  302 redirect to FRONTEND_URL/order/:id?status=success|failed
```

| Branch | Source | Request format | Parsing | Verification | Response | Failure handling |
|---|---|---|---|---|---|---|
| Initiate | `payment.js:81`, `airpay.js:121` | JSON `{orderId}` | global `express.json` | — | JSON `{simulated:false, action, method, fields}` | 404 / 409 / 503 (unconfigured outside dev) / 502 |
| Browser return | `payment.js:111` | Assumed form-encoded. Parsed by the global `express.urlencoded` in `server.js`; a JSON body is also parsed by `express.json`. **[code]** | `req.body` | `verifyCallback`: CRC32 over `orderid:apTxnId:amount:txnStatus:message:MID:username`, fails closed on a missing hash **[code][test]** (`payment.airpay.production.test.js`) | **Always a 302 redirect**, whatever the outcome **[code][test]** | Any non-verified or non-paid callback → `order.status = "failed"` and a redirect to `?status=failed` |
| IPN | none | UNKNOWN | — | — | — | — |
| Forwarding | none | — | — | — | — | — |

**AirPay 1 facts relevant to AirPay 2:**

- **No channel identification.** Everything is treated as a browser return. AirPay 1 provides **no** evidence on how to tell an IPN from a browser return, and no evidence on IPN format, headers, acknowledgement or retries.
- **No captured callback fixtures.** Test bodies are synthetic (`payment.airpay.production.test.js:174`). Headers used: `Content-Type: application/x-www-form-urlencoded` only.
- **No Verify API, no amount check, no currency check, no forwarding, no dedup.**

**AirPay 1 weaknesses: documented, not copied, not fixed (out of scope):**

- **W1.** `payment.js:126` sets `order.status = "failed"` for *any* callback whose `orderid` matches an order, including callbacks with a bad hash. That includes orders from other gateways and orders already `paid`. An unauthenticated POST can therefore regress a paid order to `failed`.
- **W2.** The CRC32 hash is the only authority. CRC32 is linear and not a MAC, and no server-side Verify call is made.
- **W3.** No check of amount or currency against the order.
- **W4.** Not suitable as an IPN endpoint. A redirect is not an acknowledgement contract.

## 2. AirPay 2 analysis

Files: `backend/routes/airpay2.js`, `backend/services/airpay2.js`, `backend/services/kkchatForwarder.js`, and the route registration in `backend/server.js:19-20`.

- **Route** **[code][test]**:
  - `POST /callback/cpm/arp_firvanra/collection` handles both the browser return and the IPN.
  - It is registered **before** the global body parsers, with its own `express.raw` (100 kB), so the exact bytes can be relayed.
  - `GET` returns 405.
- **Parsing** (`parseCallbackBody`):
  - JSON if the Content-Type contains `json`, or if there is no Content-Type and the body starts with `{`.
  - Otherwise `URLSearchParams`.
  - An empty, non-object or invalid body returns 400.
- **Integrity** (`services/airpay2.js` `verifyCallback`):
  - Required: `orderid`, `ap_transactionid`, `amount`, `transaction_status`, `ap_SecureHash`.
  - An explicit `merchant_id` must equal `AIRPAY_MID_2`.
  - CRC32 is computed with the MID 2 credentials. UPI adds the VPA variant.
- **Authority** (`verifyTransaction`): merchant-2 OAuth, then a Verify API POST, then a decrypted record. Results are `ok/found/outcome`. It never throws.
- **Identity match** (`verifiedIdentityMismatch`):
  - The verified `orderid`, `ap_transactionid` and amount must equal the callback's.
  - If the record states a `merchant_id`, it must be MID 2.
  - If the record states a currency, it must be 356 and must equal the callback's currency when the callback states one.
- **Local settlement** (`settleLocalOrder`): only for an order this gateway started. The amount is checked against `order.total`, and so is the currency. It never regresses `paid` and never creates orders.
- **Forwarding** (`forwardAirpay2Callback`):
  - Raw bytes and the original Content-Type go to a constant URL.
  - At most 2 attempts with a 4 s timeout, retrying only on 5xx, 429, timeout or network error. `redirect: "manual"`.
  - Dedup on `ap_transactionid:transaction_status`: delivered keys are remembered, and in-flight deliveries are shared. It is per instance.

## 3. Side-by-side comparison

| Component | AirPay 1 | AirPay 2 | Classification / action |
|---|---|---|---|
| Incoming Content-Type | form (global urlencoded); JSON also parsed | JSON or form, raw-parsed | INTENTIONAL DIFFERENCE |
| Browser callback payload | `orderid, ap_transactionid, amount, transaction_status, message, ap_SecureHash` (+ uppercase legacy names) | same names via `extractTxnFields` (+ `merchant_id`, `currency_code`, `customer_vpa`) | ALREADY CORRECT. Same field contract. |
| IPN payload | no IPN | JSON or form | **UNVERIFIED.** The format has not been captured. |
| Request headers | not inspected | `Content-Type`, `Accept`, `Sec-Fetch-Mode` for presentation only | Changed: never affects status (§5) |
| Callback identification | none (all browser) | heuristic, now presentation-only | **CONFIRMED DEFECT, fixed** (§5) |
| Verification API | none | Verify API, server-side, merchant-2 OAuth | ALREADY CORRECT. AirPay 1 weakness W2. |
| Merchant credentials | `AIRPAY_MERCHANT_ID`, `_USERNAME`, `_PASSWORD`, `_SECRET`, `_CLIENT_ID`, `_CLIENT_SECRET` | `AIRPAY_MID_2`, `_USERNAME_2`, `_PASSWORD_2`, `_API_KEY_2`, `_CLIENT_ID_2`, `_CLIENT_SECRET_2` (+ optional `_ENCRYPTION_KEY_2`, `_OAUTH_URL_2`, `_PAY_URL_2`, `_VERIFY_URL_2`) | ALREADY CORRECT. Isolated, with no fallback **[test]**. There is no `AIRPAY_CREDNAME_2`. |
| Currency validation | none | verified record must be 356; local order also checked | ALREADY CORRECT. Preserved. |
| Success response | 302 `?status=success` | browser: 303 to the order page (`status=pending&returnStatus=success`); otherwise JSON 200 | INTENTIONAL DIFFERENCE |
| Failure (payment) response | 302 `?status=failed` | browser: 303 `returnStatus=failure`; otherwise JSON 200 | INTENTIONAL DIFFERENCE. A genuine outcome is acknowledged. |
| Infrastructure failure | n/a (always redirects) | 503 / 502 on **every** channel | **Fixed** (§5) |
| IPN acknowledgement | n/a | 2xx only once processing is complete | ALREADY CORRECT for JSON. Fixed for form bodies. |
| Forwarding payload | none | raw bytes, original Content-Type | ALREADY CORRECT. Unchanged. |
| Retry handling | none | 2 in-request attempts; non-2xx returned so the caller may re-send | ALREADY CORRECT. Whether AirPay re-sends is UNVERIFIED. |
| Duplicate handling | none | per-instance dedup and in-flight coalescing | POTENTIAL RISK. Not global (§12). |
| Logging | `[airpay callback] {orderid, paid, hashOk}` | `[airpay2 callback] summary {…}` + `[airpay2 forward]` | Preserved. `channel` now honest (§9). |

## 4. Confirmed callback-format differences

- AirPay 1 accepts only what the global parsers produce, and the original bytes are lost. AirPay 2 keeps the raw bytes so it can relay them unchanged **[code][test]**.
- AirPay 2 additionally reads `merchant_id`, `currency_code` and `customer_vpa` **[code]**.
- Whether AirPay **sends** JSON or form for the IPN is **[UNVERIFIED]**. The implementation report states "Per AirPay's v4 docs, the IPN is a JSON POST". That citation could not be re-checked, so the code no longer depends on it.

## 5. Callback channel identification

**Questions investigated:**

1. **How does AirPay 1 identify the channel?** It doesn't. There is no reference mechanism to reuse.
2. **What do the tests use?** Synthetic bodies only. No fixture is a real AirPay request.
3. **Do both merchants use the same API version?** Yes. Both use the v4 endpoints with the same crypto **[code]**.
4. **Does AirPay document a distinguishing field or signature?** UNKNOWN. The docs are inaccessible, and no such field appears in either implementation.
5. **Are the channels distinguishable at one URL?** Only partly:
   - A **JSON body cannot be a browser return**, because HTML forms cannot submit `application/json`. That is a structural fact, not a provider claim.
   - A **form body is ambiguous.** `Accept: text/html` and `Sec-Fetch-Mode: navigate` indicate a browser, but any server can send them.
6. **Is identification needed for verification or forwarding?** **No.** The integrity check, Verify API, identity match, settlement and forwarding are identical for every channel **[code]**. The channel was only ever used to choose the response.

**Root cause of the defect (CONFIRMED DEFECT) [code][test]:**

- Before this change, `done()` in `handleAirpay2Callback` ignored `status` whenever the channel was `browser`.
- It sent a 303 when a local order existed, otherwise a 200 page. This happened even when verification was unavailable (503), success was unconfirmed (503) or the KKChat relay had failed (502).
- So any form-encoded IPN carrying browser-like headers received a success-looking acknowledgement for an event that was never delivered. That is a silent delivery failure.
- **Demonstrated:** with the old `done()` restored, 8 of the new tests fail, including every browser-headed header variant.

**Fix:**

- The HTTP status is now a function of the processing outcome only.
- Headers choose the body format (HTML vs JSON) and the log label, nothing else.
- A browser still receives a 303 when the outcome is 2xx.
- On a non-2xx outcome, the browser receives an HTML page **with the real status code** and a `<meta http-equiv="refresh">` plus a link to the same order page it would have been redirected to. Browsers render and follow it regardless of status, so the customer flow is unchanged in effect.

`callbackChannel(headers)` now returns:

- `ipn` — JSON body.
- `browser` — form body with navigation markers.
- `ambiguous` — any other form body. Previously this was mislabelled `ipn`.

**Residual ambiguity:**

- A misread IPN on a **2xx** outcome receives a 303 instead of JSON 200. That event was fully processed and forwarded.
- Whether AirPay treats a 3xx as an acknowledgement is UNKNOWN. If it does not, it re-sends, and the re-send is deduped (same instance) or must be deduped by KKChat.

## 6. Changes implemented

Two files changed. Both already held uncommitted work, which is preserved.

**`backend/routes/airpay2.js`:**

1. `done()`: the HTTP status is honoured for every channel. A 303 is used only for a 2xx outcome with a local order. Non-2xx browser responses get an HTML page with the real status, plus a refresh/link to the order page when a local order exists.
2. `RETURN_PAGE(title, next)`: optional continue URL (HTML-escaped). New helper `escapeHtml`.
3. `callbackChannel()`: an unmarked form body is `ambiguous` (presentation JSON, as before).
4. Comments that claimed "503 asks AirPay to re-send" are now worded as unconfirmed.

**`backend/routes/payment.airpay2.test.js`:**

- 3 tests updated to the new, intended behaviour:
  - Browser verify-unavailable is now 503 with a refresh.
  - Browser relay failure is now 502 with a refresh.
  - The channel unit test and the summary `channel` value now use `ambiguous`.
- 11 new tests (§10).

**Not changed:** AirPay 1, SabPaisa, PayU, `services/*`, the KKChat forwarder, `server.js`, both `vercel.json` files, public URLs, the forwarding payload, and the credential names.

## 7. HTTP response decision table

The status is the same for every channel. Only the body type differs.

| Request type | Verification result | Forwarding result | HTTP status | Body: `browser` / `ipn`,`ambiguous` | Retry expectation | Evidence |
|---|---|---|---|---|---|---|
| any | — (empty, unparseable or non-object body) | not attempted | 400 | HTML error page / JSON `{error}` | none expected | [code][test] |
| any | — (`*_2` config missing) | not attempted | 503 | HTML / JSON | UNKNOWN | [code] |
| any | — (incomplete fields, wrong MID, bad CRC32) | not attempted; no Verify call | 400 | HTML / JSON | none expected | [code][test] |
| any | Verify unavailable, timeout or no record | not attempted | **503** | HTML (+ refresh to the order page if local) / JSON | UNKNOWN: re-send hoped for, not confirmed | [code][test] |
| any | Verified, but orderid / txn / MID / amount / currency mismatch | not attempted | 400 | HTML / JSON | none expected | [code][test] |
| any | Callback claims success, verify says not yet | not attempted | **503** | HTML (+ refresh) / JSON | UNKNOWN | [code][test] |
| any | Callback superseded (stale failure or pending after success) | not attempted | 200 | 303 if local, else page / JSON `forwarded:false` | none (acknowledged on purpose) | [code][test] |
| any | Verified paid / failed / pending | delivered (KKChat 2xx) | 200 | 303 to the order page if local, else page / JSON `forwarded:true` | none | [code][test] |
| any | Verified | duplicate (same instance, already delivered or in flight) | 200 | as above / JSON `duplicate:true` | none | [code][test] |
| any | Verified | failed (5xx/429/timeout/network after 2 attempts, or 4xx after 1) | **502** | HTML (+ refresh) / JSON | UNKNOWN | [code][test] |
| `GET` | — | — | 405 | JSON | — | [code][test] |

A verified `failed` or `pending` payment is a genuine outcome. It is settled per the Verify record, forwarded, and acknowledged with 200. It is never turned into `paid` and never treated as an infrastructure error **[test]**.

## 8. Verification and forwarding behaviour

**Verification [code][test]:**

- Malformed requests are rejected before any network call.
- An incoming callback alone never settles or forwards anything; AirPay's Verify record does.
- **Currency:**
  - The verified record must be 356.
  - The callback's and the record's currencies must agree when both are stated.
  - Local orders are re-checked.
  - This applies to Firvanra and KKChat orders alike.
  - When AirPay's record omits the currency, the check cannot fire. That is accepted: currency is not invented.
- **Amount:**
  - External orders: the verified amount must equal the callback amount. There is no trusted expected amount for them.
  - Local orders: the amount must also equal `order.total`.

**Forwarding [code][test]**, unchanged:

- POST to the constant `https://kkchat.in/callback/cpm/arp_firvanra/collection`.
- The original raw bytes are sent with the original Content-Type, so all fields and `ap_SecureHash` arrive untouched.
- No credentials are added.
- A destination cannot be steered by the query, headers or body.

Status meanings:

- `delivered` means only that KKChat answered 2xx. **Whether KKChat credited the order is not observable from Firvanra.**
- The production log (orderid `66862257128204165`, `ap_transactionid` `2091569063`, outcome `paid`, forwarding `delivered` 200, 1 attempt) shows verification and HTTP delivery for that transaction **[prod-log]**. It does not show crediting.

## 9. Logging

Each callback that reaches verification writes one line: `[airpay2 callback] summary {…}`.

| Field | Values |
|---|---|
| `provider` | `airpay2` |
| `channel` | `ipn` / `browser` / `ambiguous` (§5) |
| `format` | `json` / `form` |
| `orderid` | — |
| `ap_transactionid` | — |
| `verification` | `verified` / `unavailable` / `not_found` / `mismatch_<field>` |
| `outcome` | — |
| `local_order` | `unknown` / `updated` / `unchanged` / `not_airpay2` / `mismatch` |
| `local_status` | optional |
| `local_reason` | optional |
| `forwarding` | `{destination, status: delivered\|duplicate\|failed\|not_forwarded, http_status?, attempts?, error?, reason?}` |

A test asserts that no credential and no `ap_SecureHash` appears in the logs **[test]**. Tokens and privatekeys are never logged **[code]**.

## 10. Tests and results

All runs were local on Node 24. AirPay (axios) and KKChat (fetch) are mocked, and nothing external is contacted.

| Suite | Before this change | After |
|---|---|---|
| Backend `npm test` | 301 pass / 0 fail | **312 pass / 0 fail** |
| `routes/payment.airpay2.test.js` | 53 | **64** |
| Frontend `npm test` | 43 pass / 0 fail | **43 pass / 0 fail** |
| Frontend `npm run build` | success | **success** |
| Lint / static checks | no lint script in either package | `node --check` on `routes/airpay2.js`: OK |

**New tests:**

- **Status vs headers, ×6 header sets.** The sets are `Accept: text/html` only, `Sec-Fetch-Mode: navigate` only, full browser headers, no browser headers, no Content-Type at all, and `text/plain` + `Accept: text/html`.
  - In each case: verify unavailable → 503, relay failure → 502, no `Location` header, then a successful re-send.
  - They are sent with raw `node:http`, because Node's `fetch` forces `sec-fetch-mode: cors` and adds a Content-Type.
  - **4 of these fail on the pre-fix code.**
- **Browser-headed unconfirmed success:** 503 HTML, not forwarded.
- **Browser failure page for an external (KKChat) order:** no redirect to follow.
- **Browser return, verified pending:** 303, forwarded.
- **Verify record from a different merchant:** 400, not forwarded.
- **KKChat timeout through the route:** 502, 2 attempts, local settlement kept.

**Already covered and still green:**

- JSON and form callbacks; success, failure and pending.
- Verify unavailable or logical error; orderid, amount and currency mismatches.
- Invalid hash and wrong MID.
- KKChat 200, 5xx, 4xx and network errors; forwarder timeout.
- Repeated callbacks; browser before IPN and IPN before browser; concurrent callbacks.
- Unknown external order.
- Routing config.
- AirPay 1, SabPaisa, PayU, preflight and health suites.

## 11. Security considerations

- CRC32 is integrity only. Payment authority is the server-side Verify API **[code]**. If the Verify API is not enabled for MID 2, nothing is settled or forwarded and every callback returns 503.
- Headers are untrusted, and now they only change the response body format. They cannot change settlement, forwarding or status **[test]**.
- Credentials are isolated to the `*_2` variables, never logged and never forwarded **[test]**.
- Return-page URLs are HTML-escaped and point only to `FRONTEND_URL/order/<local id>`. Customers are never redirected to KKChat **[code]**.
- AirPay 1 weakness W1 (§1) is a real integrity issue in the **other** integration. It is reported for a separate, authorised change.

## 12. Known serverless limitations

These cannot be fixed without durable storage, which is out of scope:

- **Orders live in an in-memory `Map` per instance.** A `FIR-` order is invisible to callbacks handled on another instance or after a cold start. Such callbacks are still verified and forwarded with `local_order: "unknown"`, and nothing is fabricated.
  - For numeric KKChat order ids (e.g. `66862257128204165`), `unknown` is expected **[prod-log]**.
- **Dedup is per instance.** The same transaction can be forwarded twice, once via the browser return and once via the IPN on different instances, possibly in different body formats.
  - In-memory Maps cannot give global idempotency.
  - **KKChat must deduplicate durably on `ap_transactionid`.**
  - Exactly-once delivery is not achievable in this architecture.
- **No durable retry.** If both relay attempts fail and AirPay does not re-send, the event is lost.
- **Browser returns are never retried by anyone.** The IPN is the only second chance.
- **Function duration.** The worst case is about 28 s: OAuth 10 s + Verify 10 s + 2×4 s relay + backoff. `backend/vercel.json` sets no `maxDuration`, so the project default applies **[UNVERIFIED]** and must be confirmed.

## 13. Unverified AirPay IPN assumptions

| Assumption | Status |
|---|---|
| AirPay sends an IPN at all for MID 2 | UNVERIFIED. Only browser returns are evidenced **[prod-log]**. |
| IPN Content-Type (JSON vs form) | UNVERIFIED. The handler supports both. |
| IPN request headers (`Accept`, `Sec-Fetch-*`) | UNVERIFIED. They no longer affect status. |
| IPN fields equal the browser-return fields, including `ap_SecureHash` | UNVERIFIED |
| What AirPay treats as an acknowledgement (2xx? 3xx? a specific body?) | UNKNOWN |
| Whether, how often, and for how long AirPay re-sends after a non-2xx | UNKNOWN. 502/503 is this app's only signal. |
| Verify API enabled for live MID 2 | UNVERIFIED |

## 14. AirPay merchant configuration requirements

1. **AirPay 2 dashboard:** set the Response URL (success and failure) and the IPN URL to exactly `https://firvanra.online/callback/cpm/arp_firvanra/collection`. No trailing slash: `…/collection/` does not match the rewrite in `frontend/vercel.json`.
2. **Ask AirPay to confirm:**
   - IPN enabled for MID 2.
   - IPN content type and headers.
   - The acknowledgement contract.
   - The retry policy.
   - Verify / Order Confirmation API enabled for the live MID.
3. **Vercel API project:** all six `*_2` variables set in Production, and max function duration ≥ 30 s.
4. **Vercel frontend project:** production deployment at or after `0062baa`, so it includes the callback rewrite.
5. **KKChat:** accepts both form and JSON bodies, verifies `ap_SecureHash` itself, is idempotent on `ap_transactionid`, and returns 2xx only after it has recorded the event.

Routing was reviewed and is unchanged:

- `firvanra.online` proxies the request to `api.firvanra.online` through an external rewrite, which preserves method, headers, body and query. This is why the logs show `Host: api.firvanra.online` **[code][test]**.

## 15. Manual production acceptance checklist

**Verified locally:** §10 only. Nothing here has been run in production.

- [ ] `curl -i https://firvanra.online/callback/cpm/arp_firvanra/collection` returns **405** JSON, not SPA HTML.
- [ ] `curl -i -X POST -H 'Content-Type: application/json' -d '{}' https://firvanra.online/callback/cpm/arp_firvanra/collection` returns **400** JSON.
- [ ] **Browser return.** In an owner-run ₹1 AirPay 2 payment, the customer lands on `/order/<id>` (Firvanra order) or on the neutral page (KKChat order). The `[airpay2 callback] summary` line shows `"channel":"browser"`, `"verification":"verified"`, and `forwarding.status` either `delivered` or `duplicate`.
- [ ] **Real IPN.** Within a few minutes, a second summary line for the same `ap_transactionid` appears. Record its `channel` and `format`; these are the first real evidence of the IPN format.
  - If no second line appears, the IPN is not configured or not reaching the API; escalate to AirPay.
  - If it shows `"channel":"browser"`, AirPay's IPN client sends browser headers. Since this change, that no longer affects the status code; note it.
- [ ] **Forwarding.** At least one line has `forwarding.status: "delivered"` with `http_status` 2xx.
- [ ] **Downstream.** KKChat confirms its order for that transaction is credited. HTTP 200 alone does not count.
- [ ] **Failed / cancelled attempt.** `"outcome":"failed"`; the Firvanra order is never `paid`; KKChat receives the failure.
- [ ] **Retry behaviour (optional, with AirPay's cooperation).** Observe whether AirPay re-sends an IPN after a 503. This is the only way to confirm the re-send assumption.
- [ ] **Regression.** One payment each through AirPay 1, SabPaisa and PayU.
