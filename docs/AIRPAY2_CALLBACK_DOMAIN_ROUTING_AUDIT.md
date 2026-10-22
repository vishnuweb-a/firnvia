# AirPay 2 Callback Domain Routing Audit

**Date:** 2026-10-22
**Branch:** `audit/airpay2-callback-domain-routing` (from `main` @ `32f2099`)
**Question:** Why did a callback sent to `https://firvanra.online/callback/cpm/arp_firvanra/collection` get logged with `Host: api.firvanra.online`?

Evidence tags: **[code]** read in the repository · **[test]** asserted by an automated test run on this branch · **[live]** observed against production with read-only `GET` requests · **[UNVERIFIED]** not confirmed.

---

## 1. Root cause

**This is expected proxy behavior, not a defect. No production code or configuration was changed.**

`frontend/vercel.json` belongs to the Vercel project that serves `firvanra.online`. It defines an **external rewrite** (a server-side proxy, not a browser redirect):

```json
{ "source": "/callback/cpm/arp_firvanra/collection",
  "destination": "https://api.firvanra.online/callback/cpm/arp_firvanra/collection" }
```

**[code]** When the destination of a Vercel rewrite is an absolute URL on another host, Vercel's edge opens a new upstream request to that host. That request carries the original method, headers, body and query string. Its `Host` is the destination host, `api.firvanra.online`, so the Express function in the API project sees and logs `Host: api.firvanra.online`. AirPay itself only contacted `firvanra.online`.

Supporting evidence:

| Observation | Tag |
|---|---|
| `GET https://firvanra.online/callback/cpm/arp_firvanra/collection` → `405`, `Allow: POST`, body `{"error":"Method Not Allowed"}`. That is Express's own handler (`airpay2CallbackMethodNotAllowed`), not SPA HTML and not a redirect. | [live] |
| Same `GET` with `?probe=1` → identical `405` from Express | [live] |
| `X-Vercel-Id` on the root-domain request is `bom1:bom1:bom1::iad1::…`. On the direct API request it is `bom1::iad1::…`. The extra edge hops are the proxy leg from the frontend project to the API project. | [live] |
| `GET https://firvanra.online/api/health` → `{"ok":true,"service":"firvanra-api"}` (the existing `/api/*` rewrite works the same way) | [live] |
| No `redirects` block in `frontend/vercel.json`. The callback rewrite comes **before** the SPA catch-all `/((?!api/).*) → /index.html` (first match wins). | [code][test] |
| Production log: `verification: "verified"`, `outcome: "paid"`, forwarded to KKChat with HTTP 200 in 1 attempt. A `POST` with a form body therefore reached the handler intact, since CRC32 and Verify API checks both passed on the received bytes. | production log |

### Answers to the specific questions

| Question | Answer |
|---|---|
| Is the root callback URL routed directly to Express? | No. It is proxied: frontend project → external rewrite → API project → Express. [code][live] |
| Does `firvanra.online` redirect to `api.firvanra.online`? | **No.** There is no 30x; the root-domain response is Express's own 405. [live] |
| Does the rewrite preserve method and body? | Yes. `GET` is seen as `GET` (405), and the production `POST` was verified and forwarded byte-for-byte, which requires an intact body. [live] + production log |
| Does it preserve the query string? | Vercel passes the incoming query string through on rewrites, and `?probe=1` still reached Express. The handler reads only the body, so the query string has no effect on processing. [live][test] |
| Is the callback registered on both domains? | Express registers the path once; both hostnames reach it (`api.` directly, the root domain via the proxy). [code][live] |
| Could requests fall into the SPA fallback? | Not at the exact path. **Yes** at `…/collection/` (trailing slash), which returns SPA HTML `200`. It only matters if the AirPay dashboard has a trailing slash; see §8. [live] |
| Is the Host discrepancy expected? | Yes. It is inherent to an external rewrite. Do not force or rewrite the Host header. |
| Can return and IPN share one endpoint? | Yes. Both go through the same CRC32 check and Verify API confirmation. The channel only chooses the response body (HTML vs JSON), never the HTTP status or processing. Forwarding is deduplicated per `ap_transactionid:transaction_status`. [code][test] |
| Does `channel: "ambiguous"` indicate a problem? | **No.** It means a form-encoded `POST` without browser navigation headers (`Accept: text/html` / `Sec-Fetch-Mode: navigate`). It was almost certainly a server-to-server IPN; real browser returns carry those headers. The callback was verified, settled and forwarded normally. An ambiguous callback gets JSON responses, and its HTTP status follows the outcome. [code][test] |
| `local_order: "unknown"`? | Expected. Order `69862278118586245` is not a Firvanra order (Firvanra ids are `FIR-…`). The handler never creates orders for unknown ids and still forwards the verified callback to KKChat. [code] |

