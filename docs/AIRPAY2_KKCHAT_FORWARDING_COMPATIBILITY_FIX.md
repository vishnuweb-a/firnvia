# AirPay 2 → KKChat forwarding: response-compatibility fix

Branch: `fix/airpay2-kkchat-response-compatibility` (from `main` @ `93fe575`, the PR #2 merge).
Status: ready for review. Not merged, not deployed.

Legend: **[fact]** verified from code, tests or the production log line. **[assumption]** not verified.

## 1. The incident

Production summary for AirPay txn `2091655023` (order `64862320708921221`):

- verification `verified`, outcome `paid`, local order `unknown` (a KKChat order).
- Forwarded as JSON with `Content-Type: application/json` and `Accept: application/json`.
- KKChat answered **HTTP 200** with `Content-Type: application/json;charset=ISO-8859-1`.
- The body did not parse as JSON → `error: response_malformed_json`, `status: failed`.
- Because forwarding "failed", Firvanra answered AirPay **HTTP 502**.

**Confirmed cause [fact]:** PR #2 made the forwarder treat a 2xx as a delivery only if the body
was parseable JSON served as `application/json` (`jsonContractViolation` in
`backend/services/kkchatForwarder.js`). KKChat's 200 failed that check. The forwarder then:

1. marked the delivery as failed,
2. did not remember it in the dedup map, and
3. made the route return 502. A 502 asks AirPay to re-send, so every re-send would POST the
   same paid event to KKChat again.

Frontiva would have logged the same response as `airpay.callback.forward.success`. Frontiva never
reads the response body.

**Not established [assumption]:**
- What the body actually was. It was never logged, by design.
- Whether KKChat processed the callback.

`application/json;charset=ISO-8859-1` is the default a Java servlet container produces when a
handler sets only `application/json`. The charset is not the cause: JSON's structure is ASCII, so
decoding latin1 vs UTF-8 can only change characters inside strings, never whether the body parses.
The most likely body is a bare status string (for example `SUCCESS`) or an empty or partial body
written with a JSON content type. The new diagnostics (§5) will show which at the next callback.

## 2. Frontiva vs Firvanra

Frontiva reference: `vishnuweb-a/store`, `api/_lib/forward-callback.js` and `api/payments/callback.js`.

| Aspect | Frontiva | Firvanra (before) | Firvanra (this PR) |
|---|---|---|---|
| Input parsing | query ∪ body (body wins); JSON or form | body only; JSON or form | unchanged |
| Order of operations | forward **before** any verification, incl. unknown/malformed | integrity → Verify API → identity checks → **then** forward | unchanged (kept deliberately) |
| Request | `JSON.stringify(received)`, fields untouched | form → JSON object of the original names/string values; JSON → original bytes | unchanged |
| Headers | `Content-Type`/`Accept: application/json`, UA, loop guard | `Content-Type`/`Accept: application/json` | unchanged |
| Encrypted envelope | forwarded still enveloped | rejected at integrity (no `orderid` etc.), not forwarded | unchanged; see §8 |
| Redirects | follows one same-host https 307/308 | not followed, failure | not followed, failure (not counted as transport delivered) |
| 2xx handling | success; body never read | success only if body is parsed JSON as `application/json` | **success (transport delivered)**; a body issue is diagnosed separately |
| Retries | one attempt | up to 2 on 5xx/429/timeout/network | unchanged |
| Dedup | receiver's job | in-memory, per process | unchanged; a 2xx with a bad body is now remembered |
| Reply to AirPay | always 200 (500 only on its own DB failure) | 502 on any forwarding failure | 502 only when KKChat did **not** answer 2xx (or an explicit ack rule fails) |

**Which difference caused the incident:** only the "2xx handling" row. The other differences are
either intentional security properties (verify before forward, no redirect following) or are
unrelated to this incident. They are not changed for parity.

## 3. Request format (unchanged; verified compatible)

`POST https://kkchat.in/callback/cpm/arp_firvanra/collection` (a constant)

Headers:
- `Content-Type: application/json`
- `Accept: application/json`

Body:
- **Form callback:** a JSON object with exactly the received field names, in received order, all
  values strings.
- **JSON callback:** the original bytes.
- `ap_SecureHash` is passed through untouched. Nothing is added, renamed or dropped.

### Field casing vs KKChat's sample

| | Merchant | Order / txn | Status | Hash |
|---|---|---|---|---|
| KKChat sample (uppercase) | `MERCID` | `TRANSACTIONID`, `APTRANSACTIONID` | `TRANSACTIONSTATUS`, `TRANSACTIONPAYMENTSTATUS` | `ap_SecureHash` |
| AirPay v4 form callback as tested (lowercase) | `merchant_id` | `orderid`, `ap_transactionid` | `transaction_status`, `transaction_payment_status` | `ap_SecureHash` |

- **[fact]** Firvanra's parser (`extractTxnFields` in `services/airpay2.js`) accepts both spellings,
  so uppercase and lowercase callbacks are verified the same way. Tests cover both.
- **[fact]** Both Firvanra and Frontiva forward whatever casing AirPay sent. Frontiva relays to the
  same KKChat host with the same rule.
- **[fact]** The production callback's raw field names are not in the log, so this incident does
  not show which casing AirPay used.
- **[not established]** Whether KKChat's receiver accepts lowercase names. KKChat supplied a sample
  payload, not a receiver contract. Nothing indicates that KKChat requires uppercase.

**Decision:** no mapping was added. Renaming fields would change the payload that `ap_SecureHash`
accompanies. It would also be a guess about an undocumented contract, and it would diverge from
the working Frontiva relay. If KKChat confirms it needs uppercase names for lowercase callbacks,
add a deterministic mapping only to the outgoing KKChat body. Keep the received fields for
verification.

No sample value (MID, ids, amounts, hash) is used anywhere. A test asserts that no uppercase alias
is fabricated.

## 4. Response handling: what changed

Four facts are recorded separately:

| Fact | Field | Meaning |
|---|---|---|
| Transport delivered | `transport_delivered` | The POST completed with a 2xx from KKChat |
| Response valid | `response_valid`, `response_issue` | `application/json` and the body parses; otherwise `html` / `empty` / `not_json` / `malformed_json` / `content_type` |
| Application acknowledged | `acknowledgement` | `confirmed` only when `AIRPAY2_KKCHAT_ACK` is configured and matched; otherwise `unconfirmed` |
| Payment recorded | `payment_recorded` | Always `unconfirmed`: Firvanra cannot know it |

### Status semantics

| KKChat result | Before | After |
|---|---|---|
| 2xx, valid JSON | delivered, AirPay 200 | same |
| 2xx, HTML / empty / text / malformed / wrong type | **failed**, AirPay **502**, not deduped | **delivered** + `response_issue` + warning log, AirPay 200, deduped |
| 3xx | failed (no error code), 502 | failed, `error: redirect_not_followed`, 502 |
| 4xx | failed, 502, not retried | same |
| 5xx / 429 | failed, 502, retried once | same |
| timeout / network | failed, 502, retried once | same |
| ack rule set but not met (`AIRPAY2_KKCHAT_ACK`) | failed, 502 | same (explicit opt-in contract wins), `transport_delivered: true` |

Response decoding:
- The `Content-Type` charset is honoured: ISO-8859-1, latin1, us-ascii and windows-1252 decode as
  latin1; anything else decodes as UTF-8.
- A UTF-8 BOM is stripped.
- Reading stays bounded at 8 KiB.

### Why the 502 is removed for a 2xx

KKChat answered 200, so it may already have processed the paid event. A 502 asks AirPay to send
it again. Each re-send would POST the same event to KKChat again, because the failed delivery was
not deduped. That risks duplicate credits, depending on KKChat's own idempotency, and it can never
fix a deterministic body mismatch. The 502 is kept where it can help: when KKChat demonstrably did
not receive the callback.

### Rollback switch

`AIRPAY2_KKCHAT_STRICT_RESPONSE=true` restores the PR #2 behaviour exactly: a 2xx with a bad body
fails as `response_<issue>`, returns 502 and is not deduped. It is read per request, so changing
it needs no redeploy beyond the environment change.

## 5. Diagnostics added (no payload, no secrets)

These fields are added to the `[airpay2 callback] summary` line:

- `transport_delivered`
- `response_valid`, `response_issue`
- `response_charset`, `response_bytes`, `response_truncated`
- `response_shape`: the class of the body's first character (`object` / `array` / `markup` /
  `quoted` / `word` / `digit` / `other` / `empty`)
