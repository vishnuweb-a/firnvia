# AirPay 2 → KKChat: JSON request / response

Branch: `fix/airpay2-kkchat-json-forwarding` · Scope: `backend/services/kkchatForwarder.js`, `backend/routes/airpay2.js` (forward call and log line), one field alias in `backend/services/airpay2.js`, tests, this document.

> **Status: JSON forwarding is the default.** KKChat has confirmed that the callback request is JSON, that the request uses AirPay's own JSON structure (including the uppercase field names), and that the response is `application/json`. KKChat has **not** supplied its success-response body. For that reason a valid JSON response is recorded as *received*, and business processing is reported as `unconfirmed` (§6). Form forwarding is still available as an explicit rollback (§8).

## 1. Original problem

Production logged a fully verified AirPay 2 payment as forwarded:

```json
{"provider":"airpay2","channel":"ambiguous","format":"form","orderid":"63862291729495941",
 "ap_transactionid":"2091618255","verification":"verified","outcome":"paid","local_order":"unknown",
 "forwarding":{"destination":"kkchat","status":"delivered","http_status":200,"attempts":1}}
```

KKChat reported that it did not receive or process the callback. Two problems on the Firvanra side:

- The form body was forwarded as `application/x-www-form-urlencoded`, but KKChat expects JSON.
- Any 2xx counted as `delivered` and the response body was thrown away. A fallback HTML page and a working handler looked the same.

## 2. What did not change

- **Incoming AirPay format.** AirPay may still post form-encoded or JSON bodies to `https://firvanra.online/callback/cpm/arp_firvanra/collection`. Both are parsed as before.
- **Verification order.** The checks run in this order: `ap_SecureHash` (CRC32) and merchant id, then the AirPay Verify API (server-side), then identity, amount and currency cross-checks, then status confirmation. Only after all of them is anything forwarded. An invalid, unverified, mismatched or unconfirmed callback is never forwarded.
- **URLs and routing.** The Success/Failed Response URL, the IPN URL, both `vercel.json` rewrites and the KKChat destination URL are unchanged.
- **Other gateways.** AirPay 1, SabPaisa and PayU are untouched. Their existing test suites pass.
- **Customer browser return.** It still redirects with a 303 on success or failure.

One hardening change is in the AirPay 2 field extractor (`services/airpay2.js`). It now also recognizes `MERCID`, the merchant-id name used in AirPay's uppercase JSON structure. Before this change, a `MERCID` belonging to another merchant was not rejected up front. Signature verification still caught it, because the hash binds the configured MID. It is now rejected with a 400 before the Verify API call.

## 3. Request sent to KKChat (default)

```http
POST https://kkchat.in/callback/cpm/arp_firvanra/collection
Content-Type: application/json
Accept: application/json

<JSON body, see below>
```

The body depends on how AirPay sent the callback:

| AirPay sent | KKChat receives |
|---|---|
| JSON (any Content-Type containing `json`, or no Content-Type with a body that starts with `{`) | **The original bytes, unchanged.** Field names (uppercase included), value types, key order, number and amount formatting and whitespace are all preserved. |
| Form (`application/x-www-form-urlencoded`, or anything else) | **A JSON object of the original fields.** Keys are the exact received names in the received order. Values are the exact received **strings**. For example, `"849.0"` stays `"849.0"` and is not normalized or converted to a number. |

The following hold in both cases:

- Nothing is added, renamed, dropped or replaced. There is no `verified` flag, no name mapping and no sample values. `MERCID`/`merchant_id`, `TRANSACTIONID`/`orderid`, `APTRANSACTIONID`/`ap_transactionid` and `ap_SecureHash` are exactly what AirPay sent for this payment.
- With a repeated form key, the last value wins. This is the same object that was verified.
- `ap_SecureHash` is a CRC32 over field **values**, so KKChat can recompute it from the JSON. This is tested.
- No credentials, private key or token are ever added. This is tested.

**Field names are AirPay's, not converted.** If AirPay posts a form with lowercase names (`orderid`, `ap_transactionid`, …), KKChat receives those lowercase names. If AirPay posts the uppercase JSON structure, KKChat receives it byte-for-byte. Following the instruction to preserve exact field names, no lowercase→uppercase mapping is applied. If KKChat needs uppercase names even when AirPay sends a lowercase form, that would be a deliberate mapping that KKChat must specify (§10).

Example: an uppercase JSON IPN for merchant 2 is forwarded exactly as received. The structure matches the sample KKChat shared. The values are always the real transaction's values, never the sample's.

