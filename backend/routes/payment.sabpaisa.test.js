// Route tests for the SabPaisa initiate / callback / webhook / simulate endpoints.
// Run: node --test routes/payment.sabpaisa.test.js
//
// Fake credentials only. A throwaway Express app is started on an ephemeral
// localhost port and closed after the run. No SabPaisa endpoint is ever
// contacted: axios (initiate) and global fetch (enquiry, kkchat) are stubbed.

import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";

const FAKE = {
  SABPAISA_CLIENT_CODE:    "FAKECLIENT",
  SABPAISA_API_KEY:        "fake_api_key",
  SABPAISA_SECRET_KEY:     "fake_secret_key",
  SABPAISA_WEBHOOK_SECRET: "fake_webhook_secret",
  // Production PG 3.0 endpoints. Nothing is contacted: axios (initiate) and
  // global fetch (enquiry, kkchat) are stubbed throughout.
  SABPAISA_PAY_URL:        "https://merchant-api.sabpaisa.in/api/v2/payments",
  SABPAISA_ENQUIRY_URL:    "https://merchant-api.sabpaisa.in/api/v2/payments/enquiry",
  PUBLIC_BASE_URL:         "https://example.com",
  FRONTEND_URL:            "https://frontend.example.com",
  // PayU must stay configured so its routes still mount unchanged.
  PAYU_ENV: "production",
  PAYU_KEY: "fake_merchant_key",
  PAYU_SALT: "fake_merchant_salt",
  PAYU_PAYMENT_URL: "https://secure.payu.in/_payment",
  PAYU_VERIFY_URL: "https://info.payu.in/merchant/postservice.php?form=2",
  NODE_ENV: "test",
};
Object.assign(process.env, FAKE);

// payment.js and the services snapshot process.env at load, so import after.
const { orders } = await import("./orders.js");
const router = (await import("./payment.js")).default;
const axios = (await import("axios")).default;

let server, base;

before(async () => {
  const app = express();
  // Mirrors server.js: the raw body is captured for signature verification.
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use(express.urlencoded({ extended: true }));
  app.use("/api/payment", router);
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => { await new Promise((resolve) => server.close(resolve)); });

let seq = 0;
function seedOrder(overrides = {}) {
  const order = {
    id: `FIR-sp${++seq}`,
    items: [{ id: "p1", title: "Thing", price: 849, qty: 1 }],
    total: 849,
    buyer: { firstName: "Asha", lastName: "Rao", email: "asha@example.com", phone: "9876543210" },
    status: "pending",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  orders.set(order.id, order);
  return order;
}

/** An order that has already been through /initiate. */
function seedAttemptedOrder(overrides = {}) {
  return seedOrder({
    gateway: "sabpaisa",
    sabpaisaMerchantTxnId: undefined, // set below so it tracks the generated id
    ...overrides,
  });
}
function attempt(order) {
  order.gateway = "sabpaisa";
  order.sabpaisaMerchantTxnId = order.id;
  order.sabpaisaAmountPaise = Math.round(order.total * 100);
  return order;
}

const hmacHex = (raw) =>
  crypto.createHmac("sha256", FAKE.SABPAISA_SECRET_KEY).update(raw).digest("hex");
/** PG 3.0 return signature: HMAC-SHA256 hex over sorted key=value|... */
const returnSignature = (params) =>
  hmacHex(
    Object.keys(params).filter((k) => k !== "signature").sort()
      .map((k) => `${k}=${params[k]}`).join("|"),
  );

/**
 * A signed PG 3.0 return-URL payload. `amount`/`paid_amount` are RUPEES and the
 * return timestamp is in MILLISECONDS, per the return-URL spec.
 */
function signedCallback(orderId, { rupees = "849.00", status = "SUCCESS", txn = "SP-1" } = {}) {
  const params = {
    merchant_txn_id: orderId, transaction_id: txn, status,
    amount: rupees, paid_amount: rupees, payment_mode: "UPI",
    timestamp: String(Date.now()),
  };
  return { ...params, signature: returnSignature(params) };
}

/** A representative PG 3.0 enquiry response body. */
const enquiryBody = (merchantTxnId, over = {}) => ({
  success: true, traceId: "trace-1", txnId: "SP-1",
  merchantId: FAKE.SABPAISA_CLIENT_CODE, merchantTxnId,
  amountPaise: 84900, currency: "INR", status: "SUCCESS", paymentMode: "UPI",
  sessionId: "sess-1", requestAmount: "849.00", paidAmount: "849.00",
  bankTxnId: "BANK-1", bankRrn: "RRN-1",
  completedAt: "2026-10-06T10:00:00.000Z",
  ...over,
});

/** Build a webhook POST with a valid X-SabPaisa-Signature over the exact bytes. */
function signedWebhookRequest(body) {
  const raw = JSON.stringify(body);
  const ts = Date.now();
  const sig = `${ts}.` + crypto.createHmac("sha256", FAKE.SABPAISA_WEBHOOK_SECRET)
    .update(`${ts}.${raw}`).digest("base64");
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-SabPaisa-Signature": sig },
    body: raw,
  };
}

const postWebhook = (body) =>
  fetch(`${base}/api/payment/sabpaisa/webhook`, signedWebhookRequest(body));

const postCallback = (data) =>
  fetch(`${base}/api/payment/sabpaisa/callback`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

// Stubs for outbound calls. `realFetch` is kept so the test client still works.
const realFetch = globalThis.fetch;
let enquiryImpl = null;
let kkchatCalls = [];

beforeEach(() => { enquiryImpl = null; kkchatCalls = []; });

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("kkchat.in")) {
    kkchatCalls.push(JSON.parse(opts.body));
    return { ok: true, status: 200, text: async () => "{}" };
  }
  if (u.includes("/api/v2/payments/enquiry")) {
    if (!enquiryImpl) throw new Error("enquiry not stubbed in this test");
    return enquiryImpl(JSON.parse(opts.body));
  }
  return realFetch(url, opts);
};

