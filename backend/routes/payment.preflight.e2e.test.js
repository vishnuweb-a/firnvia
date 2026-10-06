// Task 6 controlled preflight: the FULL chain, terminating at the one endpoint
// the frontend actually trusts — GET /api/orders/:id.
//
// The per-gateway suites (payment.payu.test.js, payment.sabpaisa.test.js) already
// pin every verification and reconciliation branch, but they mount only the
// payment router. This file mounts the REAL orders router alongside it, so each
// assertion below is read back the way the browser reads it:
//
//   POST /api/orders  ->  initiate  ->  verified callback  ->  webhook
//   ->  mocked provider verification  ->  GET /api/orders/:id
//
// Covers Task 6 Steps 4, 5, 7 and 8. No real PayU, SabPaisa or AirPay traffic:
// axios (SabPaisa session creation) and global fetch (PayU Verify Payment,
// SabPaisa Transaction Enquiry, the kkchat relay) are stubbed throughout, and
// no form is ever submitted or redirect ever followed.
//
// Run: node --test routes/payment.preflight.e2e.test.js

import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";

const FAKE = {
  // Production-shaped endpoints, fake credentials. Nothing is contacted.
  PAYU_ENV: "production",
  PAYU_KEY: "fake_merchant_key",
  PAYU_SALT: "fake_merchant_salt",
  PAYU_PAYMENT_URL: "https://secure.payu.in/_payment",
  PAYU_VERIFY_URL: "https://info.payu.in/merchant/postservice.php?form=2",
  SABPAISA_CLIENT_CODE: "FAKECLIENT",
  SABPAISA_API_KEY: "fake_api_key",
  SABPAISA_SECRET_KEY: "fake_secret_key",
  // Production is MISSING this; a fake one is used so the synthetic S2S path can
  // be exercised at all. See the Task 6 report: supplying it in production is a
  // separate, unmet release gate.
  SABPAISA_WEBHOOK_SECRET: "fake_webhook_secret",
  SABPAISA_PAY_URL: "https://merchant-api.sabpaisa.in/api/v2/payments",
  SABPAISA_ENQUIRY_URL: "https://merchant-api.sabpaisa.in/api/v2/payments/enquiry",
  PUBLIC_BASE_URL: "https://example.com",
  FRONTEND_URL: "https://frontend.example.com",
  NODE_ENV: "test",
};
Object.assign(process.env, FAKE);

const ordersRouter = (await import("./orders.js")).default;
const paymentRouter = (await import("./payment.js")).default;
const axios = (await import("axios")).default;

let server, base;

// ── External boundaries ─────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
let verifyImpl = null;   // PayU Verify Payment
let enquiryImpl = null;  // SabPaisa Transaction Enquiry
let kkchatCalls = [];

globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith("https://info.payu.in/")) {
    if (!verifyImpl) throw new Error("unexpected Verify Payment call");
    return verifyImpl();
  }
  if (u.includes("/payments/enquiry")) {
    if (!enquiryImpl) throw new Error("unexpected enquiry call");
    return enquiryImpl();
  }
  if (u.includes("kkchat.in")) {
    kkchatCalls.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => "{}" };
  }
  return realFetch(url, init);
};

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
  json: async () => payload,
});

before(async () => {
  const app = express();
  // Mirrors server.js exactly, including the raw-body capture the SabPaisa
  // webhook signature depends on.
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use(express.urlencoded({ extended: true }));
  app.use("/api/orders", ordersRouter);
  app.use("/api/payment", paymentRouter);
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => { verifyImpl = null; enquiryImpl = null; kkchatCalls = []; });

// ── Chain helpers: every step goes over HTTP, nothing is poked in memory ─────

const postJson = (path, body) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const postForm = (path, payload) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(payload).toString(),
    redirect: "manual",
  });

/** The only status source the frontend is allowed to trust. */
async function orderStatus(orderId) {
  const res = await fetch(`${base}/api/orders/${orderId}`);
  assert.equal(res.status, 200, "GET /api/orders/:id must serve the order");
  return (await res.json()).status;
}

/** Step 1 of every chain: a real internal order, created over HTTP. */
async function createOrder() {
  const res = await postJson("/api/orders", {
    items: [{ id: "website-redesign-mini", qty: 1 }],
    buyer: {
      firstName: "Asha", lastName: "Rao",
      email: "asha@example.com", phone: "9876543210",
    },
  });
  assert.equal(res.status, 200, "order creation must succeed");
  const order = await res.json();
  assert.equal(order.status, "pending", "a new order is never born paid");
  return order;
}