---

## 2. Existing callback architecture

```
AirPay 2 ──POST (response or IPN)──▶ https://firvanra.online/callback/cpm/arp_firvanra/collection
                                       │  frontend project, frontend/vercel.json
                                       │  external rewrite (method/headers/body/query kept; Host → api.)
                                       ▼
                                     https://api.firvanra.online/callback/cpm/arp_firvanra/collection
                                       │  API project, backend/vercel.json: /(.*) → server.js
                                       ▼
                                     server.js: app.post(AIRPAY2_CALLBACK_PATH, express.raw, handler)
                                       │  registered BEFORE global json/urlencoded parsers
                                       ▼
                                     routes/airpay2.js handleAirpay2Callback
                                       1. parse raw body (form or JSON)             → 400 if malformed
                                       2. verifyCallback: fields, merchant id, CRC32 → 400 if forged
                                       3. verifyTransaction: AirPay Verify API      → 503 if unavailable
                                       4. identity match (orderid, txn, MID, amount, currency) → 400
                                       5. settleLocalOrder (only for airpay_2 FIR- orders; never regresses paid)
                                       6. forward only if callback status == verified status
                                       ▼
                                     services/kkchatForwarder.js
                                       POST constant https://kkchat.in/callback/cpm/arp_firvanra/collection
                                       raw bytes + original Content-Type, 2 attempts, 4 s timeout,
                                       in-memory dedup on ap_transactionid:transaction_status
```

Responses: browser channel → `303` to `FRONTEND_URL/order/…` on success, or an HTML page. Every other channel → JSON. The HTTP status reflects the outcome on every channel: `200` acknowledged, `400` rejected, `502` relay failed, `503` unverifiable. So an IPN that could not be confirmed is never acknowledged.

The browser redirect is built from `FRONTEND_URL`, not from the request `Host`, so the proxy's `Host: api.firvanra.online` cannot send customers to the API domain. [code][test]

---

## 3. Domain routing behavior (observed 2026-10-22)

| Request (`GET`, read-only) | Result | Meaning |
|---|---|---|
| `https://firvanra.online/callback/cpm/arp_firvanra/collection` | `405` JSON, `Allow: POST` | Proxied to Express ✔ |
| same + `?probe=1` | `405` JSON | Query string doesn't break routing ✔ |
| `https://api.firvanra.online/callback/cpm/arp_firvanra/collection` | `405` JSON | Backend direct ✔ |
| `https://firvanra.online/api/health` | `200 {"ok":true,"service":"firvanra-api"}` | `/api/*` rewrite ✔ |
| `https://www.firvanra.online/callback/…` | `308` → `https://firvanra.online/callback/…` | Domain redirect (not used by AirPay) |
| `http://firvanra.online/callback/…` | `308` → `https://…` | HTTPS redirect (not used by AirPay) |
| `https://firvanra.online/callback/…/collection/` | `200` SPA HTML | Trailing slash **misses** the rewrite |

Deployments: GitHub commit status for `32f2099` shows `Vercel – firnvia` and `Vercel – firnvia-b6m7` both "Deployment has completed". [live]

No `POST` was sent to production. No live callback was fabricated.

---

## 4. Files inspected

- `frontend/vercel.json`: rewrites (`/api/*`, callback path, SPA fallback)
- `backend/vercel.json`: `server.js` as a single `@vercel/node` function, `/(.*) → /server.js`
- `backend/server.js`: route registration order, raw parser before global parsers
- `backend/routes/airpay2.js`: callback handler, channel detection, settlement, responses
- `backend/services/airpay2.js`: CRC32 verification, Verify API, status classification (via its exports and tests)
- `backend/services/kkchatForwarder.js`: constant destination, retries, dedup
- `backend/routes/payment.js`: AirPay 1, SabPaisa, PayU callbacks (regression scope)
- `backend/routes/payment.airpay2.test.js` and the other backend/frontend test files
- `frontend/vite.config.js`: dev-only `/api` proxy, not involved in production
- `VERCEL_DEPLOYMENT.md`, `docs/AIRPAY2_CALLBACK_IPN_FORWARDING_AUDIT.md`, `docs/FIRVANRA_SECOND_AIRPAY_IMPLEMENTATION_REPORT.md`
- Repository-wide search: `firvanra.online`, `api.firvanra.online`, `arp_firvanra`, `airpay2`, `kkchat.in`, `AIRPAY_CREDNAME_2` (no occurrences; the AirPay 2 variables are `AIRPAY_*_2`), `callback`, `IPN`, `redirect`, `rewrite`

