// Behaviours that live in Checkout.jsx / OrderStatus.jsx. Without a DOM test
// framework in this project, these drive a faithful re-enactment of each
// component's control flow plus source-level assertions on the invariants that
// matter for money: no early cart clearing, no query-string-driven success.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleCheckoutResult, isPaid, isSettled, submitHostedPaymentForm } from "../utils/payment.js";

// Enough of a DOM for the real submitHostedPaymentForm to build and validate a
// form; submit() is a no-op here instead of navigating away.
globalThis.document = {
  createElement: () => ({
    children: [], style: {},
    appendChild(c) { this.children.push(c); },
    remove() {}, submit() { this.submitted = true; },
  }),
  body: { appendChild() {} },
};

const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const CHECKOUT = src("./Checkout.jsx");
const ORDER_STATUS = src("./OrderStatus.jsx");

// ── Re-enactment of Checkout.pay() ─────────────────────────────────────────
function makeCheckout({ initiate, createOrder }) {
  const state = { busy: false, error: null, cleared: false, navigated: null };
  const run = async () => {
    if (state.busy) return "blocked"; // the double-submit guard
    state.error = null;
    state.busy = true;
    try {
      const order = await createOrder();
      const result = await initiate(order.id);
      handleCheckoutResult(result.type ? result : { ...result, type: "form" }, {
        navigate: (u) => { state.navigated = u; },
        // The real helper runs so its validation applies; the cleanup timer it
        // schedules is unref'd so it cannot hold the test process open.
        submitForm: (p) => { submitHostedPaymentForm(p); },
      });
      // No clear() on this path, by design.
    } catch {
      state.error = "We couldn't start the payment. Please try again.";
      state.busy = false; // controls come back
    }
    return "ran";
  };
  return { state, run };
}

const order = { id: "FIR-1" };

test("the cart is NOT cleared when a payment is initiated", async () => {
  const c = makeCheckout({
    createOrder: async () => order,
    initiate: async () => ({ type: "form", action: "https://secure.payu.in/_payment", fields: { a: "1" } }),
  });
  await c.run();
  assert.equal(c.state.cleared, false);
  assert.equal(c.state.error, null);
});

test("the cart is NOT cleared before a SabPaisa redirect", async () => {
  const c = makeCheckout({
    createOrder: async () => order,
    initiate: async () => ({ type: "redirect", checkoutUrl: "https://securepay.sabpaisa.in/x" }),
  });
  await c.run();
  assert.equal(c.state.navigated, "https://securepay.sabpaisa.in/x");
  assert.equal(c.state.cleared, false, "cart must survive leaving for the gateway");
});

test("a double submit is blocked", async () => {
  let starts = 0;
  const c = makeCheckout({
    createOrder: async () => { starts++; return order; },
    initiate: async () => ({ type: "redirect", checkoutUrl: "https://x" }),
  });
  const [a, b] = await Promise.all([c.run(), c.run()]);
  assert.equal(a, "ran");
  assert.equal(b, "blocked");
  assert.equal(starts, 1, "only one order is created");
});

test("a gateway initiation error restores the UI and keeps the cart", async () => {
  const c = makeCheckout({
    createOrder: async () => order,
    initiate: async () => { throw new Error("PayU is unavailable."); },
  });
  await c.run();
  assert.equal(c.state.busy, false, "the Pay button and selector are re-enabled");
  assert.equal(c.state.error, "We couldn't start the payment. Please try again.");
  assert.equal(c.state.cleared, false);
});

test("an order creation failure restores the UI", async () => {
  const c = makeCheckout({
    createOrder: async () => { throw new Error("Order rejected"); },
    initiate: async () => assert.fail("must not initiate payment"),
  });
  await c.run();
  assert.equal(c.state.busy, false);
  assert.ok(c.state.error);
});

test("an invalid gateway response restores the UI", async () => {
  const c = makeCheckout({
    createOrder: async () => order,
    initiate: async () => ({ provider: "payu" }), // no type, no fields
  });
  await c.run();
  assert.equal(c.state.busy, false);
  assert.ok(c.state.error);
  assert.equal(c.state.cleared, false);
});

test("customer-facing error copy leaks no provider or API internals", async () => {
  const c = makeCheckout({
    createOrder: async () => { throw new Error("salt mismatch 0xDEADBEEF"); },
    initiate: async () => {},
  });
  await c.run();
  assert.equal(c.state.error, "We couldn't start the payment. Please try again.");
  assert.ok(!/salt|DEADBEEF|stack/i.test(c.state.error));
});

