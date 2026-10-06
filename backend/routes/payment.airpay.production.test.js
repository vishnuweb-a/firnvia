// Route tests for the AirPay production safety gates (Task 6, Gate 4 / Step 6).
//
// What is pinned here:
//   1. POST /api/payment/airpay/simulate/:orderId can set an order to "paid"
//      with NO provider verification, so it MUST be unreachable unless
//      NODE_ENV is explicitly development or test. Unset/unknown NODE_ENV is
//      treated as production (fail closed).
//   2. POST /api/payment/airpay/initiate must not hand the frontend a
//      "simulated: true" checkout in production when AirPay is unconfigured —
//      an unreachable gateway is unavailable (503), not successful.
//   3. verifyCallback() fails closed when ap_SecureHash is absent. Previously a
//      missing hash read as "ok", so anyone able to POST the callback could mark
//      an order paid just by omitting the field.
//
// NODE_ENV is read per request in payment.js, so one process can exercise both
// the production and the development case. Fake credentials only; nothing
// external is contacted.
//
// Run: node --test routes/payment.airpay.production.test.js

import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";

// AirPay is deliberately left UNCONFIGURED here: that is the state in which the
// old code returned a simulated checkout. PayU/SabPaisa are irrelevant to these
// routes and are left alone.
for (const k of ["AIRPAY_MERCHANT_ID", "AIRPAY_USERNAME", "AIRPAY_PASSWORD",
                 "AIRPAY_SECRET", "AIRPAY_CLIENT_ID", "AIRPAY_CLIENT_SECRET"]) {
  delete process.env[k];
}

const { orders } = await import("./orders.js");
const router = (await import("./payment.js")).default;
const { verifyCallback } = await import("../services/airpay.js");

let server, base;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use("/api/payment", router);
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  await new Promise((resolve) => server.close(resolve));
});

let seq = 0;
function pendingOrder() {
  const id = `FIR-ap${++seq}`;
  const order = {
    id, total: 849, items: [{ id: "p1", title: "T", price: 849, qty: 1 }],
    buyer: { firstName: "Asha", email: "a@b.c", phone: "9000000000" },
    status: "pending", createdAt: new Date().toISOString(),
  };
  orders.set(order.id, order);
  return order;
}

const simulate = (orderId) =>
  fetch(`${base}/api/payment/airpay/simulate/${orderId}`, { method: "POST" });

