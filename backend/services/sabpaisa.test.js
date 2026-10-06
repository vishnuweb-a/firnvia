// Service tests for the SabPaisa PG 3.0 REST adapter (Task 5A-Retry).
// Run: node --test services/sabpaisa.test.js
//
// Fake credentials only. No SabPaisa endpoint is ever contacted: axios and
// global fetch are both stubbed.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const FAKE = {
  SABPAISA_CLIENT_CODE:    "FAKECLIENT",
  SABPAISA_API_KEY:        "fake_api_key",
  SABPAISA_SECRET_KEY:     "fake_secret_key",
  SABPAISA_WEBHOOK_SECRET: "fake_webhook_secret",
  // Production PG 3.0 endpoints. Nothing is ever contacted — axios and fetch
  // are stubbed in every test that would make a request.
  SABPAISA_PAY_URL:        "https://merchant-api.sabpaisa.in/api/v2/payments",
  SABPAISA_ENQUIRY_URL:    "https://merchant-api.sabpaisa.in/api/v2/payments/enquiry",
  PUBLIC_BASE_URL:         "https://example.com",
};
Object.assign(process.env, FAKE);

// sabpaisa.js snapshots process.env at load, so import after assigning.
const sp = await import("./sabpaisa.js");
const axios = (await import("axios")).default;

const hmacHex = (raw) =>
  crypto.createHmac("sha256", FAKE.SABPAISA_SECRET_KEY).update(raw).digest("hex");

/**
 * PG 3.0 return-URL signature: HMAC-SHA256 hex over the sorted key=value|...
 * representation of every parameter except `signature`.
 */
const returnSignature = (params) =>
  hmacHex(
    Object.keys(params).filter((k) => k !== "signature").sort()
      .map((k) => `${k}=${params[k]}`).join("|"),
  );

/** A signed return-URL payload. `amount`/`paid_amount` are RUPEES, ts is ms. */
const signedReturn = (params) => ({ ...params, signature: returnSignature(params) });