- `response_word`: the whole body, **only** if it is a single bare word of ≤24 letters, `_` or
  `-`. That excludes digits and spaces, so it can never carry an id, an amount or a name.
- `response_server`: the `Server` header, ≤40 chars, which shows whether a proxy or the app
  answered
- `payment_recorded`

The response body itself is never logged. Correlation is by `ap_transactionid`. The existing test
asserts that no AirPay 2 credential and no `ap_SecureHash` appear in the logs.

## 6. Security protections retained (unchanged code paths)

- Merchant id must equal the configured AirPay 2 MID. Callbacks for merchant 1 and foreign MIDs
  are rejected.
- `ap_SecureHash` (CRC32) integrity check, before any network call.
- Server-side AirPay Verify API confirmation with merchant-2 credentials. If it is unavailable,
  nothing is settled or forwarded and AirPay gets 503.
- Order id, AirPay txn id, merchant, amount and currency must match the Verify record.
- Only a status that the Verify record confirms is forwarded. A claimed success that AirPay
  reports as pending is not forwarded.
- Local settlement is unchanged and independent of forwarding. A paid order cannot regress, and
  orders from other gateways are untouched.
- The KKChat URL is a constant. Redirects are never followed.
- Dedup of browser return + IPN, including concurrent arrivals.

Firvanra still never forwards an unverified callback. Frontiva's forward-everything behaviour was
deliberately **not** adopted.

## 7. Files changed

- `backend/services/kkchatForwarder.js`: separation of transport and response validity, charset
  and BOM handling, payload-free body description, `redirect_not_followed`, strict-mode switch.
