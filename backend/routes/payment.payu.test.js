// Route tests for the PayU initiate + browser callback endpoints.
// Run: node --test routes/payment.payu.test.js
//
// Fake credentials only. A throwaway Express app is started on an ephemeral
// localhost port and closed after the run; no PayU endpoint is ever contacted.

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";

const FAKE = {
  PAYU_ENV: "production",
  PAYU_KEY: "fake_merchant_key",
  PAYU_SALT: "fake_merchant_salt",
  PAYU_PAYMENT_URL: "https://secure.payu.in/_payment",
  PAYU_VERIFY_URL: "https://info.payu.in/merchant/postservice.php?form=2",
  PUBLIC_BASE_URL: "https://example.com",
  FRONTEND_URL: "https://frontend.example.com",
};
Object.assign(process.env, FAKE);

// payu.js and payment.js both snapshot process.env at load, so import after.
const { orders } = await import("./orders.js");
const paymentMod = await import("./payment.js");
const router = paymentMod.default;

const sha512 = (s) => crypto.createHash("sha512").update(s, "utf8").digest("hex");

let server, base;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use("/api/payment", router);
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

let seq = 0;
function seedOrder(overrides = {}) {
  const order = {
    id: `FIR-test${++seq}`,
    items: [{ id: "p1", title: "Thing", price: 849, qty: 1 }],
    total: 849,
    buyer: {
      firstName: "Asha", lastName: "Rao",
      email: "asha@example.com", phone: "9876543210",
    },
    status: "pending",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  orders.set(order.id, order);
  return order;
}

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

/** Build a callback payload whose reverse hash is genuinely valid. */
function signedCallback(order, overrides = {}) {
  const payload = {
    mihpayid: "4039384727",
    mode: "CC",
    status: "success",
    unmappedstatus: "captured",
    key: FAKE.PAYU_KEY,
    txnid: order.payuTxnId,
    amount: "849.00",
    productinfo: `Firvanra Order ${order.id}`,
    firstname: "Asha",
    email: "asha@example.com",
    udf1: order.id,
    udf2: "", udf3: "", udf4: "", udf5: "",
    ...overrides,
  };
  const udf = [5, 4, 3, 2, 1].map((i) => payload[`udf${i}`] ?? "");
  payload.hash = sha512([
    FAKE.PAYU_SALT, payload.status,
    "", "", "", "", "", "",
    ...udf,
    payload.email, payload.firstname, payload.productinfo, payload.amount,
    payload.txnid, payload.key,
  ].join("|"));
  return payload;
}

/** Run a full initiate so the order carries real attempt metadata. */
async function initiated(overrides) {
  const order = seedOrder(overrides);
  const res = await postJson("/api/payment/payu/initiate", { orderId: order.id });
  assert.equal(res.status, 200);
  return { order, checkout: await res.json() };
}

// ── initiate ────────────────────────────────────────────────────────────────

test("initiate rejects missing orderId", async () => {
  const res = await postJson("/api/payment/payu/initiate", {});
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /orderId/i);
});

test("initiate rejects unknown order", async () => {
  const res = await postJson("/api/payment/payu/initiate", { orderId: "FIR-nope" });
  assert.equal(res.status, 404);
});

test("initiate rejects already-paid order", async () => {
  const order = seedOrder({ status: "paid" });
  const res = await postJson("/api/payment/payu/initiate", { orderId: order.id });
  assert.equal(res.status, 409);
});

test("initiate returns a production form-shaped contract", async () => {
  const { checkout } = await initiated();
  assert.equal(checkout.type, "form");
  assert.equal(checkout.provider, "payu");
  assert.equal(checkout.environment, "production");
  assert.equal(checkout.action, "https://secure.payu.in/_payment");
  assert.equal(checkout.method, "POST");
  for (const f of ["key", "txnid", "amount", "productinfo", "firstname",
    "email", "phone", "surl", "furl", "udf1", "hash"]) {
    assert.ok(checkout.fields[f] !== undefined, `missing field ${f}`);
  }
});

