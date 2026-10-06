// Run with: node --test src/api.payment.test.js   (from frontend/)
import test from "node:test";
import assert from "node:assert/strict";
import { api } from "./api.js";

// Captures what the browser would actually put on the wire.
function captureFetch(response = { ok: true }) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : undefined });
    return { ok: true, json: async () => response };
  };
  return calls;
}

const SECRETISH = [
  "amount", "price", "total", "txnid", "hash", "key", "salt",
  "merchantKey", "checksum", "gatewayUrl", "action", "fields",
];

test("SabPaisa initiate posts only the orderId", async () => {
  const calls = captureFetch({ provider: "sabpaisa", type: "redirect", checkoutUrl: "https://x" });
  await api.initiateSabPaisa("FIR-ABC123");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/payment/sabpaisa/initiate");
  assert.equal(calls[0].opts.method, "POST");
  assert.deepEqual(calls[0].body, { orderId: "FIR-ABC123" });
  assert.deepEqual(Object.keys(calls[0].body), ["orderId"]);
});

test("PayU initiate posts only the orderId", async () => {
  const calls = captureFetch({ type: "form", provider: "payu", action: "https://x", fields: {} });
  await api.initiatePayU("FIR-ABC123");
  assert.equal(calls[0].url, "/api/payment/payu/initiate");
  assert.equal(calls[0].opts.method, "POST");
  assert.deepEqual(calls[0].body, { orderId: "FIR-ABC123" });
});

test("AirPay initiate posts only the orderId", async () => {
  const calls = captureFetch({ simulated: true });
  await api.initiateAirPay("FIR-ABC123");
  assert.equal(calls[0].url, "/api/payment/airpay/initiate");
  assert.deepEqual(calls[0].body, { orderId: "FIR-ABC123" });
});

test("no gateway initiate ever carries an amount or a payment credential", async () => {
  for (const provider of ["airpay", "sabpaisa", "payu"]) {
    const calls = captureFetch({});
    await api.initiatePayment(provider, "FIR-ABC123");
    const keys = Object.keys(calls[0].body);
    for (const forbidden of SECRETISH)
      assert.ok(!keys.includes(forbidden), `${provider} must not send ${forbidden}`);
    assert.deepEqual(keys, ["orderId"], `${provider} sends orderId and nothing else`);
  }
});

test("initiatePayment rejects an unknown provider without calling the network", () => {
  const calls = captureFetch({});
  assert.throws(() => api.initiatePayment("stripe", "FIR-1"), /Unsupported payment provider/);
  assert.equal(calls.length, 0);
});

test("order status is read from GET /api/orders/:id", async () => {
  const calls = captureFetch({ id: "FIR-1", status: "pending" });
  const order = await api.getOrder("FIR-1");
  assert.equal(calls[0].url, "/api/orders/FIR-1");
  assert.ok(!calls[0].opts.method || calls[0].opts.method === "GET");
  assert.equal(order.status, "pending");
});