const enquiryJson = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body),
});

// ── initiate ────────────────────────────────────────────────────────────────

test("initiate returns the documented redirect contract and no secrets", async (t) => {
  t.mock.method(axios, "post", async () => ({
    data: { checkoutUrl: "https://pay.invalid/c/1", clientSecret: "cs_1" },
  }));
  const order = seedOrder();
  const res = await fetch(`${base}/api/payment/sabpaisa/initiate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId: order.id }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();

  assert.deepEqual(Object.keys(json).sort(), ["checkoutUrl", "provider", "type"]);
  assert.equal(json.provider, "sabpaisa");
  assert.equal(json.type, "redirect");
  assert.match(json.checkoutUrl, /^https:\/\/pay\.invalid\/c\/1\?clientSecret=/);

  // No credential, checksum or API key is ever returned to the frontend.
  const body = JSON.stringify(json);
  for (const secret of [FAKE.SABPAISA_API_KEY, FAKE.SABPAISA_SECRET_KEY,
                        FAKE.SABPAISA_WEBHOOK_SECRET, FAKE.SABPAISA_CLIENT_CODE]) {
    assert.doesNotMatch(body, new RegExp(secret), `leaked ${secret}`);
  }
});

test("initiate uses the trusted order amount", async (t) => {
  let sent = null;
  t.mock.method(axios, "post", async (_u, payload) => {
    sent = payload;
    return { data: { checkoutUrl: "https://pay.invalid/c" } };
  });
  const order = seedOrder({ total: 849 });
  await fetch(`${base}/api/payment/sabpaisa/initiate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId: order.id }),
  });
  assert.equal(sent.amount, 84900);
  assert.equal(orders.get(order.id).sabpaisaAmountPaise, 84900);
});

test("a frontend-supplied amount cannot override the trusted amount", async (t) => {
  let sent = null;
  t.mock.method(axios, "post", async (_u, payload) => {
    sent = payload;
    return { data: { checkoutUrl: "https://pay.invalid/c" } };
  });
  const order = seedOrder({ total: 849 });
  await fetch(`${base}/api/payment/sabpaisa/initiate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId: order.id, amount: 1, total: 1, paid_amount: 1 }),
  });
  assert.equal(sent.amount, 84900, "frontend amount must be ignored");
});

test("initiate posts to the PRODUCTION PG 3.0 payment endpoint", async (t) => {
  let seenUrl = null;
  t.mock.method(axios, "post", async (url) => {
    seenUrl = url;
    return { data: { checkoutUrl: "https://pay.invalid/c" } };
  });
  const order = seedOrder();
  await fetch(`${base}/api/payment/sabpaisa/initiate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId: order.id }),
  });
  assert.equal(seenUrl, "https://merchant-api.sabpaisa.in/api/v2/payments");
  // Never the older securepay AES form integration.
  assert.doesNotMatch(seenUrl, /securepay/);
});

