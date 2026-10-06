// Route tests for the SabPaisa webhook when SABPAISA_ENQUIRY_URL is NOT
// configured — a MISCONFIGURED deployment, not the expected state.
//
// Production configures the Transaction Enquiry endpoint
// (https://merchant-api.sabpaisa.in/api/v2/payments/enquiry), and the happy path
// lives in payment.sabpaisa.test.js. This file pins the fail-closed behaviour:
// with no enquiry endpoint there is no authoritative confirmation available, so
// NOTHING may reach "paid" — the webhook returns 503 and asks SabPaisa to retry
// rather than trusting an authenticated-but-unreconciled payload.
//
// Run: node --test routes/payment.sabpaisa.noenquiry.test.js
//
// A separate file is required because services/sabpaisa.js snapshots process.env
// at module load, so the "configured" and "not configured" cases cannot share a
// process. Fake credentials only; nothing external is contacted.

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";

const FAKE = {
  SABPAISA_CLIENT_CODE:    "FAKECLIENT",
  SABPAISA_API_KEY:        "fake_api_key",
  SABPAISA_SECRET_KEY:     "fake_secret_key",
  SABPAISA_WEBHOOK_SECRET: "fake_webhook_secret",
  SABPAISA_PAY_URL:        "https://sabpaisa.invalid/api/v2/payments",
  PUBLIC_BASE_URL:         "https://example.com",
  FRONTEND_URL:            "https://frontend.example.com",
  PAYU_ENV: "production",
  PAYU_KEY: "fake_merchant_key",
  PAYU_SALT: "fake_merchant_salt",
  PAYU_PAYMENT_URL: "https://secure.payu.in/_payment",
  PAYU_VERIFY_URL: "https://info.payu.in/merchant/postservice.php?form=2",
  NODE_ENV: "test",
};
Object.assign(process.env, FAKE);
delete process.env.SABPAISA_ENQUIRY_URL; // the point of this file

const sp = await import("../services/sabpaisa.js");
const { orders } = await import("./orders.js");
const router = (await import("./payment.js")).default;

let server, base;
const realFetch = globalThis.fetch;
let kkchatCalls = [];

globalThis.fetch = async (url, opts) => {
  if (String(url).includes("kkchat.in")) {
    kkchatCalls.push(JSON.parse(opts.body));
    return { ok: true, status: 200, text: async () => "{}" };
  }
  return realFetch(url, opts);
};

before(async () => {
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use(express.urlencoded({ extended: true }));
  app.use("/api/payment", router);
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); });

let seq = 0;
function attemptedOrder(overrides = {}) {
  const id = `FIR-ne${++seq}`;
  const order = {
    id, total: 849, items: [{ id: "p1", title: "T", price: 849, qty: 1 }],
    buyer: { firstName: "Asha", email: "a@b.c", phone: "9" },
    status: "pending", createdAt: new Date().toISOString(),
    gateway: "sabpaisa", sabpaisaMerchantTxnId: id, sabpaisaAmountPaise: 84900,
    ...overrides,
  };
  orders.set(order.id, order);
  return order;
}