const initiate = (orderId) =>
  fetch(`${base}/api/payment/airpay/initiate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId }),
  });

beforeEach(() => { delete process.env.NODE_ENV; });

// ── Gate 4: simulate must be unreachable in production ──────────────────────

test("airpay simulate is blocked when NODE_ENV=production", async () => {
  process.env.NODE_ENV = "production";
  const order = pendingOrder();
  const res = await simulate(order.id);
  assert.equal(res.status, 404);
  assert.equal(orders.get(order.id).status, "pending", "order must not be paid");
  assert.equal(orders.get(order.id).simulated, undefined);
});

test("airpay simulate is blocked when NODE_ENV is unset (fails closed)", async () => {
  const order = pendingOrder();
  const res = await simulate(order.id);
  assert.equal(res.status, 404);
  assert.equal(orders.get(order.id).status, "pending");
});

test("airpay simulate is blocked for an unknown NODE_ENV (fails closed)", async () => {
  for (const env of ["staging", "prod", "PRODUCTION", "dev", ""]) {
    process.env.NODE_ENV = env;
    const order = pendingOrder();
    const res = await simulate(order.id);
    assert.equal(res.status, 404, `NODE_ENV=${env} must not allow simulation`);
    assert.equal(orders.get(order.id).status, "pending", `NODE_ENV=${env}`);
  }
});

test("airpay simulate reveals nothing about whether the order exists", async () => {
  process.env.NODE_ENV = "production";
  const order = pendingOrder();
  const real = await simulate(order.id);
  const missing = await simulate("FIR-does-not-exist");
  assert.equal(real.status, missing.status, "same status for both");
  assert.deepEqual(await real.json(), await missing.json());
});

test("airpay simulate still works in development and test", async () => {
  for (const env of ["development", "test"]) {
    process.env.NODE_ENV = env;
    const order = pendingOrder();
    const res = await simulate(order.id);
    assert.equal(res.status, 200, `NODE_ENV=${env} must allow simulation`);
    const body = await res.json();
    assert.equal(body.status, "paid");
    assert.equal(body.simulated, true);
  }
});

test("airpay simulate on a missing order is 404 in development too", async () => {
  process.env.NODE_ENV = "development";
  const res = await simulate("FIR-nope");
  assert.equal(res.status, 404);
});

// ── Gate 4: no simulated checkout handed out in production ──────────────────

test("airpay initiate returns 503 in production when AirPay is unconfigured", async () => {
  process.env.NODE_ENV = "production";
  const order = pendingOrder();
  const res = await initiate(order.id);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.simulated, undefined, "must not offer a simulated checkout");
  assert.ok(!("fields" in body));
  assert.equal(orders.get(order.id).status, "pending");
});

test("airpay initiate returns 503 when NODE_ENV is unset (fails closed)", async () => {
  const order = pendingOrder();
  const res = await initiate(order.id);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).simulated, undefined);
});

test("airpay initiate error carries no credentials", async () => {
  process.env.NODE_ENV = "production";
  const order = pendingOrder();
  const text = await (await initiate(order.id)).text();
  for (const token of ["AIRPAY_", "privatekey", "encdata", "checksum", "password"]) {
    assert.ok(!text.toLowerCase().includes(token.toLowerCase()),
      `response must not mention ${token}`);
  }
});

test("airpay initiate still simulates in development", async () => {
  process.env.NODE_ENV = "development";
  const order = pendingOrder();
  const res = await initiate(order.id);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).simulated, true);
});

// ── Step 6: callback hash verification fails closed ─────────────────────────

const callbackBody = (overrides = {}) => ({
  orderid: "FIR-cb1",
  ap_transactionid: "AP123",
  amount: "849.00",
  transaction_status: "200",
  message: "success",
  ...overrides,
});

test("a callback with no ap_SecureHash is rejected, not accepted", () => {
  const result = verifyCallback(callbackBody());
  assert.equal(result.ok, false, "a missing hash must never verify");
});

test("a callback with an empty ap_SecureHash is rejected", () => {
  for (const value of ["", "   "]) {
    const result = verifyCallback(callbackBody({ ap_SecureHash: value }));
    assert.equal(result.ok, false, `hash=${JSON.stringify(value)} must be rejected`);
  }
});

test("a callback with a wrong ap_SecureHash is rejected", () => {
  const result = verifyCallback(callbackBody({ ap_SecureHash: "999999999" }));
  assert.equal(result.ok, false);
});

test("a callback carrying the correct ap_SecureHash verifies", () => {
  // Derive the expected value through the same code path, then assert that the
  // matching hash — and only the matching hash — verifies.
  const probe = verifyCallback(callbackBody({ ap_SecureHash: "0" }));
  const result = verifyCallback(callbackBody({ ap_SecureHash: probe.computed }));
  assert.equal(result.ok, true);
  assert.equal(result.paid, true);
  assert.equal(result.orderid, "FIR-cb1");
});

test("an unverified callback cannot mark an order paid through the route", async () => {
  process.env.NODE_ENV = "production";
  const order = pendingOrder();
  const res = await fetch(`${base}/api/payment/airpay/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      orderid: order.id, ap_transactionid: "AP1", amount: "849.00",
      transaction_status: "200", message: "success", // no ap_SecureHash
    }).toString(),
    redirect: "manual",
  });
  assert.ok(res.status >= 300 && res.status < 400, "callback redirects");
  assert.notEqual(orders.get(order.id).status, "paid",
    "an unverified callback must never settle an order");
});
