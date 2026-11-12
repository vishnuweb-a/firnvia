// Run with: node --test src/hdfc.payment.test.js   (from frontend/)
import test from "node:test";
import assert from "node:assert/strict";
import {
  PAYMENT_PROVIDERS, DEFAULT_PAYMENT_PROVIDER, HDFC_UPI_PROVIDER,
  checkoutProviders, handleCheckoutResult, isValidProvider, providerName,
} from "./utils/payment.js";

test("HDFC hidden unless the backend reports it enabled", () => {
  assert.deepEqual(checkoutProviders().map((p) => p.id), ["airpay", "airpay_2", "sabpaisa", "payu"]);
  assert.deepEqual(checkoutProviders({ hdfcEnabled: false }), PAYMENT_PROVIDERS);
  assert.deepEqual(checkoutProviders({ hdfcEnabled: true }).map((p) => p.id),
    ["airpay", "airpay_2", "sabpaisa", "payu", "hdfc"]);
});

test("HDFC option label and existing default preserved", () => {
  assert.equal(HDFC_UPI_PROVIDER.name, "UPI — HDFC");
  assert.equal(providerName("hdfc"), "UPI — HDFC");
  assert.ok(isValidProvider("hdfc"));
  assert.equal(DEFAULT_PAYMENT_PROVIDER, "airpay");
});

test("HDFC initiate response routes to a redirect, URL untouched", () => {
  const seen = [];
  const url = "https://smartgateway.hdfc.bank.in/orders/ordeh_x/payment-page";
  assert.equal(handleCheckoutResult({ provider: "hdfc", type: "redirect", checkoutUrl: url },
    { navigate: (u) => seen.push(u) }), "redirect");
  assert.deepEqual(seen, [url]);
});
