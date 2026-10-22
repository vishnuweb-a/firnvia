# AirPay 2 → KKChat: JSON request / response fix

Branch: `fix/airpay2-kkchat-json-forwarding` · Scope: `backend/services/kkchatForwarder.js`, `backend/routes/airpay2.js` (forward call + log line), tests, this document.

> **Status: implemented and tested behind flags, NOT activated.** No KKChat contract exists in this repository or was supplied with the task. Following the task's rule ("do not activate an unverified payload format"), the defaults reproduce the previous production behaviour exactly. Turning the JSON request and acknowledgement checks on needs two pieces of information from KKChat (§3). Setting them is a configuration change. No code change is needed.

## 1. Original problem

Production logged a fully verified AirPay 2 payment as forwarded:

```json
{"provider":"airpay2","channel":"ambiguous","format":"form","orderid":"63862291729495941",
 "ap_transactionid":"2091618255","verification":"verified","outcome":"paid","local_order":"unknown",
 "forwarding":{"destination":"kkchat","status":"delivered","http_status":200,"attempts":1}}
```

KKChat reports that it did not receive or process the callback.

## 2. Root-cause findings (code inspection)

| # | Question | Finding |
|---|---|---|
| 1 | Receipt / parsing | `express.raw` on the exact path, registered before the global parsers. The body is parsed as JSON when Content-Type contains `json`. Otherwise it is parsed as `URLSearchParams`. |
| 2 | Form vs JSON | Both are supported. The production event above was a **form** body with no browser markers (`ambiguous`). |
| 3 | Integrity | `ap_SecureHash` = CRC32 of `orderid:ap_transactionid:amount:transaction_status:message:MID:username[:vpa]`, computed over **field values**, not body bytes. Explicit `merchant_id` must equal MID 2. |
| 4 | Authority | AirPay Verify API, called server-side, plus identity, amount, currency and status cross-checks. Only a status that AirPay's record confirms is forwarded. |
| 5 | Body forwarded unchanged? | **Yes.** The original raw bytes are forwarded. |
| 6 | Content-Type to KKChat | **The original one.** For this event it was `application/x-www-form-urlencoded`. |
| 7 | `Accept: application/json` | **Not sent.** |
| 8 | KKChat response handling | **The body was drained and discarded.** Content-Type was ignored. |
| 9 | HTTP 200 = success? | **Yes.** Any 2xx counted as `delivered`, including an HTML page or an application-level error carried in a 200. |
| 10 | Failures / retries / duplicates | 2 attempts on 5xx/429/timeout/network. 4xx is not retried. A failed relay is not acknowledged to AirPay (502). Dedup uses an in-memory key `ap_transactionid:transaction_status`, held per process. |

**Conclusion.**

- **Confirmed defect in Firvanra:** `"status":"delivered"` meant only that the HTTP status was 2xx. It said nothing about KKChat processing the callback. The log could not distinguish a working handler from a framework fallback page or an application error.
- **Plausible, unconfirmed cause on the KKChat side:** KKChat's handler expects JSON and ignored or failed to parse the form body while still answering 200. There is supporting evidence: the SabPaisa → KKChat relay in this repo (`routes/payment.js` `forwardToKkchat`) already sends `application/json`. That is a precedent for KKChat's JSON receivers, not the contract for this endpoint.
- **Ruled out by the earlier audit, and not modified:** the route on the Firvanra side.

## 3. KKChat API contract

**Not available.** Searched: every repository document (`docs/*`, `CURRENT_PROJECT_AUDIT.md`, `VERCEL_DEPLOYMENT.md`, README), the code and the tests. The earlier audits list KKChat's contract as an open requirement.

Needed from KKChat before enabling:

1. **Request body.** Is the JSON object of AirPay's original field names and values acceptable (see §7)? Or does KKChat need a different schema (renamed fields, an envelope, numeric types)?
2. **Signature check.** Does KKChat recompute `ap_SecureHash`? JSON keeps it computable (§7). Does KKChat verify anything over the *raw* bytes? Nothing in the AirPay protocol requires this.
3. **Success acknowledgement.** The exact JSON field and value(s), for example `{"status":"success"}`.
4. **Error response.** Its shape, and which errors are permanent and which are retryable.
5. **Idempotency.** Is KKChat idempotent on `ap_transactionid` (+ `transaction_status`)?
6. **Authentication.** Does KKChat require a header or shared secret? The relay is currently unauthenticated, as it was before this change.