```json
{"TRANSACTIONPAYMENTSTATUS":"SUCCESS","MERCID":"<merchant 2 MID>","TRANSACTIONID":"<orderid>",
 "APTRANSACTIONID":"<AirPay txn id>","AMOUNT":"100.00","CURRENCYCODE":"356","TRANSACTIONSTATUS":"200",
 "MESSAGE":"Success","ap_SecureHash":"<as received>","CHECKOUT_TRANSACTION":"N"}
```

## 4. Response handling (default)

Every attempt reads at most **8 KiB** of the response, then cancels the stream. The read runs under the same 4 s timeout. Redirects are not followed (`redirect: "manual"`), so a 3xx is never treated as a delivery.

| KKChat response | Result | Retried in-request? | Response to AirPay |
|---|---|---|---|
| 2xx, `Content-Type: application/json` (parameters and `+json` types allowed), body parses as JSON | **delivered** (received). `acknowledgement:"unconfirmed"` unless an ack rule is set (§6). | no | 200 |
| 2xx, HTML body | failed, `error:"response_html"` | no | 502 |
| 2xx, JSON body but non-JSON or missing Content-Type | failed, `response_content_type` | no | 502 |
| 2xx, malformed or oversized JSON (including HTML served as JSON) | failed, `response_malformed_json` | no | 502 |
| 2xx, plain text | failed, `response_not_json` | no | 502 |
| 2xx, empty body | failed, `response_empty` | no | 502 |
| 4xx (other than 429) | failed | no | 502 |
| 5xx / 429 / timeout / network error | failed | yes (2 attempts total) | 502 |

Why a non-JSON 2xx is a failure: KKChat confirmed that its response is `application/json`. Any other 2xx shows that the request did not reach a working JSON handler, which is the production incident in §1. These failures are deterministic, so they are not retried within the request. They are also **not** remembered for dedup, and AirPay receives a 502. If AirPay re-sends the callback, it is forwarded again. Local order settlement has already happened at that point and is kept.

The response body is never logged, because it may echo payment data.

## 5. Logging

The summary line `[airpay2 callback] summary {...}` contains, under `forwarding`:

`status` (`delivered` / `failed` / `duplicate` / `not_forwarded`), `request_format`, `request_content_type`, `http_status`, `response_content_type` (truncated to 100 characters), `response_kind` (`json` / `html` / `text` / `empty`), `response_json` (`parsed` / `malformed` / `n/a`), `response_content_type_json` (true/false), `acknowledgement` (`confirmed` / `rejected` / `unconfirmed`), `attempts` and `error`.

The line includes `orderid` and `ap_transactionid`. It never includes the amount, the hash, credentials or any response body.

## 6. Receipt vs. business processing (acknowledgement)

- **Received**: KKChat answered 2xx with valid JSON. This is all that can be established today.
- **Confirmed**: the JSON response says that KKChat processed the callback. To tell that from the response, we need KKChat's response schema, which has not been supplied. Firvanra therefore does not invent a field such as `success: true`. With no rule, every delivery is logged `acknowledgement:"unconfirmed"`, and nothing in Firvanra treats the payment as settled at KKChat.
- A received but unconfirmed delivery **is acknowledged to AirPay (200), remembered for dedup and not retried**. Retrying it would send the same payment notification to KKChat again just because its schema is unknown.

`AIRPAY2_KKCHAT_ACK=field=value[|value…]` (for example `status=success`) is kept for when KKChat supplies its schema. With it set, a valid JSON 2xx counts as delivered only if `field` equals one of the values (`confirmed`). If the field has another value, the result is `rejected`. If the field is missing, the result is `unconfirmed`. Both of those fail the delivery with a 502 and are not retried in-request. Only `ack_value` is kept in the forwarder result: the field's value, at most 40 characters.

## 7. Retries and duplicates (unchanged)

- There are 2 attempts, with a 300 ms back-off, on 5xx, 429, timeout and network errors only.
- Only successful deliveries are kept in dedup memory (`ap_transactionid:transaction_status`). A browser return racing an IPN, or a re-send of the same event, produces one KKChat request. The duplicate reports the remembered acknowledgement.
- **Limitation:** dedup and retries are in-memory and per process. There is no queue or database, so exactly-once delivery is not guaranteed across cold starts or Vercel instances. KKChat should be idempotent on `ap_transactionid`.

## 8. Configuration and rollback

| Variable (API project) | Value | Effect |
|---|---|---|
| `AIRPAY2_KKCHAT_FORMAT` | unset or `json` | **Default.** JSON request and the JSON response checks in §4. Any unrecognized value also means JSON, and a warning is logged once. |
| | `form` (or `raw`) | **Rollback.** The callback's original bytes are sent with their original Content-Type. Response handling goes back to the previous lenient rule: any 2xx is a delivery, HTML is logged as a warning, and the result is logged `unconfirmed`. |
| `AIRPAY2_KKCHAT_ACK` | unset | Default. No acknowledgement rule (§6). |
| | `field=value[\|value…]` | Requires that acknowledgement in the JSON response. This applies in both formats. |

