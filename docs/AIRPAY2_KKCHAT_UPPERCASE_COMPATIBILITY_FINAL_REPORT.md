# AirPay 2 → KKChat: opt-in uppercase field names — final report

Branch `fix/airpay2-kkchat-uppercase-fields`, from `origin/main` at `f725821` (the commit production reported as `f7258213ba35`).

> **Status.** This change is implemented, tested with mocks, and ready for review. It is **off by default**: until someone sets `AIRPAY2_KKCHAT_FIELD_CASE=uppercase`, every outgoing request stays byte-for-byte what it was before. Nothing here has been deployed or enabled, and no live payment or callback has been sent. Historical transaction `2091680468` / order `68862341366613893` was **not** replayed.

## 1. What changed

When `AIRPAY2_KKCHAT_FIELD_CASE=uppercase` is set and JSON forwarding is active, Firvanra renames the known AirPay 2 field aliases in the **outgoing** KKChat JSON body to AirPay's uppercase names. Nothing else changes:

- The inbound callback is never changed.
- The CRC32 integrity check and the merchant check run unchanged.
- The server-side Verify API check runs unchanged.
- The rename happens after all three checks and immediately before the POST.

| Outgoing key | Incoming aliases renamed to it | In KKChat's uppercase sample? |
|---|---|---|
| `MERCID` | `merchant_id`, `MERCHANTID`, `mercid` | yes |
| `TRANSACTIONID` | `orderid` | yes |
| `APTRANSACTIONID` | `ap_transactionid` | yes |
| `AMOUNT` | `amount` | yes |
| `TRANSACTIONSTATUS` | `transaction_status` | yes |
| `TRANSACTIONPAYMENTSTATUS` | `transaction_payment_status` | yes |
| `MESSAGE` | `message` | yes |
| `CURRENCYCODE` | `currency_code` | yes |
| `CHMOD` | `chmod` | **no**: AirPay's own uppercase alias |
| `CUSTOMERVPA` | `customer_vpa` | **no**: AirPay's own uppercase alias |
| `ap_SecureHash` | `ap_securehash`, `AP_SECUREHASH` (`ap_SecureHash` kept as is) | yes |

The alias list is exactly the set `services/airpay2.js` `extractTxnFields` already accepts for verification. No other alias is guessed: `OrderId`, `merchantid`, `txn_id` and similar keys pass through unchanged.

Rules:

- **Only key names change.** Values are never changed, and `ap_SecureHash` is never computed or replaced.
  - JSON value types are kept.
  - Numbers keep their exact source digits, using `JSON.parse` source-text access and `JSON.rawJSON` (Node 24). For example, `12.50` stays `12.50` and `12345678901234567890` is not rounded. If a runtime lacks source-text access, a number that would not round-trip fails closed.
- **Unknown fields keep their names and values:** `udf*`, custom fields, `CHECKOUT_TRANSACTION`, nested objects. Only top-level keys are renamed.
- **No fabrication.** A field AirPay did not send is never added.
- **Duplicate aliases:**
  - Two aliases of one field with equal values collapse into one key (e.g. `orderid` and `TRANSACTIONID` both `"X"` → one `TRANSACTIONID`).
  - Different values **fail closed**: no request is sent, the route answers 502 (not acknowledged), and the log contains field **names** only.
  - The 502 is not remembered as a delivery. After removing the flag, AirPay's re-send is forwarded normally. A test covers this.
- **Format interaction:**
  - With `AIRPAY2_KKCHAT_FORMAT=form` or `raw`, the original raw bytes and content type are sent whatever the flag says. The summary then reports `field_case: "passthrough"`, because the field is what was *applied*.
  - Unset, empty or unrecognised flag values (`passthrough`, `garbage`, …) mean passthrough.

### Diagnostics

- New field `field_case` (`"passthrough"` or `"uppercase"`). It appears in:
  - the route's `[airpay2 callback] summary` line (`forwarding.field_case`)
  - the forwarder's delivered/failed log
  - the opt-in debug `request` record
- The debug fields `field_names`, `request_bytes`, `request_sha256` and `Content-Length` describe the **final** outgoing body, after the rename. Tests check this against the bytes KKChat received.
- A blocked conflict logs `[airpay2 forward] not sent: outgoing field mapping failed {"ref":…,"error":"field_alias_conflict","field_names":[…]}`, plus a debug `not_sent` record when debug is enabled. Values are not logged.
- These are unchanged: `User-Agent: Firvanra-AirPay2-Relay/1.0 (+https://firvanra.online)`, the per-attempt `X-Firvanra-Relay-Id`, timings, DNS/destination, the response classification, and the rule that an HTTP 200 is a transport delivery only (`payment_recorded: "unconfirmed"`).