## 4. Previous request / response format

```http
POST https://kkchat.in/callback/cpm/arp_firvanra/collection
Content-Type: <original, e.g. application/x-www-form-urlencoded>

<original AirPay bytes>
```

Response: any 2xx counted as delivered, and the body was discarded.

## 5. New request / response format

Two non-secret env vars on the API project control the behavior. Both are read on every request.

| Variable | Unset (default) | Set |
|---|---|---|
| `AIRPAY2_KKCHAT_FORMAT` | `raw`: byte-identical to the previous behavior, including headers. | `json`: the request is sent as JSON with JSON headers (shown below). Any other value is treated as `raw`. |
| `AIRPAY2_KKCHAT_ACK` | No contract. A 2xx is still delivered (AirPay is acknowledged as before) but logged `acknowledgement:"unconfirmed"`. | `field=value[\|value…]`, e.g. `status=success`. A 2xx counts as delivered only when the JSON response contains that field with one of those values. |

The request in `json` mode:

```http
POST https://kkchat.in/callback/cpm/arp_firvanra/collection
Content-Type: application/json
Accept: application/json

{"merchant_id":"…","orderid":"…","ap_transactionid":"…","amount":"849.00","transaction_status":"200",
 "transaction_payment_status":"SUCCESS","message":"Success","chmod":"pg","currency_code":"356","ap_SecureHash":"…"}
```

The destination URL, redirect handling (`manual`, so a 3xx is never treated as a delivery) and the 4 s timeout are unchanged.

## 6. Files modified

- `backend/services/kkchatForwarder.js`: adds `forwardFormat`, `ackRule`, `buildKkchatRequest`, a bounded response reader and `inspectResponse`, and extends the result and log fields. The retry loop and dedup logic are unchanged, except that the acknowledgement is remembered alongside each dedup entry.
- `backend/routes/airpay2.js`: passes the parsed, verified fields to the forwarder and adds the new fields to the summary log. Verification, settlement, channel logic and the responses to AirPay and browsers are unchanged.
- `backend/routes/payment.airpay2.test.js`: the stub records `Accept`, `beforeEach` clears both flags, the exact-shape summary assertion is updated, and 15 new tests are added.
- `docs/AIRPAY2_KKCHAT_JSON_REQUEST_RESPONSE_FIX.md`: this report.

Not changed: AirPay 1, SabPaisa, PayU, `services/airpay2.js`, `server.js`, both `vercel.json` files, URLs, credentials, DNS.

## 7. JSON payload mapping and signature compatibility

- **JSON callback:** the original bytes are forwarded. Types, key order and formatting are untouched.
- **Form callback:** forwarded as a JSON object with the same keys in the same order. Values stay **strings, exactly as received**. Nothing is added (no `verified` flag, no normalized names), dropped or renamed. With a repeated form key, the last value wins. The same object is what was verified.
- **Signature compatibility:** `ap_SecureHash` is CRC32 over field values joined with `:`, so the receiver can recompute it from the JSON values. This is tested. If KKChat instead verifies a signature over raw form bytes, `json` mode would break that check, which is why the mode is gated on question 2 in §3.
- **No secrets:** only AirPay's callback fields are sent. Credentials, privatekey and tokens are never added. This is tested.
- **Ordering:** conversion happens only after the integrity check, the Verify API check and the status confirmation.

## 8. Acknowledgement validation logic

Every attempt reads at most **8 KiB** of the response (then cancels the stream) under the same timeout. It records:

- HTTP status
- Content-Type (truncated to 100 chars)
- `response_kind`: `json` / `html` / `text` / `empty`
- `response_json`: `parsed` / `malformed` / `n/a`
- `acknowledgement`

| Response | No `AIRPAY2_KKCHAT_ACK` | With `AIRPAY2_KKCHAT_ACK` |
|---|---|---|
| 2xx JSON, field = accepted value | delivered, **unconfirmed** | delivered, **confirmed** |
| 2xx JSON, field = other value | delivered, unconfirmed | **failed, `rejected`**, not retried |
| 2xx HTML / text / empty / malformed / oversized | delivered, unconfirmed (an HTML body also logs a warning) | **failed, `unconfirmed`**, not retried |
| 4xx | failed, not retried | failed, not retried |
| 5xx / 429 / timeout / network | failed, retried (2 attempts) | failed, retried (2 attempts) |