test("initiate derives amount from the trusted order total", async () => {
  const { checkout } = await initiated({ total: 1299.5 });
  assert.equal(checkout.fields.amount, "1299.50");
});

test("initiate ignores a frontend-supplied amount and txnid", async () => {
  const order = seedOrder({ total: 849 });
  const res = await postJson("/api/payment/payu/initiate", {
    orderId: order.id, amount: "1.00", total: 1, txnid: "ATTACKER", hash: "deadbeef",
  });
  const checkout = await res.json();
  assert.equal(checkout.fields.amount, "849.00");
  assert.notEqual(checkout.fields.txnid, "ATTACKER");
});

test("initiate stores payuTxnId and attempt metadata on the order", async () => {
  const { order, checkout } = await initiated();
  assert.equal(order.gateway, "payu");
  assert.equal(order.payuTxnId, checkout.fields.txnid);
  assert.ok(order.paymentAttemptedAt);
  assert.equal(order.status, "pending");
});

test("initiate never persists secrets on the order", async () => {
  const { order } = await initiated();
  const keys = Object.keys(order);
  for (const bad of ["hash", "salt", "payuHash", "payuSalt", "key", "payuKey"]) {
    assert.ok(!keys.includes(bad), `order must not store ${bad}`);
  }
});

test("initiate rejects an order with incomplete buyer data", async () => {
  const order = seedOrder({ buyer: { firstName: "Asha" } });
  const res = await postJson("/api/payment/payu/initiate", { orderId: order.id });
  assert.equal(res.status, 400);
});

// ── callback ────────────────────────────────────────────────────────────────

test("callback rejects missing hash", async () => {
  const { order } = await initiated();
  const payload = signedCallback(order);
  delete payload.hash;
  const res = await postForm("/api/payment/payu/callback", payload);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Invalid PayU response" });
  assert.notEqual(orders.get(order.id).payuReturnVerified, true);
});

test("callback rejects an invalid reverse hash", async () => {
  const { order } = await initiated();
  const payload = signedCallback(order, {});
  payload.hash = "a".repeat(128);
  const res = await postForm("/api/payment/payu/callback", payload);
  assert.equal(res.status, 400);
  assert.equal(orders.get(order.id).status, "pending");
});

test("callback rejects a tampered amount (hash fails first)", async () => {
  const { order } = await initiated();
  const payload = signedCallback(order);
  payload.amount = "1.00";
  const res = await postForm("/api/payment/payu/callback", payload);
  assert.equal(res.status, 400);
  assert.notEqual(orders.get(order.id).payuReturnVerified, true);
});

test("callback rejects unknown order", async () => {
  const { order } = await initiated();
  // Signed consistently for an order id that is not in the store.
  const payload = signedCallback(order, { udf1: "FIR-missing" });
  const res = await postForm("/api/payment/payu/callback", payload);
  assert.equal(res.status, 404);
});

test("callback rejects txnid mismatch", async () => {
  const a = await initiated();
  const b = await initiated();
  // Validly signed response for attempt B, pointed at order A.
  const payload = signedCallback(b.order, {
    udf1: a.order.id,
    productinfo: `Firvanra Order ${a.order.id}`,
  });
  const res = await postForm("/api/payment/payu/callback", payload);
  assert.equal(res.status, 400);
  assert.notEqual(orders.get(a.order.id).payuReturnVerified, true);
});

test("callback rejects amount mismatch against order.total", async () => {
  const { order } = await initiated();
  // Signed with a 1.00 amount; the stored total is 849.
  const payload = signedCallback(order, { amount: "1.00" });
  const res = await postForm("/api/payment/payu/callback", payload);
  assert.equal(res.status, 400);
  const stored = orders.get(order.id);
  assert.notEqual(stored.payuReturnVerified, true);
  assert.equal(stored.status, "pending");
});