Both variables are read on every request. **To revert to form forwarding:** set `AIRPAY2_KKCHAT_FORMAT=form` on the API Vercel project and redeploy. To revert the code, revert this branch's commits. There is no data or schema to migrate.

## 9. Tests

Local run, Node 24, no network (AirPay and KKChat are stubbed). No real transactions.

- backend `npm test`: **347 / 347 pass**, including the AirPay 1, SabPaisa, PayU, preflight and health suites
- `routes/payment.airpay2.test.js`: 99 / 99
- frontend `npm test`: **43 / 43 pass**
- frontend `vite build`: succeeds
- There is no lint or type-check script in either package.

AirPay 2 coverage includes:

- form → JSON conversion, and JSON → original bytes (also with no Content-Type)
- uppercase AirPay structure, end to end, for JSON and form callbacks: exact names, key order, string values, `ap_SecureHash` and the real `MERCID`, never `310123`
- amount formatting preserved (`"849.0"`)
- a foreign `MERCID` rejected before verify
- JSON request headers
- valid JSON 200: received, unconfirmed, acknowledged, duplicate not re-forwarded
- `+json` and charset content types accepted
- HTML, HTML-as-JSON, JSON-as-text/plain, missing Content-Type, plain text, empty and malformed responses: failed, not retried, 502
- JSON 4xx not retried; 5xx retried
- timeouts
- duplicates and concurrent duplicates
- invalid hash, tampered amount, wrong merchant, unverifiable and unconfirmed callbacks never forwarded
- the form rollback: original bytes and lenient handling
- ack-rule confirmed and rejected
- bounded response read

## 10. Open items for KKChat

1. **Success-response schema:** which JSON field and value mean "processed". Once known, set `AIRPAY2_KKCHAT_ACK`.
2. **Field-name casing for form callbacks:** confirm whether lowercase names, as AirPay sends them in a form, are acceptable, or whether a mapping is required (§3).
3. **Error-response shape:** which errors are permanent and which are retryable.
4. **Idempotency** on `ap_transactionid` (§7).
5. **Authentication:** the relay is unauthenticated, as it was before this change.

## 11. Manual production verification

1. Merge, then deploy the API project. No environment change is needed for JSON. Make sure `AIRPAY2_KKCHAT_FORMAT` is not set to `form` or `raw`.
2. Owner-run ₹1 AirPay 2 payment. Do not use a test script against the live gateway.
3. In the Vercel function logs, find the `[airpay2 callback] summary` line for that `ap_transactionid`. Expect `verification:"verified"`, `request_format:"json"`, `request_content_type:"application/json"`, `http_status:200`, `response_kind:"json"`, `response_json:"parsed"`, `response_content_type_json:true`, `status:"delivered"` and `acknowledgement:"unconfirmed"`.
4. If the status is `failed` with `error:"response_*"`, share the summary line (not the body) with KKChat. It shows what their endpoint answered. If needed, roll back (§8).
5. **KKChat confirms the order is credited on its side.** Only this proves business processing. `acknowledgement:"unconfirmed"` will remain until §10.1 is answered.
6. Regression: one payment each through AirPay 1, SabPaisa and PayU.

## Requirements matrix

| Requirement | Result |
|---|---|
| Form and JSON AirPay callbacks accepted and verified first | PASS |
| JSON forwarding is the default; form is an explicit rollback | PASS |
| Exact field names (uppercase included), string values, amount format and `ap_SecureHash` preserved | PASS |
| Real merchant and transaction ids, never sample values | PASS |
| `Content-Type` and `Accept` set to `application/json` | PASS |
| HTTP status, Content-Type and JSON parse checked; HTML, malformed JSON and wrong Content-Type rejected | PASS |
| Receipt distinguished from confirmed processing; no invented ack field | PASS |
| Unconfirmed-but-received deliveries not retried | PASS |
| Optional `AIRPAY2_KKCHAT_ACK` preserved | PASS |
| Verification, bounded retries and dedup preserved | PASS |
| URLs, Vercel rewrites, AirPay 1, SabPaisa and PayU unchanged | PASS |
| No sensitive data or response bodies in logs | PASS |
| KKChat success-response schema | **UNVERIFIED (not supplied)** |
| KKChat processes the JSON in production | **UNVERIFIED (§11)** |
| Exactly-once delivery | **Not guaranteed (architectural, §7)** |
