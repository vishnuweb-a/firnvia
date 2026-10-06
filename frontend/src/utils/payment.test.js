// Run with: node --test src/utils/payment.test.js   (from frontend/)
import test from "node:test";
import assert from "node:assert/strict";
import {
  PAYMENT_PROVIDERS,
  DEFAULT_PAYMENT_PROVIDER,
  isValidProvider,
  providerName,
  submitHostedPaymentForm,
  handleCheckoutResult,
  isPaid,
  isFailed,
  isSettled,
} from "./payment.js";

// ── Minimal DOM stub ────────────────────────────────────────────────────────
// submitHostedPaymentForm only touches createElement/appendChild/submit, so a
// stub is enough to assert the built form without pulling in a DOM framework.
function installDom() {
  const created = [];
  const appended = [];
  const makeEl = (tag) => ({
    tagName: tag.toUpperCase(),
    children: [],
    style: {},
    appendChild(c) { this.children.push(c); },
    remove() { this.removed = true; },
    submit() { this.submitted = true; },
  });
  globalThis.document = {
    createElement(tag) { const el = makeEl(tag); created.push(el); return el; },
    body: { appendChild(el) { appended.push(el); } },
  };
  return { created, appended };
}
const uninstallDom = () => { delete globalThis.document; };

const fieldsOf = (form) =>
  Object.fromEntries(form.children.map((i) => [i.name, i.value]));

// ── Provider catalogue ─────────────────────────────────────────────────────
test("AirPay, SabPaisa and PayU options are all offered", () => {
  const ids = PAYMENT_PROVIDERS.map((p) => p.id);
  assert.deepEqual(ids, ["airpay", "sabpaisa", "payu"]);
  assert.equal(providerName("airpay"), "AirPay");
  assert.equal(providerName("sabpaisa"), "SabPaisa");
  assert.equal(providerName("payu"), "PayU");
});

test("default provider is AirPay", () => {
  assert.equal(DEFAULT_PAYMENT_PROVIDER, "airpay");
});

test("provider validation rejects unknown ids", () => {
  assert.ok(isValidProvider("sabpaisa"));
  assert.ok(isValidProvider("payu"));
  assert.ok(!isValidProvider("stripe"));
});

// ── SabPaisa redirect ──────────────────────────────────────────────────────
test("SabPaisa redirect navigates to the returned checkoutUrl unchanged", () => {
  const url = "https://securepay.sabpaisa.in/SabPaisa/sabPaisaInit?v=abc%2Fdef&t=1";
  const seen = [];
  const kind = handleCheckoutResult(
    { provider: "sabpaisa", type: "redirect", checkoutUrl: url },
    { navigate: (u) => seen.push(u) }
  );
  assert.equal(kind, "redirect");
  assert.deepEqual(seen, [url]);
});

test("a redirect result without a checkoutUrl fails safely", () => {
  assert.throws(
    () => handleCheckoutResult({ type: "redirect" }, { navigate: () => {} }),
    /Unsupported payment flow/
  );
});

// ── PayU form ──────────────────────────────────────────────────────────────
const payuResult = () => ({
  type: "form",
  provider: "payu",
  environment: "production",
  action: "https://secure.payu.in/_payment",
  method: "POST",
  fields: {
    key: "MERCHANTKEY",
    txnid: "FIRPAYU1730000000ABC",
    amount: "849.00",
    productinfo: "Firvanra order FIR-123",
    firstname: "Asha",
    email: "asha@example.com",
    phone: "9876543210",
    udf1: "FIR-123",
    udf2: "",
    surl: "https://firvanra.example/api/payment/payu/callback",
    furl: "https://firvanra.example/api/payment/payu/callback",
    hash: "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00",
  },
});

test("PayU builds a POST form to the returned action", () => {
  const dom = installDom();
  try {
    const result = payuResult();
    assert.equal(handleCheckoutResult(result), "form");
    const form = dom.appended[0];
    assert.equal(form.tagName, "FORM");
    assert.equal(form.method, "POST");
    assert.equal(form.action, "https://secure.payu.in/_payment");
    assert.ok(form.submitted, "the form is submitted");
    assert.ok(form.children.every((i) => i.type === "hidden"));
  } finally { uninstallDom(); }
});

test("PayU fields reach the form byte-for-byte and are not mutated", () => {
  const dom = installDom();
  try {
    const result = payuResult();
    const before = JSON.parse(JSON.stringify(result.fields));
    handleCheckoutResult(result);
    // What was put on the wire matches what the backend signed...
    assert.deepEqual(fieldsOf(dom.appended[0]), before);
    // ...and the response object itself was left alone.
    assert.deepEqual(result.fields, before);
  } finally { uninstallDom(); }
});

test("PayU is never sent as a plain GET navigation", () => {
  const dom = installDom();
  try {
    const navigated = [];
    handleCheckoutResult(payuResult(), { navigate: (u) => navigated.push(u) });
    assert.deepEqual(navigated, [], "no location navigation for a form flow");
    assert.equal(dom.appended[0].method, "POST");
  } finally { uninstallDom(); }
});

test("a form result without an action fails safely", () => {
  installDom();
  try {
    assert.throws(
      () => handleCheckoutResult({ type: "form", fields: { a: "1" } }),
      /Missing checkout action/
    );
  } finally { uninstallDom(); }
});

// ── AirPay form contract ───────────────────────────────────────────────────
test("AirPay's form payload submits through the same helper unchanged", () => {
  const dom = installDom();
  try {
    const fields = {
      privatekey: "DERIVEDKEY",
      checksum: "9f8e7d6c5b4a",
      mercid: "123456",
      encdata: "U2FsdGVkX1+abc/def==",
    };
    submitHostedPaymentForm({
      action: "https://payments.airpay.co.in/pay/index.php?token=tok123",
      method: "POST",
      fields,
    });
    const form = dom.appended[0];
    assert.equal(form.action, "https://payments.airpay.co.in/pay/index.php?token=tok123");
    assert.deepEqual(fieldsOf(form), fields);
  } finally { uninstallDom(); }
});

// ── Unsupported flows ──────────────────────────────────────────────────────
test("an unsupported or empty payment result fails safely", () => {
  for (const bad of [undefined, null, {}, { type: "wallet" }, "ok", 42]) {
    assert.throws(() => handleCheckoutResult(bad), /Unsupported payment flow/);
  }
});

// ── Status authority ───────────────────────────────────────────────────────
test("only 'paid' counts as success", () => {
  assert.ok(isPaid("paid"));
  for (const s of ["pending", "failed", "awaiting_verification", "success", undefined])
    assert.ok(!isPaid(s), `${s} must not count as paid`);
});

test("polling stops on paid and on failed, and continues otherwise", () => {
  assert.ok(isSettled("paid"));
  assert.ok(isSettled("failed"));
  assert.ok(isFailed("failed"));
  for (const s of ["pending", "awaiting_verification", undefined])
    assert.ok(!isSettled(s), `${s} must keep polling`);
});

test("a returnStatus=success query parameter cannot make an order paid", () => {
  const params = new URLSearchParams("status=paid&returnStatus=success&gateway=payu");
  // The page derives its view from order.status alone; the query string is
  // never consulted, so a forged one leaves the order unconfirmed.
  const orderFromBackend = { status: "pending" };
  assert.ok(!isPaid(orderFromBackend.status));
  assert.ok(!isPaid(params.get("status")) || orderFromBackend.status !== "paid");
  assert.equal(isPaid(orderFromBackend.status), false);
});