test("initiate stores session metadata and leaves the order pending", async (t) => {
  t.mock.method(axios, "post", async () => ({
    data: {
      checkoutUrl: "https://pay.invalid/c", clientSecret: "cs_9",
      sessionId: "sess-9", expiresAt: "2026-10-06T11:00:00.000Z",
    },
  }));
  const order = seedOrder();
  await fetch(`${base}/api/payment/sabpaisa/initiate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId: order.id }),
  });

  const after = orders.get(order.id);
  assert.equal(after.gateway, "sabpaisa");
  assert.equal(after.sabpaisaMerchantTxnId, order.id);
  assert.equal(after.sabpaisaPaymentId, "sess-9");
  assert.equal(after.sabpaisaSessionExpiresAt, "2026-10-06T11:00:00.000Z");
  assert.equal(after.status, "pending");
  assert.ok(after.sabpaisaAttemptedAt);
  assert.ok(after.updatedAt);
  assert.equal(after.paidAt, undefined);

  // The clientSecret, checksum and credentials are never persisted on the order.
  const stored = JSON.stringify(after);
  assert.doesNotMatch(stored, /cs_9/);
  assert.equal(after.checksum, undefined);
  for (const secret of [FAKE.SABPAISA_API_KEY, FAKE.SABPAISA_SECRET_KEY,
                        FAKE.SABPAISA_WEBHOOK_SECRET]) {
    assert.doesNotMatch(stored, new RegExp(secret));
  }
});

test("initiate requires an orderId and rejects an unknown or paid order", async (t) => {
  t.mock.method(axios, "post", async () => ({ data: { checkoutUrl: "x" } }));
  const post = (b) => fetch(`${base}/api/payment/sabpaisa/initiate`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b),
  });
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ orderId: "FIR-nope" })).status, 404);
  const paid = seedOrder({ status: "paid" });
  assert.equal((await post({ orderId: paid.id })).status, 409);
});

test("initiate never returns a simulated success", async () => {
  // Proven structurally: the handler has no `simulated` branch left. With
  // credentials present the response shape is exactly the redirect contract.
  const src = await (await import("node:fs/promises")).readFile(
    new URL("./payment.js", import.meta.url), "utf8");
  const sabpaisaInitiate = src.slice(
    src.indexOf('router.post("/sabpaisa/initiate"'),
    src.indexOf("function sabpaisaOrderMismatch"));
  assert.doesNotMatch(sabpaisaInitiate, /simulated:\s*true/);
  assert.match(sabpaisaInitiate, /503/);
});

// ── Browser return (callback) ───────────────────────────────────────────────
//
// The return is UX only. Every settlement below comes from the enquiry, which
// can and does contradict the return.

test("a verified return reconciles via enquiry and only then marks paid", async () => {
  const order = attempt(seedOrder());
  let enquiryCalls = 0;
  enquiryImpl = (body) => {
    enquiryCalls++;
    assert.equal(body.clientCode, FAKE.SABPAISA_CLIENT_CODE);
    assert.equal(body.merchantTxnId, order.sabpaisaMerchantTxnId);
    return enquiryJson(enquiryBody(order.id));
  };

  const res = await postCallback(signedCallback(order.id));
  assert.equal(res.status, 302);
  assert.equal(enquiryCalls, 1, "a verified return must reconcile via enquiry");

  const loc = res.headers.get("location");
  assert.match(loc, /status=pending/);          // the order page always re-asks
  assert.match(loc, /returnStatus=success/);

  const after = orders.get(order.id);
  assert.equal(after.status, "paid");
  assert.equal(after.sabpaisaReturnVerified, true);
  assert.ok(after.paidAt);
});

test("a verified return alone cannot mark paid when enquiry is inconclusive", async () => {
  const order = attempt(seedOrder());
  // Return says SUCCESS; the enquiry cannot be reached.
  enquiryImpl = () => { throw new Error("ECONNRESET"); };

  const res = await postCallback(signedCallback(order.id));
  const loc = res.headers.get("location");
  assert.match(loc, /status=pending/);
  // No internal provider error is exposed, and no returnStatus is asserted.
  assert.doesNotMatch(loc, /returnStatus/);
  assert.doesNotMatch(loc, /ECONNRESET/);

  const after = orders.get(order.id);
  assert.equal(after.status, "pending", "state must be left unchanged");
  assert.equal(after.paidAt, undefined);
  assert.equal(after.sabpaisaReturnVerified, true);
});

test("return SUCCESS + enquiry PENDING leaves the order pending", async () => {
  const order = attempt(seedOrder());
  enquiryImpl = () => enquiryJson(enquiryBody(order.id, { status: "PENDING" }));
  const res = await postCallback(signedCallback(order.id));
  assert.doesNotMatch(res.headers.get("location"), /returnStatus/);
  const after = orders.get(order.id);
  assert.equal(after.status, "pending");
  assert.equal(after.paidAt, undefined);
});

test("return SUCCESS + enquiry FAILED marks the order failed — the enquiry wins", async () => {
  const order = attempt(seedOrder());
  enquiryImpl = () => enquiryJson(enquiryBody(order.id, { status: "FAILED" }));
  const res = await postCallback(signedCallback(order.id));
  assert.match(res.headers.get("location"), /returnStatus=failure/);
  const after = orders.get(order.id);
  assert.equal(after.status, "failed");
  assert.equal(after.paidAt, undefined);
});

test("return FAILED + enquiry SUCCESS settles as paid — the enquiry wins", async () => {
  const order = attempt(seedOrder());
  enquiryImpl = () => enquiryJson(enquiryBody(order.id));
  await postCallback(signedCallback(order.id, { status: "FAILED" }));
  assert.equal(orders.get(order.id).status, "paid");
});

test("an enquiry amount that differs from order.total cannot mark paid", async () => {
  const order = attempt(seedOrder({ total: 849 }));
  enquiryImpl = () => enquiryJson(enquiryBody(order.id, { amountPaise: 100 }));
  const res = await postCallback(signedCallback(order.id));
  assert.match(res.headers.get("location"), /returnStatus=failure/);
  const after = orders.get(order.id);
  assert.notEqual(after.status, "paid");
  assert.equal(after.paidAt, undefined);
});

test("an enquiry for a different merchantTxnId cannot mark paid", async () => {
  const order = attempt(seedOrder());
  enquiryImpl = () => enquiryJson(enquiryBody("FIR-SOMEONE-ELSE"));
  const res = await postCallback(signedCallback(order.id));
  assert.match(res.headers.get("location"), /returnStatus=failure/);
  assert.notEqual(orders.get(order.id).status, "paid");
});

test("an enquiry currency other than INR cannot mark paid", async () => {
  const order = attempt(seedOrder());
  enquiryImpl = () => enquiryJson(enquiryBody(order.id, { currency: "USD" }));
  await postCallback(signedCallback(order.id));
  assert.notEqual(orders.get(order.id).status, "paid");
});

test("an enquiry 404 never fabricates success", async () => {
  const order = attempt(seedOrder());
  enquiryImpl = () => enquiryJson({ message: "unknown" }, 404);
  const res = await postCallback(signedCallback(order.id));
  assert.doesNotMatch(res.headers.get("location"), /returnStatus=success/);
  const after = orders.get(order.id);
  assert.equal(after.status, "pending");
  assert.equal(after.paidAt, undefined);
});

test("a return with no signature fails closed and never reaches the enquiry", async () => {
  const order = attempt(seedOrder());
  enquiryImpl = () => { throw new Error("enquiry must not be called"); };
  const res = await postCallback({ merchant_txn_id: order.id, status: "SUCCESS" });
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location"), /returnStatus=failure/);
  const after = orders.get(order.id);
  assert.notEqual(after.status, "paid");
  assert.notEqual(after.sabpaisaReturnVerified, true);
});

test("a return with an invalid signature fails closed", async () => {
  const order = attempt(seedOrder());
  enquiryImpl = () => { throw new Error("enquiry must not be called"); };
  const data = signedCallback(order.id);
  data.signature = "deadbeef";
  const res = await postCallback(data);
  assert.match(res.headers.get("location"), /returnStatus=failure/);
  assert.notEqual(orders.get(order.id).status, "paid");
});

test("a tampered return amount invalidates the signature", async () => {
  const order = attempt(seedOrder({ total: 849 }));
  enquiryImpl = () => { throw new Error("enquiry must not be called"); };
  const data = signedCallback(order.id);
  data.paid_amount = "1.00";   // signature no longer covers this value
  const res = await postCallback(data);
  assert.match(res.headers.get("location"), /returnStatus=failure/);
  assert.notEqual(orders.get(order.id).status, "paid");
});

test("a return for an unknown order cannot mark anything paid", async () => {
  enquiryImpl = () => { throw new Error("enquiry must not be called"); };
  const res = await postCallback(signedCallback("FIR-does-not-exist"));
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location"), /returnStatus=failure/);
});

test("a return whose reference does not match the stored attempt fails closed", async () => {
  const order = attempt(seedOrder());
  order.sabpaisaMerchantTxnId = "FIR-some-other-attempt";
  enquiryImpl = () => { throw new Error("enquiry must not be called"); };
  const res = await postCallback(signedCallback(order.id));
  assert.match(res.headers.get("location"), /returnStatus=failure/);
  assert.notEqual(orders.get(order.id).status, "paid");
});

test("a return cannot select an order that never started a SabPaisa payment", async () => {
  const order = seedOrder(); // no gateway, no stored attempt
  enquiryImpl = () => { throw new Error("enquiry must not be called"); };
  const res = await postCallback(signedCallback(order.id));
  assert.match(res.headers.get("location"), /returnStatus=failure/);
  assert.notEqual(orders.get(order.id).status, "paid");
});

test("a verified return does not downgrade an order the enquiry still confirms", async () => {
  const order = attempt(seedOrder({ status: "paid", paidAt: "2026-01-01T00:00:00.000Z" }));
  enquiryImpl = () => enquiryJson(enquiryBody(order.id));
  await postCallback(signedCallback(order.id, { status: "FAILED" }));
  const after = orders.get(order.id);
  assert.equal(after.status, "paid");
  assert.equal(after.paidAt, "2026-01-01T00:00:00.000Z", "paidAt must not move");
});

test("the return does not persist the raw payload or the signature", async () => {
  const order = attempt(seedOrder());
  enquiryImpl = () => enquiryJson(enquiryBody(order.id));
  const data = signedCallback(order.id);
  await postCallback(data);
  const stored = JSON.stringify(orders.get(order.id));
  assert.doesNotMatch(stored, new RegExp(data.signature));
  assert.equal(orders.get(order.id).raw, undefined);
  for (const secret of [FAKE.SABPAISA_SECRET_KEY, FAKE.SABPAISA_WEBHOOK_SECRET, FAKE.SABPAISA_API_KEY]) {
    assert.doesNotMatch(stored, new RegExp(secret));
  }
});

// ── Webhook ─────────────────────────────────────────────────────────────────
//
// An authenticated webhook is an authentication step, not a settlement.
// `event: "payment.success"` never settles on its own — the enquiry decides.

test("a webhook with no signature fails closed", async () => {
  const order = attempt(seedOrder());
  enquiryImpl = () => { throw new Error("enquiry must not be called"); };
  const res = await fetch(`${base}/api/payment/sabpaisa/webhook`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "payment.success", merchant_txn_id: order.id, status: "SUCCESS" }),
  });
  assert.equal(res.status, 400);
  assert.notEqual(orders.get(order.id).status, "paid");
});

test("a webhook with an invalid signature fails closed", async () => {
  const order = attempt(seedOrder());
  enquiryImpl = () => { throw new Error("enquiry must not be called"); };
  const res = await fetch(`${base}/api/payment/sabpaisa/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-SabPaisa-Signature": `${Date.now()}.AAAA` },
    body: JSON.stringify({ event: "payment.success", merchant_txn_id: order.id, status: "SUCCESS" }),
  });
  assert.equal(res.status, 400);
  assert.notEqual(orders.get(order.id).status, "paid");
});