test("callback rejects merchant-key mismatch", async () => {
  const { order } = await initiated();
  const payload = signedCallback(order, { key: "other_merchant_key" });
  const res = await postForm("/api/payment/payu/callback", payload);
  assert.equal(res.status, 400);
});

test("callback rejects productinfo mismatch", async () => {
  const { order } = await initiated();
  const payload = signedCallback(order, { productinfo: "Firvanra Order SOMETHING-ELSE" });
  const res = await postForm("/api/payment/payu/callback", payload);
  assert.equal(res.status, 400);
});

test("callback rejects a return for an order that never used PayU", async () => {
  const { order } = await initiated();
  order.gateway = "airpay";
  const res = await postForm("/api/payment/payu/callback", signedCallback(order));
  assert.equal(res.status, 400);
});

test("valid success callback records the return but keeps the order pending", async () => {
  const { order } = await initiated();
  const res = await postForm("/api/payment/payu/callback", signedCallback(order));

  assert.equal(res.status, 302);
  const loc = res.headers.get("location");
  assert.ok(loc.startsWith(`${FAKE.FRONTEND_URL}/order/${order.id}?`), loc);
  assert.match(loc, /status=pending/);
  assert.match(loc, /gateway=payu/);
  assert.match(loc, /returnStatus=success/);
  for (const leak of ["hash=", "mihpayid=", "email=", "phone=", FAKE.PAYU_KEY]) {
    assert.ok(!loc.includes(leak), `redirect must not expose ${leak}`);
  }

  const stored = orders.get(order.id);
  assert.equal(stored.payuReturnVerified, true);
  assert.equal(stored.payuReturnStatus, "success");
  assert.equal(stored.payuUnmappedStatus, "captured");
  assert.equal(stored.payuMihpayid, "4039384727");
  assert.equal(stored.payuMode, "CC");
  assert.ok(stored.payuReturnedAt);

  // The core guarantee of Task 3.
  assert.equal(stored.status, "pending");
  assert.notEqual(stored.status, "paid");
  assert.equal(stored.paidAt, undefined);
});

test("valid success callback stores no secret or raw payload", async () => {
  const { order } = await initiated();
  await postForm("/api/payment/payu/callback", signedCallback(order));
  const stored = orders.get(order.id);
  const dump = JSON.stringify(stored);
  assert.ok(!dump.includes(FAKE.PAYU_SALT), "salt must not reach the order");
  assert.ok(!dump.includes(FAKE.PAYU_KEY), "key must not reach the order");
  assert.ok(!("payuHash" in stored) && !("hash" in stored));
  assert.ok(!("payuRawCallback" in stored));
});

test("valid failure callback is recorded without an authoritative final state", async () => {
  const { order } = await initiated();
  const payload = signedCallback(order, { status: "failure", unmappedstatus: "failed" });
  const res = await postForm("/api/payment/payu/callback", payload);

  assert.equal(res.status, 302);
  const loc = res.headers.get("location");
  assert.match(loc, /status=pending/);
  assert.match(loc, /returnStatus=failure/);

  const stored = orders.get(order.id);
  assert.equal(stored.payuReturnVerified, true);
  assert.equal(stored.payuReturnStatus, "failure");
  assert.equal(stored.status, "pending");
  assert.notEqual(stored.status, "paid");
});

test("callback tolerates an absent mihpayid", async () => {
  const { order } = await initiated();
  const payload = signedCallback(order);
  delete payload.mihpayid;
  delete payload.mode;
  const res = await postForm("/api/payment/payu/callback", payload);
  assert.equal(res.status, 302);
  const stored = orders.get(order.id);
  assert.equal(stored.payuReturnVerified, true);
  assert.equal(stored.payuMihpayid, null);
  assert.equal(stored.payuMode, null);
});

