// Run with: node --test src/isgpay.payment.test.js   (from frontend/)
import test from "node:test";
import assert from "node:assert/strict";
import {
  PAYMENT_PROVIDERS, DEFAULT_PAYMENT_PROVIDER, ISGPAY_PROVIDER,
  checkoutProviders, handleCheckoutResult, isValidProvider, providerName,
} from "./utils/payment.js";

test("ISGPay hidden unless the backend reports it enabled; others unchanged", () => {
  assert.deepEqual(checkoutProviders(), PAYMENT_PROVIDERS);
  assert.deepEqual(checkoutProviders({ isgpayEnabled: false }), PAYMENT_PROVIDERS);
  assert.deepEqual(checkoutProviders({ isgpayEnabled: true }).map((p) => p.id),
    ["airpay", "airpay_2", "sabpaisa", "payu", "isgpay"]);
  assert.deepEqual(checkoutProviders({ hdfcEnabled: true, isgpayEnabled: true }).map((p) => p.id),
    ["airpay", "airpay_2", "sabpaisa", "payu", "hdfc", "isgpay"]);
});

test("ISGPay label, id and unchanged default", () => {
  assert.equal(ISGPAY_PROVIDER.name, "ISGPay (UAT)");
  assert.equal(providerName("isgpay"), "ISGPay (UAT)");
  assert.ok(isValidProvider("isgpay"));
  assert.equal(DEFAULT_PAYMENT_PROVIDER, "airpay");
});

test("ISGPay create response submits a POST form with fields verbatim (Base64 '+/=' intact)", () => {
  const seen = [];
  const result = { provider: "isgpay", type: "form", method: "POST",
    action: "https://sandbox.isgpay.com/ISGPay-Genius/request.action",
    fields: { MerchantId: "100000020000001", TerminalId: "CG000001", BankId: "000004", EncData: "ab+/cd==" } };
  assert.equal(handleCheckoutResult(result, { submitForm: (f) => seen.push(f) }), "form");
  assert.deepEqual(seen, [{ action: result.action, method: "POST", fields: result.fields }]);
});