test("the webhook signature must cover the EXACT raw bytes", async () => {
  const order = attempt(seedOrder());
  enquiryImpl = () => { throw new Error("enquiry must not be called"); };
  const body = { event: "payment.success", merchant_txn_id: order.id, status: "SUCCESS" };

  // Sign a re-serialized (key-reordered) form, then send the original bytes.
  const reserialized = JSON.stringify({ status: "SUCCESS", merchant_txn_id: order.id, event: "payment.success" });
  const raw = JSON.stringify(body);
  assert.notEqual(raw, reserialized, "the two serializations must differ");

  const ts = Date.now();
  const sig = `${ts}.` + crypto.createHmac("sha256", FAKE.SABPAISA_WEBHOOK_SECRET)
    .update(`${ts}.${reserialized}`).digest("base64");
  const res = await fetch(`${base}/api/payment/sabpaisa/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-SabPaisa-Signature": sig },
    body: raw,
  });
  assert.equal(res.status, 400);
  assert.notEqual(orders.get(order.id).status, "paid");
});

test("a replayed (stale-timestamp) webhook fails closed", async () => {
  const order = attempt(seedOrder());
  enquiryImpl = () => { throw new Error("enquiry must not be called"); };
  const body = JSON.stringify({ event: "payment.success", merchant_txn_id: order.id, status: "SUCCESS" });
  const old = Date.now() - 10 * 60 * 1000;   // outside the 5-minute window
  const sig = `${old}.` + crypto.createHmac("sha256", FAKE.SABPAISA_WEBHOOK_SECRET)
    .update(`${old}.${body}`).digest("base64");
  const res = await fetch(`${base}/api/payment/sabpaisa/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-SabPaisa-Signature": sig },
    body,
  });
  assert.equal(res.status, 400);
  assert.notEqual(orders.get(order.id).status, "paid");
});