test("duplicate identical callback stays safe and idempotent", async () => {
  const { order } = await initiated();
  const payload = signedCallback(order);

  const first = await postForm("/api/payment/payu/callback", payload);
  const snapshot = { ...orders.get(order.id) };

  const second = await postForm("/api/payment/payu/callback", payload);
  assert.equal(first.status, 302);
  assert.equal(second.status, 302);

  const stored = orders.get(order.id);
  assert.equal(stored.payuReturnVerified, true);
  assert.equal(stored.payuReturnStatus, snapshot.payuReturnStatus);
  assert.equal(stored.payuTxnId, snapshot.payuTxnId);
  assert.equal(stored.paymentAttemptedAt, snapshot.paymentAttemptedAt);
  assert.equal(stored.total, snapshot.total);
  assert.equal(stored.status, "pending");
});

test("GET callback returns 405 and processes nothing", async () => {
  const { order } = await initiated();
  const res = await fetch(`${base}/api/payment/payu/callback?udf1=${order.id}&status=success`, {
    redirect: "manual",
  });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
  assert.notEqual(orders.get(order.id).payuReturnVerified, true);
});

// ── regression guards ───────────────────────────────────────────────────────

test("existing AirPay and SabPaisa routes remain registered", () => {
  const paths = router.stack.filter((l) => l.route).map((l) => l.route.path);
  for (const p of [
    "/airpay/initiate", "/airpay/callback", "/airpay/simulate/:orderId",
    "/sabpaisa/initiate", "/sabpaisa/callback", "/sabpaisa/simulate/:orderId",
    "/sabpaisa/webhook",
  ]) {
    assert.ok(paths.includes(p), `route ${p} must still exist`);
  }
  assert.ok(paths.includes("/payu/initiate"));
  assert.ok(paths.includes("/payu/callback"));
});

// ── PayU S2S webhook + Verify Payment reconciliation ────────────────────────
// The Verify Payment API is mocked by intercepting only the PayU verify URL;
// requests to our own localhost test server pass straight through. No request
// to any PayU endpoint is ever made.

const realFetch = globalThis.fetch;
let verifyCalls = [];
let verifyImpl = null;

globalThis.fetch = async (url, init) => {
  if (typeof url === "string" && url.startsWith("https://info.payu.in/")) {
    verifyCalls.push({ url, init });
    if (!verifyImpl) throw new Error("unexpected Verify Payment call");
    return verifyImpl(url, init);
  }
  return realFetch(url, init);
};

after(() => { globalThis.fetch = realFetch; });

function onVerify(impl) {
  verifyCalls = [];
  verifyImpl = impl;
}
const noVerifyExpected = () => { verifyCalls = []; verifyImpl = null; };

const verifyResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
});

/** A Verify Payment body that reconciles cleanly against `order`. */
function verifyBody(order, overrides = {}, keyOverride) {
  const txn = {
    mihpayid: "4039384727",
    txnid: order.payuTxnId,
    amt: "849.00",
    status: "success",
    unmappedstatus: "captured",
    productinfo: `Firvanra Order ${order.id}`,
    udf1: order.id,
    udf2: "", udf3: "", udf4: "", udf5: "",
    mode: "CC",
    bank_ref_num: "909090",
    ...overrides,
  };
  return {
    status: 1,
    msg: "1 out of 1 Transactions Fetched Successfully",
    transaction_details: { [keyOverride || order.payuTxnId]: txn },
  };
}

/** Signed webhook payload — same reverse-hash model as the browser return. */
const signedWebhook = signedCallback;

const postWebhook = (payload) => postForm("/api/payment/payu/webhook", payload);