const sha512 = (s) => crypto.createHash("sha512").update(s, "utf8").digest("hex");

/** A reverse-hash-valid PayU browser return / webhook payload. */
function payuSigned(order, txnid, amount, overrides = {}) {
  const payload = {
    mihpayid: "4039384727", mode: "CC",
    status: "success", unmappedstatus: "captured",
    key: FAKE.PAYU_KEY, txnid, amount,
    productinfo: `Firvanra Order ${order.id}`,
    firstname: "Asha", email: "asha@example.com",
    udf1: order.id, udf2: "", udf3: "", udf4: "", udf5: "",
    ...overrides,
  };
  const udf = [5, 4, 3, 2, 1].map((i) => payload[`udf${i}`] ?? "");
  payload.hash = sha512([
    FAKE.PAYU_SALT, payload.status, "", "", "", "", "", "",
    ...udf, payload.email, payload.firstname, payload.productinfo,
    payload.amount, payload.txnid, payload.key,
  ].join("|"));
  return payload;
}

const payuVerifyBody = (order, txnid, amount, over = {}) => ({
  status: 1,
  transaction_details: {
    [txnid]: {
      mihpayid: "4039384727", txnid, amt: amount,
      status: "success", unmappedstatus: "captured",
      productinfo: `Firvanra Order ${order.id}`,
      udf1: order.id, mode: "CC", bank_ref_num: "909090",
      ...over,
    },
  },
});

/** A signature-valid SabPaisa PG 3.0 return payload (amounts in RUPEES). */
function sabpaisaSignedReturn(orderId, { rupees, status = "SUCCESS", txn = "SP-1" }) {
  const params = {
    merchant_txn_id: orderId, transaction_id: txn, status,
    amount: rupees, paid_amount: rupees, payment_mode: "UPI",
    timestamp: String(Date.now()),
  };
  const signature = crypto
    .createHmac("sha256", FAKE.SABPAISA_SECRET_KEY)
    .update(Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("|"))
    .digest("hex");
  return { ...params, signature };
}

const sabpaisaEnquiry = (merchantTxnId, paise, over = {}) => ({
  success: true, traceId: "trace-1", txnId: "SP-1",
  merchantId: FAKE.SABPAISA_CLIENT_CODE, merchantTxnId,
  amountPaise: paise, currency: "INR", status: "SUCCESS", paymentMode: "UPI",
  bankTxnId: "BANK-1", bankRrn: "RRN-1",
  completedAt: "2026-10-06T10:00:00.000Z",
  ...over,
});