No secret values were read or printed.

---

## 5. Changes made

**Production code and configuration: none.** No defect was found, so per the brief no speculative change was made. `frontend/vercel.json`, `backend/vercel.json`, `server.js`, all routes, services, environment variable names, public URLs and the forwarding destination are unchanged.

**Tests added** (`backend/routes/payment.airpay2.test.js`). They send the request in the shape Vercel's external rewrite delivers it (`Host: api.firvanra.online`, `X-Forwarded-Host: firvanra.online`, `X-Forwarded-Proto: https`, optional query string), using `node:http` because `fetch` cannot set `Host`:

| Test | Asserts |
|---|---|
| proxied form IPN (Host: api.firvanra.online, query string) | `200` ack; order paid; one KKChat delivery to the constant URL; forwarded body byte-identical, without the query string |
| proxied JSON IPN | `200`; paid; original JSON bytes and `application/json` forwarded |
| proxied browser return | `303` to `https://firvanra.online/order/…`, i.e. from `FRONTEND_URL`, not the API `Host` |
| proxied forged callback | `400`; order untouched; Verify API not called; nothing forwarded |

**Report:** this file.

---

## 6. Automated test results

Run on branch `audit/airpay2-callback-domain-routing`, Node 24, all external calls mocked (AirPay OAuth/Verify via `axios` mock, KKChat via a `fetch` stub, fake credentials):

| Suite | Result |
|---|---|
| `backend` `npm test` (PayU, SabPaisa, AirPay 1 production, preflight e2e, AirPay 2, health) | **316 / 316 pass** |
| of which `routes/payment.airpay2.test.js` | 68 / 68 pass (64 existing + 4 new) |
| `frontend` `npm test` | **43 / 43 pass** |

Requested coverage matrix, mapped to existing and new tests:

| Case | Covered by |
|---|---|
| Root-domain callback POST reaches handler | config test `firvanra.online proxies the callback path…` + new `proxied …` tests + [live] 405 via root domain |
| Form-encoded body preserved | `browser return (form) success…`, `form-encoded IPN success…`, `proxied form IPN…` |
| JSON body preserved | `IPN (JSON) success…`, `proxied JSON IPN…` |
| Query parameters | `proxied form IPN… query string` (routing unaffected, body unaffected) + [live] `?probe=1` |
| Valid verified payment | `browser return (form) success…`, `IPN (JSON) success…` |
| Failed payment | `failed payment…`, `form-encoded IPN failure…`, `browser return failure…` |
| Invalid / forged | `invalid hash…`, `tampered amount…`, `wrong merchant…`, `malformed…`, `proxied forged callback…`, verify mismatch tests |
| Duplicate delivery | `duplicate browser return + IPN…`, `concurrent duplicate callbacks…`, `IPN first, then browser return…`, `delayed IPN…` |
| IPN processing + forwarding | `IPN (JSON) success…`, `form-encoded IPN …` tests |
| Success/failure response | browser-return tests (303 / HTML page) |
| AirPay 1 regression | `the existing callback routes are untouched`, `the original AirPay initiate route is still separate`, `payment.airpay.production.test.js` |
| SabPaisa / PayU regression | `payment.sabpaisa*.test.js`, `payment.payu.test.js`, `services/*.test.js` |

---

## 7. Production verification steps

Safe, no financial transaction:

```bash
# 1. Rewrite reaches Express (must be 405 JSON with Allow: POST, never HTML or 30x)
curl -i https://firvanra.online/callback/cpm/arp_firvanra/collection

# 2. Backend direct
curl -i https://api.firvanra.online/callback/cpm/arp_firvanra/collection

# 3. Optional POST that touches no state: an empty JSON object is rejected at
#    parse/field validation (400) before any Verify API call or forwarding.
curl -i -X POST -H 'Content-Type: application/json' -d '{}' \
  https://firvanra.online/callback/cpm/arp_firvanra/collection
```