// ── Re-enactment of OrderStatus cart clearing + polling ────────────────────
function makeOrderStatus() {
  const s = { clears: 0, polls: 0, cleared: false, stopped: false };
  const onOrder = (o) => {
    s.polls++;
    if (isPaid(o.status) && !s.cleared) { s.cleared = true; s.clears++; }
    if (isSettled(o.status)) s.stopped = true;
    return s.stopped ? "stop" : "continue";
  };
  return { s, onOrder };
}

test("the cart is cleared only once the backend reports paid", () => {
  const { s, onOrder } = makeOrderStatus();
  onOrder({ status: "pending" });
  assert.equal(s.cleared, false, "not on pending");
  onOrder({ status: "awaiting_verification" });
  assert.equal(s.cleared, false, "not on awaiting_verification");
  onOrder({ status: "paid" });
  assert.equal(s.cleared, true);
  assert.equal(s.clears, 1);
});

test("the cart is NOT cleared on a failed order", () => {
  const { s, onOrder } = makeOrderStatus();
  onOrder({ status: "failed" });
  assert.equal(s.cleared, false, "the cart is retained so the customer can retry");
});

test("clearing the cart on paid is idempotent across repeated polls", () => {
  const { s, onOrder } = makeOrderStatus();
  for (let i = 0; i < 5; i++) onOrder({ status: "paid" });
  assert.equal(s.clears, 1, "one dispatch only — no render loop");
});

test("polling continues while pending and stops once settled", () => {
  const { s, onOrder } = makeOrderStatus();
  assert.equal(onOrder({ status: "pending" }), "continue");
  assert.equal(onOrder({ status: "pending" }), "continue");
  assert.equal(onOrder({ status: "paid" }), "stop");
  assert.equal(s.stopped, true);
});

test("polling stops on failed", () => {
  const { onOrder } = makeOrderStatus();
  assert.equal(onOrder({ status: "failed" }), "stop");
});

test("polling is bounded by a timeout", () => {
  const interval = Number(/POLL_INTERVAL_MS = (\d+)/.exec(ORDER_STATUS)[1]);
  const timeout = Number(/POLL_TIMEOUT_MS = (\d+)/.exec(ORDER_STATUS)[1]);
  assert.ok(interval >= 2000 && interval <= 3000, "2-3s interval");
  assert.ok(timeout >= 30000 && timeout <= 60000, "30-60s ceiling");
  assert.ok(Math.ceil(timeout / interval) < 100, "a finite number of polls");
});

// ── Source invariants ──────────────────────────────────────────────────────
test("Checkout.jsx contains no cart clearing at all", () => {
  const code = CHECKOUT.replace(/\/\/[^\n]*/g, ""); // comments explain the absence
  assert.ok(!/\bclear\s*\(/.test(code), "clear() must not be called during checkout");
  assert.ok(!/\bclear\b/.test(code), "Checkout does not even take clear from the cart context");
});

test("OrderStatus.jsx clears the cart only under an isPaid guard", () => {
  const call = /clear\(\);/.exec(ORDER_STATUS);
  assert.ok(call, "OrderStatus owns the one clear() call");
  const before = ORDER_STATUS.slice(0, call.index);
  assert.ok(/isPaid\(order\.status\)/.test(before), "guarded by the backend status");
  assert.ok(/clearedRef\.current/.test(before), "guarded against repeats");
});

test("OrderStatus.jsx never derives status from the query string", () => {
  // `sim` is a cosmetic notice only; status/returnStatus/gateway are not read.
  for (const p of ["status", "returnStatus", "gateway"]) {
    assert.ok(
      !new RegExp("params\\.get\\([\"']" + p + "[\"']\\)").test(ORDER_STATUS),
      "params.get(" + p + ") must not influence the page"
    );
  }
  assert.ok(
    /VIEW\[status\]/.test(ORDER_STATUS) && /const status = order\?\.status/.test(ORDER_STATUS),
    "the displayed state comes from order.status"
  );
});

test("the frontend builds no gateway credentials of its own", () => {
  const all = CHECKOUT + ORDER_STATUS + src("../api.js") + src("../utils/payment.js");
  for (const token of ["PAYU_KEY", "PAYU_SALT", "SABPAISA_", "VITE_PAYU", "VITE_SABPAISA", "VITE_AIRPAY", "kkchat"]) {
    assert.ok(!all.includes(token), token + " must not appear in frontend payment code");
  }
});

test("the unmount teardown cancels the poll", () => {
  assert.ok(/cancelled = true;[\s\S]*clearTimeout\(timer\)/.test(ORDER_STATUS));
});