- `backend/routes/airpay2.js`: summary log fields only. The control flow is unchanged: 502 still
  follows `!fwd.ok`, and `ok` changed meaning in the forwarder.
- `backend/routes/payment.airpay2.test.js`: updated expectations and 15 new tests.
- `docs/AIRPAY2_KKCHAT_FORWARDING_COMPATIBILITY_FIX.md`: this report.

Not touched:
- AirPay 1, SabPaisa, PayU
- credentials
- `frontend/vercel.json`, `backend/vercel.json`, `server.js`
- the callback, IPN and KKChat URLs

## 8. Tests

| Suite | `main` | This branch |
|---|---|---|
| Backend (`npm test`, 9 files incl. AirPay 1, SabPaisa, PayU, preflight, health) | 347 pass | **362 pass, 0 fail** |
| Frontend (`npm test`) | n/a | 43 pass, 0 fail |
| Frontend build (`vite build`) | n/a | OK |

### New or changed coverage

- **Incident replay:** 200 + `application/json;charset=ISO-8859-1` + body `SUCCESS` gives
  AirPay 200, `transport_delivered`, `response_json: malformed`, `response_word: SUCCESS`,
  `acknowledgement: unconfirmed` and `payment_recorded: unconfirmed`. A re-send is a duplicate,
  with no second POST.
- **2xx bad bodies:** for HTML, empty, plain text, malformed JSON, JSON with the wrong type and
  JSON with no type, the result is delivered with `response_issue` and AirPay 200. The same six
  in strict mode fail with 502 (previous behaviour).
- **Decoding:** ISO-8859-1 bytes decode and parse; a UTF-8 BOM is tolerated; charset parsing has
  unit tests.
- **Diagnostics privacy:** `describeBody` never exposes names, ids or amounts.
- **Redirects:** 301, 302, 307 and 308 are not followed, not counted as transport delivered,
  not retried, and give 502.
- **Failure types:** 404, 503, timeout and network failures are distinguishable and never count
  as transport delivered.
- **Ack rule:** with an ack rule set, a malformed 2xx is transport delivered but not acknowledged.
- **Lowercase callbacks:** a lowercase form callback is forwarded with identical names, the real
  MID and the original `ap_SecureHash`, with no fabricated uppercase keys.

### Already covered and still passing

form→JSON, JSON→original bytes, exact URL and headers, uppercase JSON and form callbacks, amount
formatting, invalid hash, wrong merchant, unverified or unavailable verify, mismatches, unknown
local order, duplicates and concurrency, 4xx/5xx/timeout, AirPay 1 / SabPaisa / PayU.

Frontiva's own suite was not re-run here. It is a separate repository, used only as a read-only
reference.

## 9. Rollback

1. **Fastest:** set `AIRPAY2_KKCHAT_STRICT_RESPONSE=true` on the backend Vercel project. This
   restores PR #2 response handling without a redeploy of code.
2. **Full:** revert this PR's merge commit on `main`. Pushing to `main` auto-deploys.
3. The request format rollback is unchanged: `AIRPAY2_KKCHAT_FORMAT=form`.

## 10. Remaining risks

- **KKChat processing is still unconfirmed.** A 200 is recorded as transport only. Ask KKChat
  whether txn `2091655023` (order `64862320708921221`) was credited, and for its documented
  success-response body. With that, set `AIRPAY2_KKCHAT_ACK=<field>=<value>`, or fix their
  Content-Type or body.
- **Lost failures.** If KKChat's 200 actually meant "rejected" with a non-JSON body, Firvanra now
  acknowledges AirPay and will not re-forward. This matches Frontiva's behaviour, and the warning
  log line plus `response_issue` makes such cases visible. Strict mode is the alternative.
- **Field casing** is unconfirmed by KKChat (§3).
- **Dedup is per process.** A cold Vercel instance can forward a re-send again. This is
  pre-existing behaviour.
- **Encrypted envelopes.** Firvanra rejects AirPay envelope-style callbacks at integrity, whereas
  Frontiva forwards them. None has been observed for AirPay 2; the production callback was
  plaintext form. Pre-existing behaviour.
- **Query string.** Firvanra ignores query-string fields; Frontiva merges them. The production
  callback verified from the body alone. Pre-existing behaviour.

## 11. Controlled production test (after review and deploy)

1. Do **not** replay the earlier paid transaction or send synthetic callbacks to production.
2. Make one small real AirPay 2 payment through checkout.
3. In the Vercel logs, find `[airpay2 callback] summary` for that `ap_transactionid`. Expect:
   - `verification: verified`
   - `forwarding.transport_delivered: true`
   - `http_status: 200`
   - `response_valid` and, if false, `response_issue`, `response_shape`, `response_word` and
     `response_server`. These tell KKChat what their endpoint returned.
4. Confirm that AirPay received 200 and that there was no repeated delivery (only one summary
   line with `status: delivered`; any later lines are `duplicate`).
5. Ask KKChat to confirm independently that the order was credited exactly once. Until then,
   treat `payment_recorded` as unconfirmed.