With a real low-value payment, run by the owner and not automated:

1. Make an AirPay 2 checkout on `https://firvanra.online` for the lowest-priced product.
2. In the Vercel logs of the **API** project, expect two `[airpay2 callback] summary` lines for the same `ap_transactionid`: one `channel: "browser"` (the return) and one `"ambiguous"` or `"ipn"` (the IPN). Both should show `verification: "verified"`. One should show forwarding `delivered`, and the other `duplicate` if it hit the same warm instance, or `delivered` again if it hit a different one (see §8).
3. The browser lands on `https://firvanra.online/order/<id>?…&returnStatus=success`.
4. Confirm with KKChat that the transaction was received.

---

## 8. Outstanding risks and manual actions

| # | Item | Status |
|---|---|---|
| 1 | **AirPay 2 dashboard URLs.** Response URL and IPN URL must be exactly `https://firvanra.online/callback/cpm/arp_firvanra/collection`: `https`, apex (not `www`), **no trailing slash**. `…/collection/` falls into the SPA fallback and would be silently lost. `www.` and `http://` answer with a 308. 308 does preserve POST bodies, but AirPay's IPN client may not follow redirects. | **UNVERIFIED.** The dashboard is not accessible from here; the owner must check it manually. The verified production callback shows at least one channel is set correctly. |
| 2 | **Vercel project ↔ domain mapping.** Behavior proves the project serving `firvanra.online` uses `frontend/vercel.json`, and that `api.firvanra.online` serves Express. Which of `firnvia` / `firnvia-b6m7` is which was not confirmed (no Vercel CLI or dashboard access). | Behavior verified [live]; project names UNVERIFIED |
| 3 | **Deduplication is per-instance and in memory.** If the browser return and the IPN land on different Vercel instances, or after a cold start, KKChat can receive the same verified event twice. KKChat should treat `ap_transactionid` as idempotent. Fixing this needs durable storage, which is out of scope. | Known limitation (pre-existing) |
| 4 | **Function duration.** Worst case is about 28 s (OAuth + Verify + 2 relay attempts). `backend/vercel.json` sets no `maxDuration`. | UNVERIFIED; check the project's limit |
| 5 | **Proxy hop.** The edge-to-API leg adds a small amount of latency and depends on the API domain staying attached. Pointing AirPay at `api.firvanra.online` directly would remove the hop, but it would change the agreed public URL. **Not recommended**; listed only for completeness. | Informational |

**Vercel dashboard changes required: none.**
**AirPay dashboard changes required: none**, provided item 1 checks out.

Optional hardening, **not applied** because it is not a confirmed defect: add a rewrite for `/callback/cpm/arp_firvanra/collection/` (trailing slash) to `frontend/vercel.json` ahead of the SPA fallback. Apply it only if item 1 shows a trailing slash in the dashboard.

---

## 9. Rollback

Only tests and this document were added, so nothing in production depends on this branch.

- Before merge: `git branch -D audit/airpay2-callback-domain-routing`
- After merge: `git revert <merge-or-commit-sha>` (removes the 4 tests and this report; no runtime effect)

---

## 10. Requirement matrix

| Requirement | Status | Evidence |
|---|---|---|
| Root callback URL works | **PASS** | [live] root-domain `GET` reaches Express (405 `Allow: POST`). Production log shows a root-domain `POST` verified and forwarded. Rewrite precedes the SPA fallback [test]. |
| Success/Failed response works | **PASS** (automated) / **UNVERIFIED** (live) | [test] browser success → 303, failure → 303 with `returnStatus=failure`, proxied browser return → `FRONTEND_URL`. No live browser return was observed in the evidence supplied. |
| IPN webhook works | **PASS** | Production log: form-encoded, non-browser (`ambiguous`, i.e. IPN-shaped) callback verified, `paid`, forwarded `200`. [test] form and JSON IPN, direct and proxied. |
| AirPay verification preserved | **PASS** | Handler unchanged. [test] forged, tampered, wrong-merchant and mismatch cases are rejected; the proxied forged callback is rejected before Verify. |
| KKChat forwarding preserved | **PASS** | Forwarder unchanged. Production log `delivered`, `http_status: 200`. [test] constant destination, byte-identical body, not steered by `Host`/`X-Forwarded-Host`. |
| Other gateways unaffected | **PASS** | No runtime file changed. AirPay 1, SabPaisa and PayU suites pass (316/316 backend, 43/43 frontend). |
