// Outbound KKChat field-name adapter. Pure: no network, no server.
// Run: node --test services/kkchatFieldAdapter.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { kkchatFieldCaseMode, normalizeKkchatJsonBody } from "./kkchatFieldAdapter.js";

const normalize = (obj) => JSON.parse(normalizeKkchatJsonBody(JSON.stringify(obj)));

test("mode is opt-in: unset, empty and unknown values are passthrough", () => {
  const prior = process.env.AIRPAY2_KKCHAT_FIELD_CASE;
  try {
    for (const v of [undefined, "", "garbage", "upper", "passthrough", "lowercase"]) {
      if (v === undefined) delete process.env.AIRPAY2_KKCHAT_FIELD_CASE;
      else process.env.AIRPAY2_KKCHAT_FIELD_CASE = v;
      assert.equal(kkchatFieldCaseMode(), "passthrough", String(v));
    }
    for (const v of ["uppercase", " UPPERCASE ", "Uppercase"]) {
      process.env.AIRPAY2_KKCHAT_FIELD_CASE = v;
      assert.equal(kkchatFieldCaseMode(), "uppercase", v);
    }
  } finally {
    if (prior === undefined) delete process.env.AIRPAY2_KKCHAT_FIELD_CASE;
    else process.env.AIRPAY2_KKCHAT_FIELD_CASE = prior;
  }
});

test("every known lowercase alias is renamed; values, hash and unknown fields are untouched", () => {
  const input = {
    merchant_id: "222222", orderid: "order-1", ap_transactionid: "ap-1",
    amount: "12.50", transaction_status: "200", transaction_payment_status: "SUCCESS",
    message: "Success", currency_code: "356", chmod: "upi", customer_vpa: "test@upi",
    ap_SecureHash: "123456789", udf1: "untouched", custom_var: "also untouched",
  };
  const snapshot = structuredClone(input);
  assert.deepEqual(normalize(input), {
    MERCID: "222222", TRANSACTIONID: "order-1", APTRANSACTIONID: "ap-1",
    AMOUNT: "12.50", TRANSACTIONSTATUS: "200", TRANSACTIONPAYMENTSTATUS: "SUCCESS",
    MESSAGE: "Success", CURRENCYCODE: "356", CHMOD: "upi", CUSTOMERVPA: "test@upi",
    ap_SecureHash: "123456789", udf1: "untouched", custom_var: "also untouched",
  });
  assert.deepEqual(input, snapshot, "input not mutated");
});

test("alternative merchant id and hash spellings map to MERCID and ap_SecureHash", () => {
  assert.deepEqual(normalize({ MERCHANTID: "1" }), { MERCID: "1" });
  assert.deepEqual(normalize({ mercid: "1" }), { MERCID: "1" });
  assert.deepEqual(normalize({ ap_securehash: "H" }), { ap_SecureHash: "H" });
  assert.deepEqual(normalize({ AP_SECUREHASH: "H" }), { ap_SecureHash: "H" });
});

test("already-uppercase body is unchanged, including order and value types", () => {
  const input = { MERCID: "222222", TRANSACTIONID: "a", APTRANSACTIONID: "b",
    TRANSACTIONSTATUS: 200, TRANSACTIONPAYMENTSTATUS: "SUCCESS", AMOUNT: "0.00",
    ap_SecureHash: "hash", CHECKOUT_TRANSACTION: "N", nested: { a: 1, orderid: "inner" }, risk: [true, null] };
  const raw = JSON.stringify(input);
  assert.equal(normalizeKkchatJsonBody(raw), raw);
});

test("only top-level keys are renamed; nested objects are left as received", () => {
  assert.deepEqual(normalize({ meta: { orderid: "x", amount: 1 } }), { meta: { orderid: "x", amount: 1 } });
});

test("numbers keep their exact source digits (no float rounding)", () => {
  const raw = '{"amount":12.50,"orderid":12345678901234567890,"n":{"v":1e2},"neg":-0.10}';
  assert.equal(normalizeKkchatJsonBody(raw),
    '{"AMOUNT":12.50,"TRANSACTIONID":12345678901234567890,"n":{"v":1e2},"neg":-0.10}');
});

test("an unrecognised key that only resembles an alias is not guessed", () => {
  const input = { OrderId: "a", Amount: "1", merchantid: "2", txn_id: "3", ap_SecureHASH: "4" };
  assert.deepEqual(normalize(input), input);
});

test("equal-valued duplicate aliases collapse into one canonical field", () => {
  assert.deepEqual(
    normalize({ MERCID: "222222", merchant_id: "222222", TRANSACTIONID: "same", orderid: "same" }),
    { MERCID: "222222", TRANSACTIONID: "same" });
});

test("conflicting aliases fail closed and expose names only, never values", () => {
  for (const [body, names] of [
    [{ orderid: "sensitive-order", TRANSACTIONID: "other-sensitive-order" }, ["orderid", "TRANSACTIONID"]],
    [{ ap_SecureHash: "111", ap_securehash: "222" }, ["ap_SecureHash", "ap_securehash"]],
    [{ amount: "1.00", AMOUNT: 1 }, ["amount", "AMOUNT"]], // same number, different type: conflict
    [{ merchant_id: "1", mercid: "2" }, ["merchant_id", "mercid"]],
  ]) {
    assert.throws(() => normalizeKkchatJsonBody(JSON.stringify(body)), (err) =>
      err.code === "KKCHAT_FIELD_ALIAS_CONFLICT" &&
      JSON.stringify(err.field_names) === JSON.stringify(names) &&
      !Object.values(body).some((v) => err.message.includes(String(v))));
  }
});

test("malformed or non-object JSON is rejected", () => {
  for (const input of ["not-json", "", "[]", "null", "10", '"str"', "true"])
    assert.throws(() => normalizeKkchatJsonBody(input), (err) => err.code === "KKCHAT_INVALID_OUTGOING_JSON", input);
});

test("Buffer input works the same as a string", () => {
  const source = Buffer.from(JSON.stringify({ orderid: "x", ap_securehash: "HashValue" }));
  assert.deepEqual(JSON.parse(normalizeKkchatJsonBody(source)), { TRANSACTIONID: "x", ap_SecureHash: "HashValue" });
});

test("a __proto__ key is kept as data, not used as a prototype", () => {
  const out = normalizeKkchatJsonBody('{"__proto__":{"polluted":1},"orderid":"x"}');
  assert.equal(out, '{"__proto__":{"polluted":1},"TRANSACTIONID":"x"}');
  assert.equal({}.polluted, undefined);
});