const postWebhookJson = (payload) =>
  fetch(`${base}/api/payment/payu/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "manual",
  });

// ── rejection before any Verify Payment call ────────────────────────────────

test("webhook rejects a missing hash and never calls Verify Payment", async () => {
  const { order } = await initiated();
  noVerifyExpected();
  const payload = signedWebhook(order);
  delete payload.hash;

  const res = await postWebhook(payload);
  assert.equal(res.status, 400);
  assert.equal(verifyCalls.length, 0);
  assert.notEqual(orders.get(order.id).payuWebhookVerified, true);
  assert.equal(orders.get(order.id).status, "pending");
});

test("webhook rejects an invalid hash and never calls Verify Payment", async () => {
  const { order } = await initiated();
  noVerifyExpected();
  const payload = signedWebhook(order);
  payload.hash = "b".repeat(128);

  const res = await postWebhook(payload);
  assert.equal(res.status, 400);
  assert.equal(verifyCalls.length, 0);
  assert.equal(orders.get(order.id).status, "pending");
});

test("webhook rejects a tampered payload", async () => {
  const { order } = await initiated();
  noVerifyExpected();
  const payload = signedWebhook(order);
  payload.amount = "1.00";

  const res = await postWebhook(payload);
  assert.equal(res.status, 400);
  assert.equal(verifyCalls.length, 0);
});

test("webhook rejects unknown order", async () => {
  const { order } = await initiated();
  noVerifyExpected();
  const res = await postWebhook(signedWebhook(order, { udf1: "FIR-not-here" }));
  assert.equal(res.status, 404);
  assert.equal(verifyCalls.length, 0);
});

test("webhook rejects an order that never used PayU", async () => {
  const { order } = await initiated();
  noVerifyExpected();
  order.gateway = "sabpaisa";
  const res = await postWebhook(signedWebhook(order));
  assert.equal(res.status, 400);
  assert.equal(verifyCalls.length, 0);
  assert.equal(orders.get(order.id).status, "pending");
});

test("webhook rejects txnid mismatch", async () => {
  const a = await initiated();
  const b = await initiated();
  noVerifyExpected();
  // Validly signed for attempt B but aimed at order A.
  const payload = signedWebhook(b.order, {
    udf1: a.order.id,
    productinfo: `Firvanra Order ${a.order.id}`,
  });
  const res = await postWebhook(payload);
  assert.equal(res.status, 400);
  assert.equal(verifyCalls.length, 0);
  assert.equal(orders.get(a.order.id).status, "pending");
});

test("webhook rejects amount mismatch against order.total", async () => {
  const { order } = await initiated({ total: 849 });
  noVerifyExpected();
  const res = await postWebhook(signedWebhook(order, { amount: "1.00" }));
  assert.equal(res.status, 400);
  assert.equal(verifyCalls.length, 0);
  assert.equal(orders.get(order.id).status, "pending");
});

test("webhook rejects productinfo mismatch", async () => {
  const { order } = await initiated();
  noVerifyExpected();
  const res = await postWebhook(signedWebhook(order, { productinfo: "Firvanra Order OTHER" }));
  assert.equal(res.status, 400);
  assert.equal(verifyCalls.length, 0);
});

test("webhook rejects merchant-key mismatch", async () => {
  const { order } = await initiated();
  noVerifyExpected();
  const res = await postWebhook(signedWebhook(order, { key: "other_merchant_key" }));
  assert.equal(res.status, 400);
  assert.equal(verifyCalls.length, 0);
});

// ── Verify Payment drives the decision ──────────────────────────────────────

test("valid webhook calls Verify Payment with the server-stored txnid", async () => {
  const { order } = await initiated();
  onVerify(() => verifyResponse(verifyBody(order)));

  const res = await postWebhook(signedWebhook(order));
  assert.equal(res.status, 200);
  assert.equal(verifyCalls.length, 1);

  const fields = new URLSearchParams(verifyCalls[0].init.body);
  assert.equal(fields.get("command"), "verify_payment");
  assert.equal(fields.get("var1"), orders.get(order.id).payuTxnId);
  assert.equal(verifyCalls[0].init.method, "POST");
});

test("verified success + captured marks the order paid", async () => {
  const { order } = await initiated();
  onVerify(() => verifyResponse(verifyBody(order)));

  const res = await postWebhook(signedWebhook(order));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { received: true, status: "paid" });

  const stored = orders.get(order.id);
  assert.equal(stored.status, "paid");
  assert.ok(stored.paidAt);
  assert.equal(stored.payuVerified, true);
  assert.ok(stored.payuVerifiedAt);
  assert.equal(stored.payuVerifiedStatus, "success");
  assert.equal(stored.payuVerifiedUnmappedStatus, "captured");
  assert.equal(stored.payuVerifiedAmount, "849.00");
  assert.equal(stored.payuMihpayid, "4039384727");
  assert.equal(stored.payuMode, "CC");
  assert.equal(stored.payuBankRefNum, "909090");
  assert.equal(stored.payuWebhookVerified, true);
  assert.ok(stored.payuWebhookReceivedAt);
});

test("success that is not captured stays pending", async () => {
  const { order } = await initiated();
  onVerify(() => verifyResponse(verifyBody(order, { unmappedstatus: "auth" })));

  const res = await postWebhook(signedWebhook(order));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { received: true, status: "pending" });
  const stored = orders.get(order.id);
  assert.equal(stored.status, "pending");
  assert.equal(stored.paidAt, undefined);
});

test("verified failure marks the order failed without paidAt", async () => {
  const { order } = await initiated();
  onVerify(() => verifyResponse(verifyBody(order, { status: "failure", unmappedstatus: "failed" })));

  const res = await postWebhook(signedWebhook(order));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { received: true, status: "failed" });
  const stored = orders.get(order.id);
  assert.equal(stored.status, "failed");
  assert.equal(stored.paidAt, undefined);
  assert.equal(stored.payuVerified, true);
  assert.equal(stored.payuVerifiedStatus, "failure");
});

test("verified pending stays pending", async () => {
  const { order } = await initiated();
  onVerify(() => verifyResponse(verifyBody(order, { status: "pending", unmappedstatus: "pending" })));

  const res = await postWebhook(signedWebhook(order));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { received: true, status: "pending" });
  assert.equal(orders.get(order.id).status, "pending");
});

test("Verify Payment not-found keeps the order pending", async () => {
  const { order } = await initiated();
  onVerify(() => verifyResponse({ status: 1, msg: "No transaction", transaction_details: {} }));

  const res = await postWebhook(signedWebhook(order));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { received: true, status: "pending" });
  const stored = orders.get(order.id);
  assert.equal(stored.status, "pending");
  assert.notEqual(stored.status, "failed");
  assert.equal(stored.payuVerified, undefined);
});

test("Verify Payment network error returns 503 and leaves status unchanged", async () => {
  const { order } = await initiated();
  onVerify(() => { throw new TypeError("fetch failed"); });

  const res = await postWebhook(signedWebhook(order));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.ok(!JSON.stringify(body).includes(FAKE.PAYU_SALT));
  const stored = orders.get(order.id);
  assert.equal(stored.status, "pending");
  assert.equal(stored.payuVerified, undefined);
  assert.equal(stored.paidAt, undefined);
});

test("Verify Payment non-2xx returns 503 and leaves status unchanged", async () => {
  const { order } = await initiated();
  onVerify(() => verifyResponse("Bad Gateway", 502));

  const res = await postWebhook(signedWebhook(order));
  assert.equal(res.status, 503);
  const stored = orders.get(order.id);
  assert.equal(stored.status, "pending");
  assert.equal(stored.payuVerified, undefined);
});

test("unparseable Verify Payment response returns 503 and changes nothing", async () => {
  const { order } = await initiated();
  onVerify(() => verifyResponse("<html>maintenance</html>"));

  const res = await postWebhook(signedWebhook(order));
  assert.equal(res.status, 503);
  assert.equal(orders.get(order.id).status, "pending");
});

// ── Verify Payment reconciliation invariants ────────────────────────────────

test("Verify response amount mismatch does not mark paid", async () => {
  const { order } = await initiated();
  onVerify(() => verifyResponse(verifyBody(order, { amt: "1.00" })));

  const res = await postWebhook(signedWebhook(order));
  assert.equal(res.status, 400);
  const stored = orders.get(order.id);
  assert.equal(stored.status, "pending");
  assert.equal(stored.payuVerified, undefined);
});

test("Verify response with no amt does not mark paid", async () => {
  const { order } = await initiated();
  onVerify(() => {
    const body = verifyBody(order);
    delete body.transaction_details[order.payuTxnId].amt;
    return verifyResponse(body);
  });

  const res = await postWebhook(signedWebhook(order));
  assert.equal(res.status, 400);
  assert.equal(orders.get(order.id).status, "pending");
});

test("Verify response txnid mismatch does not mark paid", async () => {
  const { order } = await initiated();
  // Keyed at our txnid, but the record's own txnid disagrees.
  onVerify(() => verifyResponse(verifyBody(order, { txnid: "PU_SOMETHING_ELSE" })));

  const res = await postWebhook(signedWebhook(order));
  assert.equal(res.status, 400);
  assert.equal(orders.get(order.id).status, "pending");
});

test("Verify response udf1 mismatch does not mark paid", async () => {
  const { order } = await initiated();
  onVerify(() => verifyResponse(verifyBody(order, { udf1: "FIR-other" })));

  const res = await postWebhook(signedWebhook(order));
  assert.equal(res.status, 400);
  assert.equal(orders.get(order.id).status, "pending");
});

test("Verify response productinfo mismatch does not mark paid", async () => {
  const { order } = await initiated();
  onVerify(() => verifyResponse(verifyBody(order, { productinfo: "Firvanra Order OTHER" })));

  const res = await postWebhook(signedWebhook(order));
  assert.equal(res.status, 400);
  assert.equal(orders.get(order.id).status, "pending");
});

test("mihpayid mismatch between webhook and Verify Payment does not mark paid", async () => {
  const { order } = await initiated();
  onVerify(() => verifyResponse(verifyBody(order, { mihpayid: "9999999999" })));

  const res = await postWebhook(signedWebhook(order, { mihpayid: "4039384727" }));
  assert.equal(res.status, 400);
  const stored = orders.get(order.id);
  assert.equal(stored.status, "pending");
  assert.equal(stored.payuVerified, undefined);
});

// ── Verify Payment overrides the webhook's own status ───────────────────────

test("webhook failure + Verify success/captured results in paid", async () => {
  const { order } = await initiated();
  onVerify(() => verifyResponse(verifyBody(order)));

  const res = await postWebhook(signedWebhook(order, { status: "failure", unmappedstatus: "failed" }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { received: true, status: "paid" });
  const stored = orders.get(order.id);
  assert.equal(stored.status, "paid");
  assert.equal(stored.payuWebhookStatus, "failure");
  assert.equal(stored.payuVerifiedStatus, "success");
});

test("webhook success + Verify failure results in failed", async () => {
  const { order } = await initiated();
  onVerify(() => verifyResponse(verifyBody(order, { status: "failure", unmappedstatus: "failed" })));

  const res = await postWebhook(signedWebhook(order, { status: "success" }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { received: true, status: "failed" });
  assert.equal(orders.get(order.id).status, "failed");
});

test("a failed order is corrected to paid when Verify proves the same txnid captured", async () => {
  const { order } = await initiated();
  onVerify(() => verifyResponse(verifyBody(order, { status: "failure", unmappedstatus: "failed" })));
  await postWebhook(signedWebhook(order));
  assert.equal(orders.get(order.id).status, "failed");

  onVerify(() => verifyResponse(verifyBody(order)));
  const res = await postWebhook(signedWebhook(order));
  assert.equal(res.status, 200);
  const stored = orders.get(order.id);
  assert.equal(stored.status, "paid");
  assert.ok(stored.paidAt);
});

// ── idempotency and state safety ────────────────────────────────────────────

test("duplicate paid webhook is idempotent", async () => {
  const { order } = await initiated();
  onVerify(() => verifyResponse(verifyBody(order)));

  const first = await postWebhook(signedWebhook(order));
  assert.equal(first.status, 200);
  const snapshot = { ...orders.get(order.id) };

  const second = await postWebhook(signedWebhook(order));
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { received: true, status: "paid" });

  const stored = orders.get(order.id);
  assert.equal(stored.status, "paid");
  assert.equal(stored.paidAt, snapshot.paidAt, "paidAt must not be reset");
  assert.equal(stored.payuTxnId, snapshot.payuTxnId, "no new txnid may be generated");
  assert.equal(stored.payuMihpayid, snapshot.payuMihpayid);
  assert.equal(stored.payuVerifiedAmount, snapshot.payuVerifiedAmount);
  assert.equal(stored.total, snapshot.total);
});

test("a different transaction cannot overwrite a paid order", async () => {
  const paid = await initiated();
  onVerify(() => verifyResponse(verifyBody(paid.order)));
  await postWebhook(signedWebhook(paid.order));
  const snapshot = { ...orders.get(paid.order.id) };
  assert.equal(snapshot.status, "paid");

  // A validly signed webhook for a different attempt, aimed at the paid order.
  const other = await initiated();
  noVerifyExpected();
  const payload = signedWebhook(other.order, {
    udf1: paid.order.id,
    productinfo: `Firvanra Order ${paid.order.id}`,
  });
  const res = await postWebhook(payload);
  assert.equal(res.status, 400);
  assert.equal(verifyCalls.length, 0);

  const stored = orders.get(paid.order.id);
  assert.equal(stored.status, "paid");
  assert.equal(stored.paidAt, snapshot.paidAt);
  assert.equal(stored.payuTxnId, snapshot.payuTxnId);
});

test("a paid order survives a later browser callback", async () => {
  const { order } = await initiated();
  onVerify(() => verifyResponse(verifyBody(order)));
  await postWebhook(signedWebhook(order));
  assert.equal(orders.get(order.id).status, "paid");

  const res = await postForm("/api/payment/payu/callback", signedCallback(order));
  assert.equal(res.status, 302);
  assert.equal(orders.get(order.id).status, "paid", "the browser return must not regress a paid order");
});

// ── transport shape ─────────────────────────────────────────────────────────

test("webhook accepts a JSON body as well as urlencoded", async () => {
  const { order } = await initiated();
  onVerify(() => verifyResponse(verifyBody(order)));

  const res = await postWebhookJson(signedWebhook(order));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { received: true, status: "paid" });
  assert.equal(orders.get(order.id).status, "paid");
});

test("webhook never redirects and leaks no secrets", async () => {
  const { order } = await initiated();
  onVerify(() => verifyResponse(verifyBody(order)));

  const res = await postWebhook(signedWebhook(order));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("location"), null, "a webhook must never redirect");
  assert.match(res.headers.get("content-type") || "", /application\/json/);

  const text = await res.text();
  assert.ok(!/<html/i.test(text), "no HTML may be returned");
  for (const secret of [FAKE.PAYU_SALT, FAKE.PAYU_KEY, "hash", "mihpayid", "bank_ref_num"]) {
    assert.ok(!text.includes(secret), `webhook response must not expose ${secret}`);
  }

  const stored = orders.get(order.id);
  const dump = JSON.stringify(stored);
  assert.ok(!dump.includes(FAKE.PAYU_SALT), "salt must never reach the order");
  assert.ok(!dump.includes(FAKE.PAYU_KEY), "key must never reach the order");
  for (const bad of ["payuRawVerification", "payuRawWebhook", "hash", "payuHash", "salt"]) {
    assert.ok(!(bad in stored), `order must not store ${bad}`);
  }
});

test("the webhook route is registered alongside the existing gateways", () => {
  const paths = router.stack.filter((l) => l.route).map((l) => l.route.path);
  assert.ok(paths.includes("/payu/webhook"));
  assert.ok(paths.includes("/sabpaisa/webhook"));
  assert.ok(paths.includes("/airpay/callback"));
});
