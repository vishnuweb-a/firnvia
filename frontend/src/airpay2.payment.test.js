// AirPay 2 (second merchant) on the frontend: provider option, initiate
// endpoint, form hand-off, and the Vercel rewrite that keeps the callback URL
// out of the SPA fallback.
// Run with: node --test src/airpay2.payment.test.js   (from frontend/)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { api } from "./api.js";
import { DEFAULT_PAYMENT_PROVIDER, handleCheckoutResult, isValidProvider } from "./utils/payment.js";

function captureFetch(response = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : undefined });
    return { ok: true, json: async () => response };
  };
  return calls;
}

test("airpay_2 is a valid provider; the default stays the original AirPay", () => {
  assert.ok(isValidProvider("airpay_2"));
  assert.equal(DEFAULT_PAYMENT_PROVIDER, "airpay");
});

test("AirPay 2 initiates via its own endpoint with only the orderId", async () => {
  const calls = captureFetch({ type: "form", gateway: "airpay_2", action: "https://x", fields: {} });
  await api.initiatePayment("airpay_2", "FIR-ABC123");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/payment/airpay-2/initiate");
  assert.equal(calls[0].opts.method, "POST");
  assert.deepEqual(calls[0].body, { orderId: "FIR-ABC123" });
});

test("the original AirPay still uses its original endpoint", async () => {
  const calls = captureFetch({});
  await api.initiatePayment("airpay", "FIR-ABC123");
  assert.equal(calls[0].url, "/api/payment/airpay/initiate");
});

test("an AirPay 2 response goes through the existing hosted-form helper verbatim", () => {
  const result = {
    type: "form", gateway: "airpay_2", method: "POST",
    action: "https://payments.airpay.co.in/pay/v4/?token=t",
    fields: { privatekey: "pk", merchant_id: "222222", encdata: "e", checksum: "c" },
  };
  let submitted = null;
  const flow = handleCheckoutResult(result, { submitForm: (p) => { submitted = p; } });
  assert.equal(flow, "form");
  assert.deepEqual(submitted, { action: result.action, method: "POST", fields: result.fields });
});

test("vercel.json proxies the AirPay 2 callback to the API before the SPA fallback", () => {
  const { rewrites } = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  const i = rewrites.findIndex((r) => r.source === "/callback/cpm/arp_firvanra/collection");
  const spa = rewrites.findIndex((r) => r.destination === "/index.html");
  assert.ok(i >= 0, "callback rewrite present");
  assert.equal(rewrites[i].destination, "https://api.firvanra.online/callback/cpm/arp_firvanra/collection");
  assert.ok(i < spa, "must be matched before the SPA catch-all");
  assert.equal(rewrites[spa].source, "/((?!api/).*)", "SPA fallback unchanged");
});