test("a timestamp just inside the 5-minute window is accepted", async () => {
  const order = attempt(seedOrder());
  enquiryImpl = () => enquiryJson(enquiryBody(order.id));
  const body = JSON.stringify({
    event: "payment.success", merchant_txn_id: order.id, txn_id: "SP-1", status: "SUCCESS",
  });
  const ts = Date.now() - 4 * 60 * 1000;
  const sig = `${ts}.` + crypto.createHmac("sha256", FAKE.SABPAISA_WEBHOOK_SECRET)
    .update(`${ts}.${body}`).digest("base64");
  const res = await fetch(`${base}/api/payment/sabpaisa/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-SabPaisa-Signature": sig },
    body,
  });
  assert.equal(res.status, 200);
  assert.equal(orders.get(order.id).status, "paid");
});

test("a signed webhook for an unknown order cannot mark anything paid", async () => {
  enquiryImpl = () => { throw new Error("enquiry must not be called"); };
  const res = await postWebhook({
    event: "payment.success", merchant_txn_id: "FIR-ghost", txn_id: "SP-1", status: "SUCCESS",
  });
  assert.equal(res.status, 404);
});

test("a signed webhook with no merchant_txn_id is rejected", async () => {
  enquiryImpl = () => { throw new Error("enquiry must not be called"); };
  const res = await postWebhook({ event: "payment.success", txn_id: "SP-1", status: "SUCCESS" });
  assert.equal(res.status, 400);
});

test("a signed webhook whose reference does not match the stored attempt fails closed", async () => {
  const order = attempt(seedOrder());
  order.sabpaisaMerchantTxnId = "FIR-other-attempt";
  enquiryImpl = () => { throw new Error("enquiry must not be called"); };
  const res = await postWebhook({
    event: "payment.success", merchant_txn_id: order.id, txn_id: "SP-1", status: "SUCCESS",
  });
  assert.equal(res.status, 400);
  assert.notEqual(orders.get(order.id).status, "paid");
});

test("a signed webhook does NOT require an amount — the enquiry supplies it", async () => {
  // Webhook amounts are rupee representations and are only a sanity check; the
  // canonical paise comparison is the enquiry's, so a webhook carrying no
  // amount at all must still reconcile normally.
  const order = attempt(seedOrder({ total: 849 }));
  enquiryImpl = () => enquiryJson(enquiryBody(order.id));
  const res = await postWebhook({
    event: "payment.success", merchant_txn_id: order.id, txn_id: "SP-1", status: "SUCCESS",
  });
  assert.equal(res.status, 200);
  assert.equal(orders.get(order.id).status, "paid");
});

test("a verified webhook calls the enquiry with clientCode and the stored reference", async () => {
  const order = attempt(seedOrder({ total: 849 }));
  let calls = 0;
  enquiryImpl = (body) => {
    calls++;
    assert.equal(body.clientCode, FAKE.SABPAISA_CLIENT_CODE);
    // Always queried by the SERVER-stored reference, never a request value.
    assert.equal(body.merchantTxnId, order.sabpaisaMerchantTxnId);
    assert.equal(body.secretKey, undefined);
    return enquiryJson(enquiryBody(order.id, { txnId: "SP-77" }));
  };
  const res = await postWebhook({
    event: "payment.success", merchant_txn_id: order.id, txn_id: "SP-77",
    status: "SUCCESS", paid_amount: "849.00", idempotency_key: "idem-settle-1",
  });
  assert.equal(res.status, 200);
  assert.equal(calls, 1);
  assert.deepEqual(await res.json(), { received: true, status: "paid" });

  const after = orders.get(order.id);
  assert.equal(after.status, "paid");
  assert.equal(after.sabpaisaTxnId, "SP-77");
  assert.ok(after.paidAt);
  assert.equal(after.paidAmount, 84900);
});

test("webhook success + enquiry SUCCESS => paid", async () => {
  const order = attempt(seedOrder());
  enquiryImpl = () => enquiryJson({ success: true, data: enquiryBody(order.id) });
  const res = await postWebhook({
    event: "payment.success", merchant_txn_id: order.id, txn_id: "SP-1", status: "SUCCESS",
  });
  assert.equal(res.status, 200);
  assert.equal(orders.get(order.id).status, "paid");
});

test("webhook success + enquiry FAILED => failed", async () => {
  const order = attempt(seedOrder());
  enquiryImpl = () => enquiryJson(enquiryBody(order.id, { status: "FAILED" }));
  const res = await postWebhook({
    event: "payment.success", merchant_txn_id: order.id, txn_id: "SP-1", status: "SUCCESS",
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { received: true, status: "failed" });
  const after = orders.get(order.id);
  assert.equal(after.status, "failed");
  assert.equal(after.paidAt, undefined);
});

test("webhook FAILURE + enquiry SUCCESS => paid (the enquiry wins)", async () => {
  const order = attempt(seedOrder());
  enquiryImpl = () => enquiryJson(enquiryBody(order.id));
  const res = await postWebhook({
    event: "payment.failed", merchant_txn_id: order.id, txn_id: "SP-1", status: "FAILED",
  });
  assert.equal(res.status, 200);
  assert.equal(orders.get(order.id).status, "paid");
});

test("webhook success + enquiry PENDING/PROCESSING => pending", async () => {
  for (const status of ["PENDING", "PROCESSING"]) {
    const order = attempt(seedOrder());
    enquiryImpl = () => enquiryJson(enquiryBody(order.id, { status }));
    const res = await postWebhook({
      event: "payment.success", merchant_txn_id: order.id, txn_id: "SP-1", status: "SUCCESS",
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: true, status: "pending" });
    const after = orders.get(order.id);
    assert.equal(after.status, "pending");
    assert.equal(after.paidAt, undefined);
  }
});

test("an EXPIRED enquiry maps to failed, documented for this order model", async () => {
  const order = attempt(seedOrder());
  enquiryImpl = () => enquiryJson(enquiryBody(order.id, { status: "EXPIRED" }));
  const res = await postWebhook({
    event: "payment.expired", merchant_txn_id: order.id, txn_id: "SP-1", status: "EXPIRED",
  });
  assert.equal(res.status, 200);
  const after = orders.get(order.id);
  assert.equal(after.status, "failed");
  assert.equal(after.paidAt, undefined);
});

test("an UNKNOWN enquiry status leaves the order state untouched", async () => {
  const order = attempt(seedOrder());
  enquiryImpl = () => enquiryJson(enquiryBody(order.id, { status: "SOMETHING-NEW" }));
  const res = await postWebhook({
    event: "payment.success", merchant_txn_id: order.id, txn_id: "SP-1", status: "SUCCESS",
  });
  assert.equal(res.status, 200);
  const after = orders.get(order.id);
  assert.equal(after.status, "pending", "an unrecognized status must not be guessed");
  assert.equal(after.paidAt, undefined);
});

test("an enquiry that cannot be reached leaves the order unsettled (503)", async () => {
  const order = attempt(seedOrder());
  enquiryImpl = () => { throw new Error("ECONNRESET"); };
  const res = await postWebhook({
    event: "payment.success", merchant_txn_id: order.id, txn_id: "SP-1", status: "SUCCESS",
  });
  // 503 so SabPaisa retries; the state is untouched.
  assert.equal(res.status, 503);
  const after = orders.get(order.id);
  assert.equal(after.status, "pending");
  assert.equal(after.paidAt, undefined);
  assert.doesNotMatch(JSON.stringify(await res.json()), /ECONNRESET/);
});

test("an enquiry 5xx or invalid JSON leaves the order unsettled (503)", async () => {
  for (const impl of [
    () => enquiryJson({}, 500),
    () => ({ ok: true, status: 200, text: async () => "not json" }),
  ]) {
    const order = attempt(seedOrder());
    enquiryImpl = impl;
    const res = await postWebhook({
      event: "payment.success", merchant_txn_id: order.id, txn_id: "SP-1", status: "SUCCESS",
    });
    assert.equal(res.status, 503);
    const after = orders.get(order.id);
    assert.equal(after.status, "pending");
    assert.equal(after.paidAt, undefined);
  }
});

test("an enquiry that does not find the transaction never downgrades to failed", async () => {
  const order = attempt(seedOrder());
  enquiryImpl = () => enquiryJson({ message: "unknown" }, 404);
  const res = await postWebhook({
    event: "payment.success", merchant_txn_id: order.id, txn_id: "SP-1", status: "SUCCESS",
  });
  assert.equal(res.status, 200);
  const after = orders.get(order.id);
  assert.equal(after.status, "pending");
  assert.equal(after.paidAt, undefined);
});

test("a webhook whose enquiry amountPaise differs from order.total is rejected", async () => {
  const order = attempt(seedOrder({ total: 849 }));
  enquiryImpl = () => enquiryJson(enquiryBody(order.id, { amountPaise: 100 }));
  const res = await postWebhook({
    event: "payment.success", merchant_txn_id: order.id, txn_id: "SP-1", status: "SUCCESS",
  });
  assert.equal(res.status, 400);
  const after = orders.get(order.id);
  assert.notEqual(after.status, "paid");
  assert.equal(after.paidAt, undefined);
});

test("a webhook whose enquiry omits amountPaise cannot mark paid", async () => {
  const order = attempt(seedOrder({ total: 849 }));
  enquiryImpl = () => {
    const b = enquiryBody(order.id);
    delete b.amountPaise;   // rupee fields must NOT be used as a fallback
    return enquiryJson(b);
  };
  const res = await postWebhook({
    event: "payment.success", merchant_txn_id: order.id, txn_id: "SP-1", status: "SUCCESS",
  });
  assert.equal(res.status, 400);
  assert.notEqual(orders.get(order.id).status, "paid");
});

test("a webhook whose enquiry reports a different merchantTxnId is rejected", async () => {
  const order = attempt(seedOrder());
  enquiryImpl = () => enquiryJson(enquiryBody("FIR-SOMEONE-ELSE"));
  const res = await postWebhook({
    event: "payment.success", merchant_txn_id: order.id, txn_id: "SP-1", status: "SUCCESS",
  });
  assert.equal(res.status, 400);
  assert.notEqual(orders.get(order.id).status, "paid");
});

test("a webhook whose enquiry returns a different transaction id is rejected", async () => {
  const order = attempt(seedOrder());
  enquiryImpl = () => enquiryJson(enquiryBody(order.id, { txnId: "SP-DIFFERENT" }));
  const res = await postWebhook({
    event: "payment.success", merchant_txn_id: order.id, txn_id: "SP-CLAIMED",
    status: "SUCCESS", idempotency_key: "idem-txn-mismatch",
  });
  assert.equal(res.status, 400);
  assert.notEqual(orders.get(order.id).status, "paid");
});

test("a webhook whose enquiry currency is not INR cannot mark paid", async () => {
  const order = attempt(seedOrder());
  enquiryImpl = () => enquiryJson(enquiryBody(order.id, { currency: "USD" }));
  const res = await postWebhook({
    event: "payment.success", merchant_txn_id: order.id, txn_id: "SP-1", status: "SUCCESS",
  });
  assert.equal(res.status, 400);
  assert.notEqual(orders.get(order.id).status, "paid");
});

// ── Idempotency ─────────────────────────────────────────────────────────────

test("a duplicate verified webhook is idempotent and never moves paidAt", async () => {
  const order = attempt(seedOrder());
  let calls = 0;
  enquiryImpl = () => { calls++; return enquiryJson(enquiryBody(order.id)); };

  const payload = {
    event: "payment.success", merchant_txn_id: order.id, txn_id: "SP-1",
    status: "SUCCESS", paid_amount: "849.00", idempotency_key: "idem-dup-1",
  };
  const first = await postWebhook(payload);
  assert.equal(first.status, 200);
  const paidAt = orders.get(order.id).paidAt;
  assert.ok(paidAt);
  assert.equal(calls, 1);

  const second = await postWebhook(payload);
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { received: true, status: "paid" });
  // The replay short-circuits: no second enquiry, and paidAt is unchanged.
  assert.equal(calls, 1, "a duplicate must not re-run reconciliation");
  assert.equal(orders.get(order.id).paidAt, paidAt);
});

test("replaying a verified webhook without an idempotency key is still safe", async () => {
  const order = attempt(seedOrder());
  enquiryImpl = () => enquiryJson(enquiryBody(order.id));
  const payload = {
    event: "payment.success", merchant_txn_id: order.id, txn_id: "SP-1", status: "SUCCESS",
  };
  await postWebhook(payload);
  const paidAt = orders.get(order.id).paidAt;
  assert.ok(paidAt);

  const again = await postWebhook(payload);
  assert.equal(again.status, 200);
  const after = orders.get(order.id);
  assert.equal(after.status, "paid");
  assert.equal(after.paidAt, paidAt, "a replay must not move paidAt");
});

test("a different transaction cannot overwrite an already-paid order", async () => {
  const order = attempt(seedOrder({
    status: "paid", paidAt: "2026-01-01T00:00:00.000Z", sabpaisaTxnId: "SP-ORIGINAL",
  }));
  enquiryImpl = () => { throw new Error("enquiry must not be called"); };
  const res = await postWebhook({
    event: "payment.success", merchant_txn_id: order.id, txn_id: "SP-ATTACKER",
    status: "SUCCESS", paid_amount: "849.00", idempotency_key: "idem-other-txn",
  });
  assert.equal(res.status, 409);
  const after = orders.get(order.id);
  assert.equal(after.sabpaisaTxnId, "SP-ORIGINAL");
  assert.equal(after.paidAt, "2026-01-01T00:00:00.000Z");
});

// ── Simulation ──────────────────────────────────────────────────────────────

test("simulation cannot mark an order paid in production", async () => {
  const order = attempt(seedOrder());
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const res = await fetch(`${base}/api/payment/sabpaisa/simulate/${order.id}`, { method: "POST" });
    assert.equal(res.status, 404);
    assert.notEqual(orders.get(order.id).status, "paid");
  } finally {
    process.env.NODE_ENV = prev;
  }
});

test("simulation is also blocked when NODE_ENV is unset", async () => {
  const order = attempt(seedOrder());
  const prev = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    const res = await fetch(`${base}/api/payment/sabpaisa/simulate/${order.id}`, { method: "POST" });
    assert.equal(res.status, 404);
    assert.notEqual(orders.get(order.id).status, "paid");
  } finally {
    process.env.NODE_ENV = prev;
  }
});

// ── kkchat forwarding ───────────────────────────────────────────────────────

test("unverified payment data is never forwarded to kkchat", async () => {
  const order = attempt(seedOrder());
  // Unverified callback.
  await postCallback({ merchant_txn_id: order.id, status: "SUCCESS" });
  // Unsigned webhook.
  await fetch(`${base}/api/payment/sabpaisa/webhook`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "payment.success", merchant_txn_id: order.id, status: "SUCCESS" }),
  });
  assert.equal(kkchatCalls.length, 0, "nothing unverified may be forwarded");
});

test("verified data forwarded to kkchat is stamped verified and carries no secrets", async () => {
  const order = attempt(seedOrder());
  await postCallback(signedCallback(order.id));
  assert.equal(kkchatCalls.length, 1);
  assert.equal(kkchatCalls[0].verified, true);
  assert.equal(kkchatCalls[0].stage, "browser_return");
  const body = JSON.stringify(kkchatCalls[0]);
  for (const secret of [FAKE.SABPAISA_SECRET_KEY, FAKE.SABPAISA_WEBHOOK_SECRET, FAKE.SABPAISA_API_KEY]) {
    assert.doesNotMatch(body, new RegExp(secret));
  }
});

// ── Regression: other gateways still mounted ────────────────────────────────

test("existing AirPay routes are preserved", async () => {
  const order = seedOrder();
  const res = await fetch(`${base}/api/payment/airpay/initiate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId: order.id }),
  });
  // Mounted and reachable (200 simulated or 502 unreachable) — never 404.
  assert.notEqual(res.status, 404);
  const unknown = await fetch(`${base}/api/payment/airpay/initiate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId: "FIR-nope" }),
  });
  assert.equal(unknown.status, 404, "AirPay still resolves orders");
});

test("existing PayU routes are preserved", async () => {
  const order = seedOrder();
  const res = await fetch(`${base}/api/payment/payu/initiate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId: order.id }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(json.fields?.txnid, "PayU checkout still builds");

  // The PayU GET guard is untouched.
  const get = await fetch(`${base}/api/payment/payu/callback`);
  assert.equal(get.status, 405);
});

test("the SabPaisa callback does not use PayU verification logic", async () => {
  // A PayU-shaped (sha512 hash) payload must not authenticate a SabPaisa return.
  const order = attempt(seedOrder());
  const res = await postCallback({
    merchant_txn_id: order.id, status: "SUCCESS", paid_amount: 84900,
    timestamp: Date.now(),
    hash: crypto.createHash("sha512").update("whatever").digest("hex"),
  });
  assert.match(res.headers.get("location"), /returnStatus=failure/);
  assert.notEqual(orders.get(order.id).status, "paid");
});