### Differences from the supplied `fix.patch`

The patch targeted an older context, so it was implemented by hand on current `main` rather than applied with `git apply`. Its intent is kept. Changes made:

1. **Number preservation.** The patch's `JSON.parse` → `JSON.stringify` would re-serialize numbers, for example rounding integers above 2^53 and turning `12.50` into `12.5`. The version here keeps the source digits.
2. **`field_case` reports what was applied.** The patch reported `"uppercase"` even under the form rollback, where nothing is renamed.
3. **Conflict log line is JSON**, so it is searchable and its field names show in every log sink. A debug `not_sent` record was added.
4. Wider tests: 12 unit tests instead of 7, and 13 route tests instead of 3.

## 2. Changed files

| File | Change |
|---|---|
| `backend/services/kkchatFieldAdapter.js` | **new**: the flag reader and the outgoing-only alias renamer |
| `backend/services/kkchatFieldAdapter.test.js` | **new**: 12 unit tests |
| `backend/services/kkchatForwarder.js` | applies the adapter after `buildKkchatRequest`, only for JSON with the flag set; fail-closed path; `field_case` in the result and logs; header comment |
| `backend/routes/airpay2.js` | one line: `field_case` in the summary log |
| `backend/routes/payment.airpay2.test.js` | flag reset in `beforeEach`; 13 end-to-end tests; two pinned summary shapes now include `field_case: "passthrough"` |
| `backend/package.json` | test script includes the new unit test file |
| `docs/AIRPAY2_KKCHAT_UPPERCASE_COMPATIBILITY_FINAL_REPORT.md` | this report |

Not touched: AirPay 1 (`services/airpay.js`, `routes/payment.js`), SabPaisa, PayU, `services/airpay2.js` (CRC32, merchant check, Verify API), merchant credentials, the callback path and the KKChat URL constant, the frontend, and both Vercel configs (rewrites unchanged).

## 3. Tests

All tests are **simulated**. AirPay OAuth/Verify is mocked via `axios`, KKChat is stubbed via `fetch`, and the credentials are fake. Nothing external is contacted.

| Suite | Before | After |
|---|---|---|
| `backend` `npm test` | 389 pass / 0 fail | **414 pass / 0 fail** (+25) |
| `frontend` `npm test` | — | **43 pass / 0 fail** |
| `frontend` `npm run build` | — | **success** (vite, 50 modules) |

The new route tests run through the real `server.js`. They cover:

1. a lowercase form callback converted to uppercase JSON
2. a lowercase JSON callback converted to uppercase JSON, with nested objects, unknown fields and big numbers exact
3. an already-uppercase JSON callback sent byte-for-byte
4. mixed aliases with equal values collapsing into one field each
5. conflicting aliases (`orderid`/`TRANSACTIONID`, and both hash spellings) blocked after verification with zero KKChat calls and a 502; local settlement kept; values not logged
6. `ap_SecureHash` unchanged and never logged
7. unknown fields kept
8. flag unset, `passthrough` or `garbage`: exactly the previous bodies for form and JSON
9. flag enabled: the expected normalized JSON
10. flag plus `FORMAT=form` or `raw`: the original raw bytes and content type
11. with the flag on: invalid hash, wrong merchant and merchant-1-signed callbacks rejected (400) before Verify, never forwarded
12. with the flag on: Verify unavailable, no record, or success not confirmed → 503, never forwarded
13. an unknown local order with a verified AirPay transaction: forwarded, no order created
14. browser return followed by an IPN, and three concurrent IPNs: one KKChat delivery each
15. the exact KKChat URL, POST, and exactly four headers (`Accept`, `Content-Type`, `User-Agent`, `X-Firvanra-Relay-Id`)
16. debug `field_names`, byte count, SHA-256 and `Content-Length` equal to the final body, and different from the pre-rename body
17. rollback: a callback blocked by a conflict is delivered unchanged after the flag is removed

The existing AirPay 1, SabPaisa, PayU, preflight and health suites pass unchanged (item 17 of the brief).

## 4. Receiver compatibility: what is and is not established