The response body is never logged. Only `ack_value` (the acknowledgement field's value, at most 40 chars) is kept in the forwarder result.

## 9. Error handling and retry behavior

- A failed delivery returns 502 to AirPay, as before. AirPay's re-send gets a fresh attempt because failures are never added to the dedup memory.
- `rejected` and `unconfirmed` are deterministic, so they are not retried within the request.
- Duplicates (a browser return racing an IPN, or a re-send) produce one KKChat request. The duplicate reports the remembered acknowledgement.
- **Limitation (unchanged):** dedup and retries are in-memory and per process. There is no queue or database, so exactly-once delivery is **not** guaranteed: after a cold start or on another Vercel instance, the same event can be forwarded again. KKChat must be idempotent on `ap_transactionid`.

## 10. Test results

Local run, Node 24, `npm test`:

- **backend: 331 / 331 pass** (316 existing + 15 new)
- **frontend: 43 / 43 pass**
- `vite build` succeeds
- There is no lint or type-check script in either package.

New tests in `backend/routes/payment.airpay2.test.js`, section "KKChat JSON contract":
json mode form→JSON (fields, string types, hash recomputable, no secrets); json mode JSON→original bytes; json mode keeps guards (bad hash, unconfirmed success not forwarded); json mode browser return still 303; unknown format falls back to raw; ack-rule parsing; JSON success ack confirmed (full summary shape); HTML 200 never confirmed (with and without contract); malformed JSON safe; JSON application rejection reported, not retried, body not logged, re-deliverable; 500 retried with contract; json-mode timeout; json-mode duplicates; bounded read of a 1 MB body; `inspectResponse` classification.

## 11. Production validation checklist

1. Merge and deploy **with neither variable set**. Behavior is identical to before, and logs now show `response_kind` and `acknowledgement:"unconfirmed"`.
2. On the next real AirPay 2 payment, read `forwarding.response_kind` / `response_content_type`. `html` would show that KKChat's URL is serving a page, not its handler. Share the summary line (not the body) with KKChat.
3. After KKChat answers §3:
   - Set `AIRPAY2_KKCHAT_FORMAT=json` (if JSON of the original fields is accepted).
   - Set `AIRPAY2_KKCHAT_ACK=<field>=<value>`.
   - Redeploy the API project.
4. Owner-run ₹1 payment. Expect `request_format:"json"`, `response_kind:"json"` and `acknowledgement:"confirmed"`.
5. **KKChat confirms the order is credited on its side.** Only this proves processing.
6. Regression: one payment each through AirPay 1, SabPaisa and PayU.

## 12. Rollback

- **Configuration:** unset `AIRPAY2_KKCHAT_FORMAT` and `AIRPAY2_KKCHAT_ACK`, then redeploy. This restores the previous wire behavior exactly.
- **Code:** revert the branch's commit. There are no data or schema changes to undo.

## Requirements matrix

| Requirement | Result |
|---|---|
| Form and JSON AirPay callbacks accepted and verified | PASS |
| Verification order unchanged (hash → Verify API → status confirm → forward) | PASS |
| Invalid signature / unverified payment not forwarded | PASS |
| JSON request built from verified original fields, signed values preserved | PASS (behind flag) |
| `Content-Type: application/json` / `Accept: application/json` sent | PASS (behind flag) |
| No secrets in payload or logs; response body not logged | PASS |
| Bounded response read; malformed JSON safe; HTML 200 detected | PASS |
| HTTP 200 alone never reported as acknowledged | PASS |
| Application rejection reported, not retried | PASS (needs ack rule) |
| 5xx / timeout retry behavior preserved | PASS |
| Duplicate handling preserved | PASS |
| Browser return UX preserved | PASS |
| AirPay 1 / SabPaisa / PayU unaffected | PASS (existing suites) |
| Domain routing / Vercel / DNS untouched | PASS |
| KKChat request schema confirmed | **UNVERIFIED (blocker)** |
| KKChat acknowledgement schema confirmed | **UNVERIFIED (blocker)** |
| KKChat receives and processes JSON in production | **UNVERIFIED** |
| Exactly-once delivery | **FAIL (architectural, documented in §9)** |