const signWebhook = (timestamp, rawBody) =>
  `${timestamp}.` +
  crypto.createHmac("sha256", FAKE.SABPAISA_WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`).digest("base64");

// ── Configuration detection ──────────────────────────────────────────────────

test("configuration detection reports initiate, webhook and enquiry separately", () => {
  assert.equal(sp.sabpaisaConfigured(), true);
  assert.equal(sp.sabpaisaWebhookConfigured(), true);
  assert.equal(sp.sabpaisaEnquiryConfigured(), true);
  assert.equal(sp.enquiryProtocolStatus(), "configured");
});

// ── Amount handling ─────────────────────────────────────────────────────────

test("amount unit is paise and rupee totals convert exactly", () => {
  assert.equal(sp.SABPAISA_AMOUNT_UNIT, "paise");
  assert.equal(sp.toPaise(10), 1000);
  assert.equal(sp.toPaise(849), 84900);
  assert.equal(sp.toPaise(10.5), 1050);
});

test("toPaise rejects non-positive and unparseable amounts", () => {
  for (const bad of [0, -1, NaN, Infinity, "abc", null, undefined]) {
    assert.throws(() => sp.toPaise(bad), /amount invalid/);
  }
});

test("rupeesToPaise converts return-URL rupee amounts", () => {
  assert.equal(sp.rupeesToPaise("849.00"), 84900);
  assert.equal(sp.rupeesToPaise("1"), 100);
  assert.equal(sp.rupeesToPaise(500), 50000);
  assert.equal(sp.rupeesToPaise("0.50"), 50);
});

test("rupeesToPaise returns null rather than guessing", () => {
  for (const bad of [undefined, null, "", "  ", "abc", "-5", "0", "1e3", "12,00", {}]) {
    assert.equal(sp.rupeesToPaise(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test("enquiry status classification maps the PG 3.0 matrix", () => {
  assert.equal(sp.classifyEnquiryStatus("SUCCESS"), "paid");
  assert.equal(sp.classifyEnquiryStatus("success"), "paid");
  assert.equal(sp.classifyEnquiryStatus("FAILED"), "failed");
  assert.equal(sp.classifyEnquiryStatus("PENDING"), "pending");
  assert.equal(sp.classifyEnquiryStatus("PROCESSING"), "pending");
  // Terminal non-success states map to failed: this order model has no
  // dedicated expired/cancelled state, and the attempt is not retryable.
  assert.equal(sp.classifyEnquiryStatus("EXPIRED"), "failed");
  assert.equal(sp.classifyEnquiryStatus("CANCELLED"), "failed");
  // Unknown is never guessed.
  assert.equal(sp.classifyEnquiryStatus("WAT"), "unknown");
  assert.equal(sp.classifyEnquiryStatus(""), "unknown");
  assert.equal(sp.classifyEnquiryStatus(undefined), "unknown");
});

test("payment creation timestamp is Unix seconds, not milliseconds", () => {
  const ts = sp.unixSeconds();
  const nowMs = Date.now();
  assert.ok(Number.isInteger(ts));
  assert.ok(Math.abs(ts - Math.floor(nowMs / 1000)) <= 1);
  // Seconds are ~1e9-1e10; milliseconds are ~1e12. Guard against a regression.
  assert.ok(ts < nowMs / 100, "timestamp must be seconds, not milliseconds");
});

test("initiate derives the amount from order.total, never from a caller value", async (t) => {
  let sent = null;
  t.mock.method(axios, "post", async (_url, payload) => {
    sent = payload;
    return { data: { checkoutUrl: "https://pay.invalid/checkout/abc" } };
  });

  const order = { id: "FIR-aaa", total: 849, amount: 1 };
  // A frontend-supplied amount on the order object is not consulted.
  const result = await sp.initiatePayment(order, { firstName: "Asha", email: "a@b.c", phone: "9" });

  assert.equal(sent.amount, 84900);                 // 849 rupees -> paise
  assert.equal(sent.merchantTxnId, "FIR-aaa");
  assert.equal(sent.currency, "INR");
  assert.equal(result.amount, 84900);
  assert.equal(result.merchantTxnId, "FIR-aaa");
  assert.equal(result.checkoutUrl, "https://pay.invalid/checkout/abc");
});

test("initiate checksum is bound to the trusted amount", async (t) => {
  let sent = null;
  t.mock.method(axios, "post", async (_url, payload) => {
    sent = payload;
    return { data: { checkoutUrl: "https://pay.invalid/c" } };
  });

  await sp.initiatePayment({ id: "FIR-bbb", total: 10 }, { email: "a@b.c", phone: "9" });
  assert.equal(sent.amount, 1000);
  assert.equal(
    sent.checksum,
    hmacHex(`${FAKE.SABPAISA_CLIENT_CODE}|FIR-bbb|1000|INR|${sent.timestamp}`),
  );
});

test("initiate appends clientSecret to the redirect but never returns it as a field", async (t) => {
  t.mock.method(axios, "post", async () => ({
    data: { checkoutUrl: "https://pay.invalid/c", clientSecret: "cs_live_123" },
  }));
  const r = await sp.initiatePayment({ id: "FIR-ccc", total: 10 }, { email: "a@b.c", phone: "9" });
  assert.match(r.checkoutUrl, /clientSecret=cs_live_123/);
  assert.equal(r.clientSecret, undefined);
});

test("initiate rejects an order whose total is invalid", async (t) => {
  t.mock.method(axios, "post", async () => ({ data: { checkoutUrl: "x" } }));
  await assert.rejects(
    () => sp.initiatePayment({ id: "FIR-ddd", total: 0 }, {}),
    /amount invalid/,
  );
});

test("initiate throws when SabPaisa returns no checkoutUrl", async (t) => {
  t.mock.method(axios, "post", async () => ({ data: { status: "ok" } }));
  await assert.rejects(
    () => sp.initiatePayment({ id: "FIR-eee", total: 10 }, {}),
    /did not return a checkoutUrl/,
  );
});

test("initiate error message never leaks the provider response body", async (t) => {
  t.mock.method(axios, "post", async () => {
    const err = new Error("boom");
    err.response = { status: 401, data: { apiKey: "fake_api_key", secret: "fake_secret_key" } };
    throw err;
  });
  await assert.rejects(
    () => sp.initiatePayment({ id: "FIR-fff", total: 10 }, {}),
    (err) => {
      assert.match(err.message, /SabPaisa request failed \(401\)/);
      assert.doesNotMatch(err.message, /fake_api_key|fake_secret_key/);
      return true;
    },
  );
});

test("initiate posts to the production payment endpoint with X-Api-Key", async (t) => {
  let seen = null;
  t.mock.method(axios, "post", async (url, payload, opts) => {
    seen = { url, payload, opts };
    return { data: { checkoutUrl: "https://checkout.sabpaisa.in/s/1" } };
  });
  await sp.initiatePayment({ id: "FIR-prod", total: 849 }, {});

  assert.equal(seen.url, "https://merchant-api.sabpaisa.in/api/v2/payments");
  assert.equal(seen.opts.headers["X-Api-Key"], FAKE.SABPAISA_API_KEY);
  assert.equal(seen.opts.headers["Content-Type"], "application/json");
});

test("initiate sends integer paise, INR, and a seconds timestamp", async (t) => {
  let payload = null;
  t.mock.method(axios, "post", async (_url, body) => {
    payload = body;
    return { data: { checkoutUrl: "https://checkout.sabpaisa.in/s/1" } };
  });
  await sp.initiatePayment({ id: "FIR-units", total: 849 }, {});

  assert.equal(payload.amount, 84900);
  assert.ok(Number.isInteger(payload.amount));
  assert.equal(payload.currency, "INR");
  assert.equal(payload.merchantId, FAKE.SABPAISA_CLIENT_CODE);
  assert.equal(payload.merchantTxnId, "FIR-units");
  // Unix SECONDS, not milliseconds.
  assert.ok(Math.abs(payload.timestamp - Math.floor(Date.now() / 1000)) <= 2);
  assert.ok(payload.timestamp < Date.now() / 100);
});

test("initiate checksum is HMAC-SHA256 hex over merchantId|txnId|amount|INR|timestamp", async (t) => {
  let payload = null;
  t.mock.method(axios, "post", async (_url, body) => {
    payload = body;
    return { data: { checkoutUrl: "https://checkout.sabpaisa.in/s/1" } };
  });
  await sp.initiatePayment({ id: "FIR-sum", total: 849 }, {});

  const expected = hmacHex(
    `${FAKE.SABPAISA_CLIENT_CODE}|FIR-sum|84900|INR|${payload.timestamp}`,
  );
  assert.equal(payload.checksum, expected);
  assert.match(payload.checksum, /^[0-9a-f]{64}$/);
});

test("initiate never sends the secret key or webhook secret in the payload", async (t) => {
  let payload = null;
  t.mock.method(axios, "post", async (_url, body) => {
    payload = body;
    return { data: { checkoutUrl: "https://checkout.sabpaisa.in/s/1" } };
  });
  await sp.initiatePayment({ id: "FIR-nosecret", total: 849 }, {});
  assert.doesNotMatch(JSON.stringify(payload), /fake_secret_key|fake_webhook_secret|fake_api_key/);
});

test("initiate surfaces session metadata for storage", async (t) => {
  t.mock.method(axios, "post", async () => ({
    data: {
      checkoutUrl: "https://checkout.sabpaisa.in/s/1",
      sessionId: "sess-77", txnId: "SP-77", expiresAt: "2026-10-06T11:00:00.000Z",
    },
  }));
  const r = await sp.initiatePayment({ id: "FIR-meta", total: 849 }, {});
  assert.equal(r.paymentId, "sess-77");
  assert.equal(r.gatewayTxnId, "SP-77");
  assert.equal(r.expiresAt, "2026-10-06T11:00:00.000Z");
  assert.equal(r.merchantTxnId, "FIR-meta");
  assert.equal(r.amount, 84900);
});

// ── Return URL (callback) verification ──────────────────────────────────────

test("return signature base string is sorted key=value, signature excluded", () => {
  const base = sp.buildReturnSignatureBase({
    status: "SUCCESS", amount: "849.00", merchant_txn_id: "FIR-a", signature: "ignored",
  });
  assert.equal(base, "amount=849.00|merchant_txn_id=FIR-a|status=SUCCESS");
  assert.doesNotMatch(base, /signature/);
});

test("a valid PG 3.0 return signature verifies", () => {
  const r = sp.verifyCallback(signedReturn({
    merchant_txn_id: "FIR-ggg", transaction_id: "SP1", status: "SUCCESS",
    amount: "849.00", paid_amount: "849.00", payment_mode: "UPI",
    timestamp: String(Date.now()),   // return URL timestamp is MILLISECONDS
  }));
  assert.equal(r.ok, true);
  assert.equal(r.paid, true);
  assert.equal(r.orderid, "FIR-ggg");
  assert.equal(r.txnId, "SP1");
  // Return amounts are rupees; 849.00 rupees => 84900 paise.
  assert.equal(r.amountPaise, 84900);
});

test("the return signature is keyed with the SECRET KEY, not the webhook secret", () => {
  const params = { merchant_txn_id: "FIR-sk", status: "SUCCESS", amount: "849.00" };
  const base = sp.buildReturnSignatureBase(params);
  const wrongKey = crypto.createHmac("sha256", FAKE.SABPAISA_WEBHOOK_SECRET)
    .update(base).digest("hex");
  assert.equal(sp.verifyCallback({ ...params, signature: wrongKey }).ok, false);
  assert.equal(sp.verifyCallback({ ...params, signature: hmacHex(base) }).ok, true);
});

test("the return signature is lowercase hex of the expected length", () => {
  const sig = returnSignature({ merchant_txn_id: "FIR-hex", status: "SUCCESS" });
  assert.equal(sig.length, 64);
  assert.match(sig, /^[0-9a-f]{64}$/);
});

test("return fails closed when the signature is missing", () => {
  const r = sp.verifyCallback({
    merchant_txn_id: "FIR-hhh", status: "SUCCESS", amount: "849.00",
  });
  assert.equal(r.ok, false);
  assert.equal(r.paid, false);
  assert.equal(r.reason, "missing signature");
});

test("return fails closed when the signature is wrong", () => {
  const r = sp.verifyCallback({
    merchant_txn_id: "FIR-iii", status: "SUCCESS", amount: "849.00", signature: "deadbeef",
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "signature mismatch");
});

test("tampering with ANY return field invalidates the signature", () => {
  const original = signedReturn({
    merchant_txn_id: "FIR-jjj", transaction_id: "SP2", status: "SUCCESS",
    amount: "849.00", paid_amount: "849.00", timestamp: String(Date.now()),
  });
  assert.equal(sp.verifyCallback(original).ok, true);

  // Each of these keeps the original signature but changes a signed field.
  for (const tampered of [
    { ...original, paid_amount: "1.00" },
    { ...original, amount: "1.00" },
    { ...original, status: "FAILED" },
    { ...original, merchant_txn_id: "FIR-OTHER" },
    { ...original, transaction_id: "SP-EVIL" },
  ]) {
    const r = sp.verifyCallback(tampered);
    assert.equal(r.ok, false, `tampering with this payload should fail: ${JSON.stringify(tampered)}`);
    assert.equal(r.reason, "signature mismatch");
  }
});

test("an ADDED return parameter also invalidates the signature", () => {
  const original = signedReturn({ merchant_txn_id: "FIR-add", status: "SUCCESS", amount: "849.00" });
  assert.equal(sp.verifyCallback({ ...original, injected: "1" }).ok, false);
});

test("return fails closed with no merchant txn id", () => {
  assert.equal(
    sp.verifyCallback({ status: "SUCCESS", signature: "x" }).reason,
    "missing merchant txn id",
  );
});

test("return with an empty body fails closed", () => {
  const r = sp.verifyCallback();
  assert.equal(r.ok, false);
  assert.equal(r.paid, false);
});

test("a status of SUCCESS alone never produces ok:true", () => {
  const r = sp.verifyCallback({ merchant_txn_id: "FIR-lll", status: "SUCCESS" });
  assert.equal(r.ok, false);
});

test("a verified non-success return is ok but not paid", () => {
  const r = sp.verifyCallback(signedReturn({
    merchant_txn_id: "FIR-fail", status: "FAILED", amount: "849.00",
  }));
  assert.equal(r.ok, true);
  assert.equal(r.paid, false);
});

// ── Webhook signature verification ──────────────────────────────────────────

test("valid webhook signature verifies over exact raw bytes", () => {
  const raw = JSON.stringify({ event: "payment.success" });
  const ts = Date.now();
  assert.deepEqual(sp.verifyWebhookSignature(signWebhook(ts, raw), Buffer.from(raw)), { ok: true });
});

test("webhook fails closed on a missing header, body or malformed header", () => {
  const raw = Buffer.from("{}");
  assert.equal(sp.verifyWebhookSignature("", raw).ok, false);
  assert.equal(sp.verifyWebhookSignature(`${Date.now()}.sig`, Buffer.alloc(0)).ok, false);
  assert.equal(sp.verifyWebhookSignature("nodothere", raw).reason, "malformed signature header");
  assert.equal(sp.verifyWebhookSignature("notanumber.sig", raw).reason, "malformed signature header");
  assert.equal(sp.verifyWebhookSignature(`${Date.now()}.`, raw).reason, "malformed signature header");
});

test("webhook fails closed on a wrong signature", () => {
  const raw = Buffer.from(JSON.stringify({ event: "payment.success" }));
  assert.equal(sp.verifyWebhookSignature(`${Date.now()}.AAAA`, raw).ok, false);
});

test("webhook fails closed on an expired timestamp (replay)", () => {
  const raw = JSON.stringify({ event: "payment.success" });
  const old = Date.now() - 6 * 60 * 1000;
  const r = sp.verifyWebhookSignature(signWebhook(old, raw), Buffer.from(raw));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "timestamp outside accepted window");
});

test("webhook signature over a re-serialized body does not verify", () => {
  // Byte-for-byte matters: whitespace differences must break the signature.
  const raw = '{"event":"payment.success", "a":1}';
  const ts = Date.now();
  const sig = signWebhook(ts, raw);
  const reserialized = JSON.stringify(JSON.parse(raw));
  assert.equal(sp.verifyWebhookSignature(sig, Buffer.from(reserialized)).ok, false);
});

// ── Transaction Enquiry (PG 3.0) ────────────────────────────────────────────

const stubFetch = (t, impl) => t.mock.method(globalThis, "fetch", impl);
const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body),
});

/** A representative successful PG 3.0 enquiry body. */
const enquiryBody = (over = {}) => ({
  success: true,
  traceId: "trace-1",
  txnId: "SP-9",
  merchantId: FAKE.SABPAISA_CLIENT_CODE,
  merchantTxnId: "FIR-mmm",
  amountPaise: 84900,
  currency: "INR",
  status: "SUCCESS",
  paymentMode: "UPI",
  sessionId: "sess-1",
  requestAmount: "849.00",
  paidAmount: "849.00",
  bankTxnId: "BANK-1",
  bankRrn: "RRN-1",
  completedAt: "2026-10-06T10:00:00.000Z",
  ...over,
});

test("enquiry posts to the production endpoint with X-Api-Key and JSON", async (t) => {
  let seen = null;
  stubFetch(t, async (url, opts) => {
    seen = { url, opts };
    return jsonRes(enquiryBody());
  });
  await sp.enquireTransaction("FIR-mmm");

  assert.equal(seen.url, "https://merchant-api.sabpaisa.in/api/v2/payments/enquiry");
  assert.equal(seen.opts.method, "POST");
  assert.equal(seen.opts.headers["X-Api-Key"], FAKE.SABPAISA_API_KEY);
  assert.equal(seen.opts.headers["Content-Type"], "application/json");
});

test("enquiry body carries clientCode and merchantTxnId and no secrets", async (t) => {
  let body = null;
  stubFetch(t, async (_url, opts) => {
    body = JSON.parse(opts.body);
    return jsonRes(enquiryBody());
  });
  await sp.enquireTransaction("FIR-mmm");

  assert.equal(body.clientCode, FAKE.SABPAISA_CLIENT_CODE);
  assert.equal(body.merchantTxnId, "FIR-mmm");
  // The secret key and webhook secret must never travel as request fields.
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /fake_secret_key|fake_webhook_secret/);
  assert.equal(body.secretKey, undefined);
  assert.equal(body.checksum, undefined);
});

test("enquiry success normalizes to canonical paise and omits PII", async (t) => {
  stubFetch(t, async () => jsonRes(enquiryBody({
    customerEmail: "asha@example.com", customerMobile: "9876543210",
  })));
  const r = await sp.enquireTransaction("FIR-mmm");

  assert.equal(r.ok, true);
  assert.equal(r.found, true);
  assert.equal(r.merchantTxnId, "FIR-mmm");
  assert.equal(r.txnId, "SP-9");
  assert.equal(r.paymentId, "sess-1");
  assert.equal(r.status, "SUCCESS");
  assert.equal(r.outcome, "paid");
  assert.equal(r.amountPaise, 84900);     // canonical, from amountPaise
  assert.equal(r.currency, "INR");
  assert.equal(r.paymentMode, "UPI");
  assert.equal(r.bankTxnId, "BANK-1");
  assert.equal(r.bankRrn, "RRN-1");
  assert.equal(r.completedAt, "2026-10-06T10:00:00.000Z");

  // No PII, no raw body, no credentials leave the adapter.
  const serialized = JSON.stringify(r);
  assert.doesNotMatch(serialized, /asha@example\.com|9876543210/);
  assert.doesNotMatch(serialized, /fake_api_key|fake_secret_key|fake_webhook_secret/);
  assert.equal(r.requestAmount, undefined);
  assert.equal(r.paidAmount, undefined);
});

test("enquiry reads a `data`-wrapped response identically", async (t) => {
  stubFetch(t, async () => jsonRes({ success: true, data: enquiryBody() }));
  const r = await sp.enquireTransaction("FIR-mmm");
  assert.equal(r.found, true);
  assert.equal(r.amountPaise, 84900);
  assert.equal(r.outcome, "paid");
});

test("enquiry never derives amountPaise from rupee fields", async (t) => {
  // amountPaise absent: requestAmount/paidAmount must NOT be used as a fallback,
  // so the amount is null and no caller can authorize on it.
  stubFetch(t, async () => {
    const b = enquiryBody();
    delete b.amountPaise;
    return jsonRes(b);
  });
  const r = await sp.enquireTransaction("FIR-mmm");
  assert.equal(r.found, true);
  assert.equal(r.amountPaise, null);
});

test("enquiry failed transaction classifies as failed", async (t) => {
  stubFetch(t, async () => jsonRes(enquiryBody({ merchantTxnId: "FIR-nnn", status: "FAILED" })));
  const r = await sp.enquireTransaction("FIR-nnn");
  assert.equal(r.found, true);
  assert.equal(r.outcome, "failed");
  assert.equal(r.status, "FAILED");
});

test("enquiry pending and processing classify as pending", async (t) => {
  for (const status of ["PENDING", "PROCESSING"]) {
    stubFetch(t, async () => jsonRes(enquiryBody({ status })));
    assert.equal((await sp.enquireTransaction("FIR-ooo")).outcome, "pending");
  }
});

test("enquiry not found returns found:false and never fabricates success", async (t) => {
  stubFetch(t, async () => jsonRes({ message: "no such txn" }, 404));
  assert.deepEqual(await sp.enquireTransaction("FIR-ppp"), { ok: true, found: false });

  stubFetch(t, async () => jsonRes({ data: {} }));
  assert.deepEqual(await sp.enquireTransaction("FIR-ppp"), { ok: true, found: false });

  stubFetch(t, async () => jsonRes({ success: false, message: "not found" }));
  assert.deepEqual(await sp.enquireTransaction("FIR-ppp"), { ok: true, found: false });
});

test("enquiry network error returns ok:false", async (t) => {
  stubFetch(t, async () => { throw new Error("ECONNRESET"); });
  assert.deepEqual(await sp.enquireTransaction("FIR-qqq"), { ok: false, reason: "network_error" });
});

test("enquiry timeout returns ok:false", async (t) => {
  stubFetch(t, async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  });
  assert.deepEqual(await sp.enquireTransaction("FIR-rrr"), { ok: false, reason: "timeout" });
});

test("enquiry 5xx and invalid JSON return ok:false", async (t) => {
  stubFetch(t, async () => jsonRes({}, 500));
  assert.deepEqual(await sp.enquireTransaction("FIR-sss"), { ok: false, reason: "http_error" });

  stubFetch(t, async () => jsonRes({}, 502));
  assert.deepEqual(await sp.enquireTransaction("FIR-sss"), { ok: false, reason: "http_error" });

  stubFetch(t, async () => ({ ok: true, status: 200, text: async () => "not json" }));
  assert.deepEqual(await sp.enquireTransaction("FIR-sss"), { ok: false, reason: "invalid_response" });
});

test("enquiry never throws a provider body into the caller's error path", async (t) => {
  stubFetch(t, async () => ({
    ok: false, status: 500,
    text: async () => JSON.stringify({ echo: "fake_api_key" }),
  }));
  const r = await sp.enquireTransaction("FIR-leak");
  assert.doesNotMatch(JSON.stringify(r), /fake_api_key/);
});

test("enquiry reports a transaction-id mismatch to the caller, not silently", async (t) => {
  stubFetch(t, async () => jsonRes(enquiryBody({ merchantTxnId: "FIR-OTHER" })));
  const r = await sp.enquireTransaction("FIR-ttt");
  // The adapter reports what SabPaisa said; the route layer compares identities.
  assert.equal(r.merchantTxnId, "FIR-OTHER");
  assert.notEqual(r.merchantTxnId, "FIR-ttt");
});

test("enquiry queries by the reference it is given and rejects a blank one", async (t) => {
  let body = null;
  stubFetch(t, async (_url, opts) => {
    body = JSON.parse(opts.body);
    return jsonRes(enquiryBody({ merchantTxnId: "FIR-vvv" }));
  });
  await sp.enquireTransaction("FIR-vvv");
  assert.equal(body.merchantTxnId, "FIR-vvv");

  assert.deepEqual(await sp.enquireTransaction(""), { ok: false, reason: "txn_id_missing" });
  assert.deepEqual(await sp.enquireTransaction(null), { ok: false, reason: "txn_id_missing" });
  assert.deepEqual(await sp.enquireTransaction(undefined), { ok: false, reason: "txn_id_missing" });
});