| Evidence | Kind | What it shows |
|---|---|---|
| KKChat's sample / Postman body with uppercase names and dummy values: HTTP 200, `success`, receipt acknowledged by KKChat | **direct Postman, not payment** | KKChat's endpoint accepts an uppercase JSON body. It does **not** show that the payment handler parses or validates those keys, that uppercase is *required*, or that lowercase is rejected. |
| Earlier KKChat statement: "AirPay's own JSON structure (including the uppercase field names)" (`docs/AIRPAY2_KKCHAT_JSON_REQUEST_RESPONSE_FIX.md`) | written statement | The names in this mapping match that structure. |
| This branch's tests | **mocked** | Firvanra produces the intended body. They say nothing about KKChat's behaviour. |
| A live payment with the flag on | **not done** | Requires a separately authorized transaction. |

It is **not** claimed that lowercase names caused the earlier incident (`2091680468`), or that uppercase names are mandatory.

Still to confirm with KKChat before enabling:

1. Their handler **parses and validates** `MERCID`, `TRANSACTIONID`, `APTRANSACTIONID`, `AMOUNT`, `TRANSACTIONSTATUS`, `TRANSACTIONPAYMENTSTATUS`, `MESSAGE`, `CURRENCYCODE` and `ap_SecureHash`, not merely the HTTP receipt.
2. Whether `CHMOD` and `CUSTOMERVPA` (absent from their sample) are acceptable as uppercase, or should stay lowercase.
3. That key order is not significant. Firvanra keeps AirPay's order; their sample starts with `TRANSACTIONPAYMENTSTATUS`.
4. How they validate `ap_SecureHash`. The value is AirPay's, unchanged; the CRC32 input binds merchant-2's MID and username.
5. That `firvanra`'s merchant/route is registered on their side.
6. Their success-response body, so `AIRPAY2_KKCHAT_ACK` can be set, and their idempotency key (`APTRANSACTIONID`).

## 5. Production rollout (manual; only after review and KKChat's agreement)

1. Merge the reviewed PR. Pushing to `main` auto-deploys **both** Vercel projects (`firnvia` and `firnvia-b6m7`). With the flag unset, the deployed behaviour is unchanged.
2. In the Vercel dashboard, open the **API** project: the one with root directory `backend` and domain `api.firvanra.online`. Which of `firnvia` / `firnvia-b6m7` that is has not been confirmed, so check the project's Domains tab before setting anything. Go to Settings → Environment Variables → Production and set:
   ```env
   AIRPAY2_KKCHAT_FORMAT=json
   AIRPAY2_KKCHAT_FIELD_CASE=uppercase
   ```
   `json` is already the default when `AIRPAY2_KKCHAT_FORMAT` is unset; setting it explicitly is harmless. Do not set these on the frontend project.
3. Redeploy the API project's latest production deployment. Environment variables only take effect on a new deployment.
4. Open `https://api.firvanra.online/api/health/version` and check that the reported commit is this PR's merge commit.
5. Optional: open a debug window for the planned order id (`AIRPAY2_KKCHAT_DEBUG=true`, `AIRPAY2_KKCHAT_DEBUG_UNTIL=<≤7 days>`, `AIRPAY2_KKCHAT_DEBUG_ORDER_ID=<id>`), then redeploy.
6. Coordinate **one new, authorized, low-value** AirPay 2 payment with KKChat. In the API logs, expect `verification: "verified"`, `forwarding.field_case: "uppercase"` and a `relay_ids` value. Match the relay id against KKChat's access log, and get KKChat's confirmation that the payment was credited **exactly once**. Do not replay `2091680468` / `68862341366613893`, and do not send fabricated callbacks or hashes.

### Rollback

1. In the API project's Production environment, delete `AIRPAY2_KKCHAT_FIELD_CASE` (or set it to `passthrough`).
2. Redeploy.

Outgoing bodies return to the previous passthrough JSON immediately. No code revert is needed. Inbound verification, the gateway configuration and the URLs never changed. `AIRPAY2_KKCHAT_FORMAT=form` remains the separate rollback to raw-form forwarding.

## 6. Limitations

- Deduplication is in-memory, per instance, and unchanged by this PR. KKChat must be idempotent on `APTRANSACTIONID`.
- A conflict is deterministic: AirPay re-sends get the same 502 until the flag is removed. This is fail-closed by design; watch for `field_alias_conflict` in the logs.
- Only top-level keys are renamed.
- This change does not verify KKChat's receiver contract. See §4.