function sabpaisaWebhookRequest(body) {
  const raw = JSON.stringify(body);
  const ts = Date.now();
  const sig = `${ts}.` + crypto
    .createHmac("sha256", FAKE.SABPAISA_WEBHOOK_SECRET)
    .update(`${ts}.${raw}`).digest("base64");
  return fetch(`${base}/api/payment/sabpaisa/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-SabPaisa-Signature": sig },
    body: raw,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// STEP 4 — PayU initiate preflight (the form is built, never submitted)
// ════════════════════════════════════════════════════════════════════════════

test("PayU initiate returns a production form contract derived from order.total", async () => {
  const order = await createOrder();
  const res = await postJson("/api/payment/payu/initiate", { orderId: order.id });
  assert.equal(res.status, 200);
  const checkout = await res.json();

  assert.equal(checkout.provider, "payu");
  assert.equal(checkout.type, "form");
  assert.equal(checkout.action, "https://secure.payu.in/_payment",
    "must post to the PayU production endpoint");
  assert.equal(checkout.method, "POST");

  // Amount is the server's own total, formatted — never anything client-sent.
  assert.equal(checkout.fields.amount, order.total.toFixed(2));
  assert.equal(checkout.fields.udf1, order.id);
  assert.equal(checkout.fields.key, FAKE.PAYU_KEY);
  assert.ok(checkout.fields.hash, "a signed hash is present");
  assert.ok(checkout.fields.txnid, "a server-generated txnid is present");

  // The order is still only pending: building a form authorizes nothing.
  assert.equal(await orderStatus(order.id), "pending");
});

test("PayU initiate ignores a client-supplied amount and txnid", async () => {
  const order = await createOrder();
  const res = await postJson("/api/payment/payu/initiate", {
    orderId: order.id, amount: "1.00", txnid: "attacker-chosen", total: 1,
  });
  const checkout = await res.json();
  assert.equal(checkout.fields.amount, order.total.toFixed(2),
    "the client amount must be ignored entirely");
  assert.notEqual(checkout.fields.txnid, "attacker-chosen");
});

test("PayU initiate leaks no salt or hash input", async () => {
  const order = await createOrder();
  const text = await (await postJson("/api/payment/payu/initiate", { orderId: order.id })).text();
  assert.ok(!text.includes(FAKE.PAYU_SALT), "the Salt must never be returned");
  assert.ok(!text.toLowerCase().includes("salt"));
});

// ════════════════════════════════════════════════════════════════════════════
// STEP 5 — SabPaisa initiate preflight (no navigation to checkout)
// ════════════════════════════════════════════════════════════════════════════

test("SabPaisa initiate returns a redirect contract with amount in paise from order.total", async (t) => {
  const order = await createOrder();
  let sentBody = null;
  t.mock.method(axios, "post", async (_url, body) => {
    sentBody = body;
    return { status: 200, data: { status: "SUCCESS", checkoutUrl: "https://checkout.sabpaisa.in/s/abc", sessionId: "sess-1" } };
  });

  const res = await postJson("/api/payment/sabpaisa/initiate", { orderId: order.id });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.provider, "sabpaisa");
  assert.equal(body.type, "redirect");
  assert.ok(body.checkoutUrl, "a checkoutUrl is returned (never navigated to here)");

  // The amount on the wire derives solely from order.total, converted to paise.
  assert.equal(sentBody.amount, Math.round(order.total * 100));
  assert.equal(sentBody.amount, order.total * 100);
  assert.equal(await orderStatus(order.id), "pending");
});

test("SabPaisa initiate ignores a client-supplied amount", async (t) => {
  const order = await createOrder();
  let sentBody = null;
  t.mock.method(axios, "post", async (_url, body) => {
    sentBody = body;
    return { status: 200, data: { status: "SUCCESS", checkoutUrl: "https://checkout.sabpaisa.in/s/abc" } };
  });
  await postJson("/api/payment/sabpaisa/initiate", { orderId: order.id, amount: 1, total: 1 });
  assert.equal(sentBody.amount, Math.round(order.total * 100),
    "only order.total may decide the amount");
});

// ════════════════════════════════════════════════════════════════════════════
// STEP 7 — PayU synthetic end-to-end, read back through GET /api/orders/:id
// ════════════════════════════════════════════════════════════════════════════

/** Order + initiate + verified browser return. Leaves the order pending. */
async function payuThroughCallback() {
  const order = await createOrder();
  const checkout = await (await postJson("/api/payment/payu/initiate", { orderId: order.id })).json();
  const txnid = checkout.fields.txnid;
  const amount = checkout.fields.amount;

  const cbRes = await postForm("/api/payment/payu/callback", payuSigned(order, txnid, amount));
  assert.ok(cbRes.status >= 300 && cbRes.status < 400, "the return redirects to the order page");

  // The browser return carries no authority: still pending.
  assert.equal(await orderStatus(order.id), "pending",
    "a verified browser return must never settle an order");
  return { order, txnid, amount };
}

test("full PayU chain: initiate -> callback -> webhook -> Verify success+captured -> paid", async () => {
  const { order, txnid, amount } = await payuThroughCallback();

  verifyImpl = () => jsonResponse(payuVerifyBody(order, txnid, amount));
  const res = await postForm("/api/payment/payu/webhook", payuSigned(order, txnid, amount));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "paid");

  // The authoritative read the frontend performs.
  assert.equal(await orderStatus(order.id), "paid");
  assert.equal(kkchatCalls.length, 0, "PayU must never touch the kkchat relay");
});

test("PayU Verify failure settles the order as failed", async () => {
  const { order, txnid, amount } = await payuThroughCallback();
  verifyImpl = () => jsonResponse(
    payuVerifyBody(order, txnid, amount, { status: "failure", unmappedstatus: "failed" }));
  await postForm("/api/payment/payu/webhook", payuSigned(order, txnid, amount));
  assert.equal(await orderStatus(order.id), "failed");
});

test("PayU Verify pending leaves the order pending", async () => {
  const { order, txnid, amount } = await payuThroughCallback();
  verifyImpl = () => jsonResponse(
    payuVerifyBody(order, txnid, amount, { status: "pending", unmappedstatus: "pending" }));
  await postForm("/api/payment/payu/webhook", payuSigned(order, txnid, amount));
  assert.equal(await orderStatus(order.id), "pending");
});

test("PayU Verify network error leaves the order unchanged and asks for a retry", async () => {
  const { order, txnid, amount } = await payuThroughCallback();
  verifyImpl = () => { throw new Error("ECONNRESET"); };
  const res = await postForm("/api/payment/payu/webhook", payuSigned(order, txnid, amount));
  assert.equal(res.status, 503, "503 so PayU retries");
  assert.equal(await orderStatus(order.id), "pending", "status must be untouched");
});

test("a tampered PayU callback is rejected and changes nothing", async () => {
  const order = await createOrder();
  const checkout = await (await postJson("/api/payment/payu/initiate", { orderId: order.id })).json();
  const tampered = payuSigned(order, checkout.fields.txnid, checkout.fields.amount);
  tampered.amount = "1.00"; // after hashing: the reverse hash no longer matches

  const res = await postForm("/api/payment/payu/callback", tampered);
  assert.equal(res.status, 400);
  assert.equal(await orderStatus(order.id), "pending");
});

test("a tampered PayU webhook is rejected and never reaches Verify Payment", async () => {
  const order = await createOrder();
  const checkout = await (await postJson("/api/payment/payu/initiate", { orderId: order.id })).json();
  const tampered = payuSigned(order, checkout.fields.txnid, checkout.fields.amount);
  tampered.hash = "0".repeat(128);

  verifyImpl = null; // any call would throw
  const res = await postForm("/api/payment/payu/webhook", tampered);
  assert.equal(res.status, 400);
  assert.equal(await orderStatus(order.id), "pending");
});

// ════════════════════════════════════════════════════════════════════════════
// STEP 8 — SabPaisa synthetic end-to-end, read back through GET /api/orders/:id
// ════════════════════════════════════════════════════════════════════════════

/** Order + initiate + signed browser return, with the enquiry outcome supplied. */
async function sabpaisaThroughCallback(t, enquiryStatus) {
  const order = await createOrder();
  t.mock.method(axios, "post", async () => ({
    status: 200,
    data: { status: "SUCCESS", checkoutUrl: "https://checkout.sabpaisa.in/s/abc", sessionId: "sess-1" },
  }));
  const init = await (await postJson("/api/payment/sabpaisa/initiate", { orderId: order.id })).json();
  assert.equal(init.type, "redirect");

  const paise = Math.round(order.total * 100);
  const rupees = order.total.toFixed(2);
  enquiryImpl = () => jsonResponse(sabpaisaEnquiry(order.id, paise, { status: enquiryStatus }));

  const res = await fetch(
    `${base}/api/payment/sabpaisa/callback?` +
      new URLSearchParams(sabpaisaSignedReturn(order.id, { rupees })).toString(),
    { redirect: "manual" });
  assert.ok(res.status >= 300 && res.status < 400, "the return redirects");
  return { order, paise, rupees };
}

test("full SabPaisa chain: initiate -> signed callback -> enquiry SUCCESS -> paid", async (t) => {
  const { order } = await sabpaisaThroughCallback(t, "SUCCESS");
  assert.equal(await orderStatus(order.id), "paid");
  // Only verified payloads may be relayed, and only on the SabPaisa path.
  assert.equal(kkchatCalls.length, 1);
  assert.equal(kkchatCalls[0].verified, true);
});

test("SabPaisa enquiry FAILED settles as failed even after a signed return", async (t) => {
  const { order } = await sabpaisaThroughCallback(t, "FAILED");
  assert.equal(await orderStatus(order.id), "failed");
});

test("SabPaisa enquiry PENDING leaves the order pending", async (t) => {
  const { order } = await sabpaisaThroughCallback(t, "PENDING");
  assert.equal(await orderStatus(order.id), "pending");
});

test("SabPaisa enquiry outage leaves the order unchanged", async (t) => {
  const order = await createOrder();
  t.mock.method(axios, "post", async () => ({
    status: 200,
    data: { status: "SUCCESS", checkoutUrl: "https://checkout.sabpaisa.in/s/abc" },
  }));
  await postJson("/api/payment/sabpaisa/initiate", { orderId: order.id });

  enquiryImpl = () => { throw new Error("ETIMEDOUT"); };
  await fetch(
    `${base}/api/payment/sabpaisa/callback?` +
      new URLSearchParams(
        sabpaisaSignedReturn(order.id, { rupees: order.total.toFixed(2) })).toString(),
    { redirect: "manual" });

  assert.equal(await orderStatus(order.id), "pending",
    "an unreachable enquiry must never settle an order");
});

test("full SabPaisa S2S chain: signed webhook -> enquiry SUCCESS -> paid", async (t) => {
  const order = await createOrder();
  t.mock.method(axios, "post", async () => ({
    status: 200,
    data: { status: "SUCCESS", checkoutUrl: "https://checkout.sabpaisa.in/s/abc" },
  }));
  await postJson("/api/payment/sabpaisa/initiate", { orderId: order.id });

  const paise = Math.round(order.total * 100);
  enquiryImpl = () => jsonResponse(sabpaisaEnquiry(order.id, paise));

  const res = await sabpaisaWebhookRequest({
    event: "payment.success", txn_id: "SP-1", merchant_txn_id: order.id,
    status: "SUCCESS", paid_amount: order.total.toFixed(2),
    idempotency_key: `idem-${order.id}`,
  });
  assert.equal(res.status, 200);
  assert.equal(await orderStatus(order.id), "paid");
});

test("an invalid SabPaisa callback signature is rejected and changes nothing", async (t) => {
  const order = await createOrder();
  t.mock.method(axios, "post", async () => ({
    status: 200,
    data: { status: "SUCCESS", checkoutUrl: "https://checkout.sabpaisa.in/s/abc" },
  }));
  await postJson("/api/payment/sabpaisa/initiate", { orderId: order.id });

  const payload = sabpaisaSignedReturn(order.id, { rupees: order.total.toFixed(2) });
  payload.signature = "0".repeat(64);

  enquiryImpl = null; // any enquiry call would throw
  await fetch(`${base}/api/payment/sabpaisa/callback?` + new URLSearchParams(payload).toString(),
    { redirect: "manual" });

  assert.equal(await orderStatus(order.id), "pending");
  assert.equal(kkchatCalls.length, 0, "an unverified payload must not be relayed");
});

test("an invalid SabPaisa webhook signature is rejected and changes nothing", async (t) => {
  const order = await createOrder();
  t.mock.method(axios, "post", async () => ({
    status: 200,
    data: { status: "SUCCESS", checkoutUrl: "https://checkout.sabpaisa.in/s/abc" },
  }));
  await postJson("/api/payment/sabpaisa/initiate", { orderId: order.id });

  enquiryImpl = null;
  const res = await fetch(`${base}/api/payment/sabpaisa/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-SabPaisa-Signature": "123.bogus" },
    body: JSON.stringify({ event: "payment.success", merchant_txn_id: order.id, status: "SUCCESS" }),
  });
  assert.equal(res.status, 400);
  assert.equal(await orderStatus(order.id), "pending");
  assert.equal(kkchatCalls.length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// Cross-gateway: the single status authority
// ════════════════════════════════════════════════════════════════════════════

test("no simulate endpoint can settle an order while NODE_ENV is production", async () => {
  const order = await createOrder();
  process.env.NODE_ENV = "production";
  try {
    for (const gw of ["airpay", "sabpaisa"]) {
      const res = await fetch(`${base}/api/payment/${gw}/simulate/${order.id}`, { method: "POST" });
      assert.equal(res.status, 404, `${gw} simulate must be unreachable in production`);
    }
    assert.equal(await orderStatus(order.id), "pending");
  } finally {
    process.env.NODE_ENV = "test";
  }
});

test("GET /api/orders/:id is the only status source and cannot be steered by query params", async () => {
  const order = await createOrder();
  const res = await fetch(`${base}/api/orders/${order.id}?status=paid&returnStatus=success`);
  assert.equal((await res.json()).status, "pending",
    "query parameters must never influence the served status");
});

test("an unknown order id is a 404, never a fabricated status", async () => {
  const res = await fetch(`${base}/api/orders/FIR-does-not-exist`);
  assert.equal(res.status, 404);
});