function postWebhook(body) {
  const raw = JSON.stringify(body);
  const ts = Date.now();
  const sig = `${ts}.` + crypto.createHmac("sha256", FAKE.SABPAISA_WEBHOOK_SECRET)
    .update(`${ts}.${raw}`).digest("base64");
  return fetch(`${base}/api/payment/sabpaisa/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-SabPaisa-Signature": sig },
    body: raw,
  });
}

test("the enquiry endpoint is reported as not configured", () => {
  assert.equal(sp.enquiryProtocolStatus(), "not_configured");
  assert.equal(sp.sabpaisaEnquiryConfigured(), false);
  // Payment creation is still configured; only reconciliation is unavailable.
  assert.equal(sp.sabpaisaConfigured(), true);
});

test("enquireTransaction refuses to guess an endpoint", async () => {
  assert.deepEqual(await sp.enquireTransaction("FIR-x"),
    { ok: false, reason: "enquiry_not_configured" });
});

test("a signed success webhook CANNOT settle without an enquiry endpoint", async () => {
  const order = attemptedOrder();
  const res = await postWebhook({
    event: "payment.success", merchant_txn_id: order.id, txn_id: "SP-1",
    status: "SUCCESS", paid_amount: "849.00", idempotency_key: "ne-1",
  });
  // 503 so SabPaisa retries once the deployment is fixed. No state transition.
  assert.equal(res.status, 503);

  const after = orders.get(order.id);
  assert.equal(after.status, "pending");
  assert.notEqual(after.status, "paid");
  assert.notEqual(after.status, "awaiting_verification");
  assert.equal(after.paidAt, undefined, "no settlement timestamp without verification");
});

test("a signed FAILURE webhook also cannot settle without an enquiry", async () => {
  // The enquiry is the only authority in both directions: without it, even a
  // signed failure event does not move the order to "failed".
  const order = attemptedOrder();
  const res = await postWebhook({
    event: "payment.failed", merchant_txn_id: order.id, txn_id: "SP-3",
    status: "FAILED", paid_amount: "849.00",
  });
  assert.equal(res.status, 503);
  const after = orders.get(order.id);
  assert.equal(after.status, "pending");
  assert.equal(after.paidAt, undefined);
});

test("no amount of retrying a signed success reaches paid", async () => {
  const order = attemptedOrder();
  const payload = {
    event: "payment.success", merchant_txn_id: order.id, txn_id: "SP-4",
    status: "SUCCESS", paid_amount: "849.00", idempotency_key: "ne-dup",
  };
  for (let i = 0; i < 3; i++) {
    const res = await postWebhook(payload);
    assert.ok(res.status === 503 || res.status === 200);
  }
  const after = orders.get(order.id);
  assert.notEqual(after.status, "paid");
  assert.equal(after.paidAt, undefined);
});

test("an unsigned webhook is still rejected before anything else", async () => {
  const order = attemptedOrder();
  const res = await fetch(`${base}/api/payment/sabpaisa/webhook`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "payment.success", merchant_txn_id: order.id, status: "SUCCESS" }),
  });
  assert.equal(res.status, 400);
  assert.equal(orders.get(order.id).status, "pending");
});

test("a verified browser return cannot mark paid without an enquiry", async () => {
  const order = attemptedOrder();
  const params = {
    merchant_txn_id: order.id, transaction_id: "SP-5", status: "SUCCESS",
    amount: "849.00", paid_amount: "849.00", timestamp: String(Date.now()),
  };
  const signature = crypto.createHmac("sha256", FAKE.SABPAISA_SECRET_KEY)
    .update(Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("|"))
    .digest("hex");

  const res = await fetch(`${base}/api/payment/sabpaisa/callback`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...params, signature }),
  });
  assert.equal(res.status, 302);
  // The customer sees a pending order page, never an internal provider error.
  const loc = res.headers.get("location");
  assert.match(loc, /status=pending/);
  assert.doesNotMatch(loc, /returnStatus=success/);

  const after = orders.get(order.id);
  assert.notEqual(after.status, "paid");
  assert.equal(after.paidAt, undefined);
});

test("a different txn still cannot overwrite a paid order", async () => {
  const order = attemptedOrder({
    status: "paid", sabpaisaTxnId: "SP-ORIGINAL", paidAt: "2026-01-01T00:00:00.000Z",
  });
  const res = await postWebhook({
    event: "payment.success", merchant_txn_id: order.id, txn_id: "SP-ATTACKER",
    status: "SUCCESS", paid_amount: "849.00",
  });
  assert.equal(res.status, 409);
  assert.equal(orders.get(order.id).sabpaisaTxnId, "SP-ORIGINAL");
  assert.equal(orders.get(order.id).paidAt, "2026-01-01T00:00:00.000Z");
});

test("a missing webhook secret fails the webhook closed", async () => {
  // Proven at the adapter: with no secret there is no accept path at all.
  const saved = process.env.SABPAISA_WEBHOOK_SECRET;
  delete process.env.SABPAISA_WEBHOOK_SECRET;
  try {
    const fresh = await import(`../services/sabpaisa.js?nosecret=${Date.now()}`);
    assert.equal(fresh.sabpaisaWebhookConfigured(), false);
    const r = fresh.verifyWebhookSignature(`${Date.now()}.AAAA`, Buffer.from("{}"));
    assert.equal(r.ok, false);
    assert.equal(r.reason, "webhook secret not configured");
  } finally {
    process.env.SABPAISA_WEBHOOK_SECRET = saved;
  }
});

test("nothing unverified reaches kkchat on this path either", async () => {
  kkchatCalls = [];
  const order = attemptedOrder();
  await fetch(`${base}/api/payment/sabpaisa/webhook`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "payment.success", merchant_txn_id: order.id, status: "SUCCESS" }),
  });
  assert.equal(kkchatCalls.length, 0);
});
