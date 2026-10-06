// Unit tests for the PayU Hosted Checkout adapter.
// Run: node --test services/payu.test.js
//
// These tests use fake credentials only and make no network requests. Fixtures are
// set before the module is imported, because payu.js snapshots process.env at load.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const FAKE = {
  PAYU_ENV: "production",
  PAYU_KEY: "fake_merchant_key",
  PAYU_SALT: "fake_merchant_salt",
  PAYU_PAYMENT_URL: "https://secure.payu.in/_payment",
  PAYU_VERIFY_URL: "https://info.payu.in/merchant/postservice.php?form=2",
  PUBLIC_BASE_URL: "https://example.com",
};
Object.assign(process.env, FAKE);

const payu = await import("./payu.js");
const {
  payuConfigured, payuPublicConfig, formatPayUAmount, createPayUTxnId,
  buildProductInfo, payuCallbackUrl, generatePaymentHash, generateCommandHash,
  buildPayUCheckout, verifyPayUResponseHash,
} = payu;

const sha512 = (s) => crypto.createHash("sha512").update(s, "utf8").digest("hex");

const order = {
  id: "ORD12345",
  items: [{ sku: "A1", qty: 2 }],
  total: 849,
  buyer: { firstName: "Asha", lastName: "Rao", email: "asha@example.com", phone: "9876543210" },
};

test("production config detection", () => {
  assert.equal(payuConfigured(), true);
  const pub = payuPublicConfig();
  assert.equal(pub.env, "production");
  assert.ok(!("salt" in pub), "public config must not expose the salt");
});

test("amount formatting", () => {
  assert.equal(formatPayUAmount(849), "849.00");
  assert.equal(formatPayUAmount(10), "10.00");
  assert.equal(formatPayUAmount(1299.5), "1299.50");
  assert.equal(formatPayUAmount("250"), "250.00");
});

test("invalid amount rejection", () => {
  for (const bad of [0, -1, -0.01, NaN, Infinity, -Infinity, "abc", "", null, undefined, {}, true]) {
    assert.throws(() => formatPayUAmount(bad), /PayU order amount invalid/,
      `expected rejection for ${String(bad)}`);
  }
});

test("txnid format, length and allowed characters", () => {
  for (let i = 0; i < 200; i++) {
    const txnid = createPayUTxnId(order.id);
    assert.ok(txnid.length <= 25, `too long: ${txnid.length}`);
    assert.match(txnid, /^[A-Za-z0-9_-]+$/);
    assert.ok(txnid.startsWith("PU_"));
  }
  // A long or dirty order id must still produce a compliant txnid.
  const messy = createPayUTxnId("order/9988-7766 very long reference value");
  assert.ok(messy.length <= 25);
  assert.match(messy, /^[A-Za-z0-9_-]+$/);
  assert.throws(() => createPayUTxnId(""), /PayU order id missing/);
});

test("txnids are unique per attempt", () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(createPayUTxnId(order.id));
  assert.equal(seen.size, 500);
});

test("payment hash is deterministic and uses correct UDF delimiters", () => {
  const params = {
    txnid: "PU_ORD12345_abc", amount: "849.00", productinfo: "Firvanra Order ORD12345",
    firstname: "Asha", email: "asha@example.com",
    udf1: "ORD12345", udf2: "", udf3: "", udf4: "", udf5: "",
  };
  const expected = sha512(
    `${FAKE.PAYU_KEY}|PU_ORD12345_abc|849.00|Firvanra Order ORD12345|Asha|asha@example.com` +
    // udf1, then empty udf2..udf5 plus the five reserved slots: ten pipes before the salt.
    `|ORD12345||||||||||${FAKE.PAYU_SALT}`
  );
  const h = generatePaymentHash(params);
  assert.equal(h, expected);
  assert.equal(h, generatePaymentHash(params), "same input must hash identically");
  assert.match(h, /^[0-9a-f]{128}$/);
});

test("checkout environment and production action URL", () => {
  const c = buildPayUCheckout(order);
  assert.equal(c.type, "form");
  assert.equal(c.provider, "payu");
  assert.equal(c.environment, "production");
  assert.equal(c.method, "POST");
  assert.equal(c.action, "https://secure.payu.in/_payment");
});

test("callback is generated from PUBLIC_BASE_URL and trailing slash is normalized", () => {
  assert.equal(payuCallbackUrl(), "https://example.com/api/payment/payu/callback");
  const c = buildPayUCheckout(order);
  assert.equal(c.fields.surl, "https://example.com/api/payment/payu/callback");
  assert.equal(c.fields.furl, c.fields.surl);
});

test("checkout request contains all required fields", () => {
  const f = buildPayUCheckout(order).fields;
  for (const k of ["key", "txnid", "amount", "productinfo", "firstname", "lastname",
                   "email", "phone", "surl", "furl", "udf1", "udf2", "udf3", "udf4",
                   "udf5", "hash"]) {
    assert.ok(k in f, `missing field ${k}`);
  }
  assert.equal(f.amount, "849.00");
  assert.equal(f.productinfo, buildProductInfo(order.id));
  assert.equal(f.email, order.buyer.email);
  assert.match(f.hash, /^[0-9a-f]{128}$/);
});

test("checkout request leaks neither salt nor client secret", () => {
  const f = buildPayUCheckout(order).fields;
  const serialized = JSON.stringify(f);
  assert.ok(!("salt" in f) && !("PAYU_SALT" in f));
  assert.ok(!serialized.includes(FAKE.PAYU_SALT), "salt value present in checkout fields");
  assert.ok(!("client_secret" in f) && !("clientSecret" in f));
  assert.ok(!serialized.includes(FAKE.PAYU_VERIFY_URL));
});

test("udf1 carries the internal order id and udf2..5 stay empty", () => {
  const f = buildPayUCheckout(order).fields;
  assert.equal(f.udf1, order.id);
  assert.equal(f.udf2, "");
  assert.equal(f.udf3, "");
  assert.equal(f.udf4, "");
  assert.equal(f.udf5, "");
});

test("order validation produces safe errors without credentials", () => {
  const cases = [
    [{ ...order, id: "" }, /PayU order id missing/],
    [{ ...order, total: 0 }, /PayU order amount invalid/],
    [{ ...order, buyer: undefined }, /PayU buyer first name missing/],
    [{ ...order, buyer: { ...order.buyer, firstName: "" } }, /PayU buyer first name missing/],
    [{ ...order, buyer: { ...order.buyer, email: "" } }, /PayU buyer email missing/],
    [{ ...order, buyer: { ...order.buyer, phone: "" } }, /PayU buyer phone missing/],
  ];
  for (const [bad, re] of cases) {
    assert.throws(() => buildPayUCheckout(bad), (err) => {
      assert.match(err.message, re);
      assert.ok(!err.message.includes(FAKE.PAYU_SALT), "error message leaked the salt");
      assert.ok(!err.message.includes(FAKE.PAYU_KEY), "error message leaked the key");
      return true;
    });
  }
});

// --- response hash verification -------------------------------------------------

function syntheticResponse(overrides = {}) {
  const r = {
    status: "success", email: "asha@example.com", firstname: "Asha",
    productinfo: "Firvanra Order ORD12345", amount: "849.00",
    txnid: "PU_ORD12345_abc", key: FAKE.PAYU_KEY,
    udf1: "ORD12345", udf2: "", udf3: "", udf4: "", udf5: "",
    ...overrides,
  };
  const udf = [5, 4, 3, 2, 1].map((i) => r[`udf${i}`] ?? "");
  let seq = [
    FAKE.PAYU_SALT, r.status, "", "", "", "", "", "",
    ...udf, r.email, r.firstname, r.productinfo, r.amount, r.txnid, FAKE.PAYU_KEY,
  ].join("|");
  if (r.additionalCharges !== undefined && String(r.additionalCharges) !== "") {
    seq = `${r.additionalCharges}|${seq}`;
  }
  r.hash = sha512(seq);
  return r;
}

test("valid synthetic response hash passes", () => {
  assert.equal(verifyPayUResponseHash(syntheticResponse()), true);
  assert.equal(verifyPayUResponseHash(syntheticResponse({ status: "failure" })), true);
});

test("tampered response fails", () => {
  const amountTampered = { ...syntheticResponse(), amount: "1.00" };
  assert.equal(verifyPayUResponseHash(amountTampered), false);

  const statusTampered = { ...syntheticResponse({ status: "failure" }), status: "success" };
  assert.equal(verifyPayUResponseHash(statusTampered), false);

  const udfTampered = { ...syntheticResponse(), udf1: "ORD99999" };
  assert.equal(verifyPayUResponseHash(udfTampered), false);

  const foreignKey = { ...syntheticResponse(), key: "someone_elses_key" };
  assert.equal(verifyPayUResponseHash(foreignKey), false);
});

test("missing or malformed response hash fails closed", () => {
  const base = syntheticResponse();
  for (const bad of [undefined, "", "deadbeef", "x".repeat(128), 12345, null]) {
    const r = { ...base, hash: bad };
    assert.equal(verifyPayUResponseHash(r), false, `accepted hash ${String(bad)}`);
  }
  assert.equal(verifyPayUResponseHash(undefined), false);
  assert.equal(verifyPayUResponseHash({}), false);
});

test("missing required response fields fail closed", () => {
  for (const field of ["status", "email", "firstname", "productinfo", "amount", "txnid"]) {
    const r = syntheticResponse();
    delete r[field];
    assert.equal(verifyPayUResponseHash(r), false, `accepted response missing ${field}`);
  }
});

test("additionalCharges response variant works", () => {
  const withCharges = syntheticResponse({ additionalCharges: "10.00" });
  assert.equal(verifyPayUResponseHash(withCharges), true);

  // The base-sequence hash must not be accepted once additionalCharges is present.
  const base = syntheticResponse();
  assert.equal(verifyPayUResponseHash({ ...base, additionalCharges: "10.00" }), false);
  // ...and a tampered charge amount must fail.
  assert.equal(verifyPayUResponseHash({ ...withCharges, additionalCharges: "99.00" }), false);
});

test("command hash is deterministic", () => {
  const h = generateCommandHash("verify_payment", "PU_ORD12345_abc");
  assert.equal(h, sha512(`${FAKE.PAYU_KEY}|verify_payment|PU_ORD12345_abc|${FAKE.PAYU_SALT}`));
  assert.equal(h, generateCommandHash("verify_payment", "PU_ORD12345_abc"));
  assert.match(h, /^[0-9a-f]{128}$/);
});

test("adapter exports no salt and makes no network client available", () => {
  assert.ok(!("salt" in payu), "module must not export the salt");
  assert.ok(!Object.keys(payu).some((k) => /salt/i.test(k)));
});

// ── Verify Payment API (mocked fetch — no network request ever leaves here) ───

const { verifyPayUPayment } = payu;

const realFetch = globalThis.fetch;
let calls = [];

/** Install a fake global fetch. `impl` receives (url, init) and returns a Response-ish. */
function mockFetch(impl) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init);
  };
}
const restoreFetch = () => { globalThis.fetch = realFetch; };

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
});

const TXN = "PU_ORD12345_abcdef";

const successBody = (overrides = {}, key = TXN) => ({
  status: 1,
  msg: "1 out of 1 Transactions Fetched Successfully",
  transaction_details: {
    [key]: {
      mihpayid: "4039384727",
      txnid: TXN,
      amt: "849.00",
      status: "success",
      unmappedstatus: "captured",
      productinfo: "Firvanra Order ORD12345",
      udf1: "ORD12345",
      udf2: "", udf3: "", udf4: "", udf5: "",
      mode: "CC",
      bank_ref_num: "909090",
      net_amount_debit: "849.00",
      ...overrides,
    },
  },
});

/** Parse the form body of the single recorded fetch call. */
const sentFields = () => new URLSearchParams(calls[0].init.body);

test("verify payment posts urlencoded verify_payment to the production verify URL", async (t) => {
  t.after(restoreFetch);
  mockFetch(() => jsonResponse(successBody()));

  const result = await verifyPayUPayment(TXN);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, FAKE.PAYU_VERIFY_URL);
  assert.equal(calls[0].url, "https://info.payu.in/merchant/postservice.php?form=2");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Content-Type"], "application/x-www-form-urlencoded");

  const fields = sentFields();
  assert.equal(fields.get("command"), "verify_payment");
  assert.equal(fields.get("var1"), TXN);
  assert.equal(fields.get("key"), FAKE.PAYU_KEY);
  assert.equal(
    fields.get("hash"),
    sha512(`${FAKE.PAYU_KEY}|verify_payment|${TXN}|${FAKE.PAYU_SALT}`),
  );
});

test("verify payment never sends the salt or a client secret as a field", async (t) => {
  t.after(restoreFetch);
  mockFetch(() => jsonResponse(successBody()));
  await verifyPayUPayment(TXN);

  const raw = calls[0].init.body;
  const fields = sentFields();
  assert.deepEqual([...fields.keys()].sort(), ["command", "hash", "key", "var1"]);
  for (const forbidden of ["salt", "SALT", "client_secret", "clientSecret", "merchant_id"]) {
    assert.equal(fields.get(forbidden), null, `must not send ${forbidden}`);
  }
  assert.ok(!raw.includes(FAKE.PAYU_SALT), "salt must never appear in the request body");
});

test("verify payment sends an abort signal (timeout wiring)", async (t) => {
  t.after(restoreFetch);
  mockFetch(() => jsonResponse(successBody()));
  await verifyPayUPayment(TXN);
  const signal = calls[0].init.signal;
  assert.ok(signal, "an AbortSignal must be supplied");
  assert.equal(typeof signal.aborted, "boolean");
});

test("successful verification is normalized and leaks nothing", async (t) => {
  t.after(restoreFetch);
  mockFetch(() => jsonResponse(successBody()));

  const r = await verifyPayUPayment(TXN);
  assert.deepEqual(r, {
    ok: true,
    found: true,
    txnid: TXN,
    mihpayid: "4039384727",
    paymentStatus: "success",
    unmappedStatus: "captured",
    amount: "849.00",
    productinfo: "Firvanra Order ORD12345",
    udf1: "ORD12345",
    mode: "CC",
    bankRefNum: "909090",
  });
  const dump = JSON.stringify(r);
  assert.ok(!dump.includes(FAKE.PAYU_SALT));
  assert.ok(!dump.includes(FAKE.PAYU_KEY));
  assert.ok(!("hash" in r) && !("transaction_details" in r) && !("raw" in r));
  assert.ok(!("net_amount_debit" in r));
});

test("verification lowercases PayU status values", async (t) => {
  t.after(restoreFetch);
  mockFetch(() => jsonResponse(successBody({ status: "SUCCESS", unmappedstatus: "CAPTURED" })));
  const r = await verifyPayUPayment(TXN);
  assert.equal(r.paymentStatus, "success");
  assert.equal(r.unmappedStatus, "captured");
});

test("unknown transaction becomes found=false", async (t) => {
  t.after(restoreFetch);
  mockFetch(() => jsonResponse({ status: 1, msg: "No transaction", transaction_details: {} }));
  assert.deepEqual(await verifyPayUPayment(TXN), { ok: true, found: false });
});

test("transaction_details keyed by a different txnid becomes found=false", async (t) => {
  t.after(restoreFetch);
  mockFetch(() => jsonResponse(successBody({}, "PU_SOMEONE_ELSE")));
  assert.deepEqual(await verifyPayUPayment(TXN), { ok: true, found: false });
});

test("missing transaction_details fails safely", async (t) => {
  t.after(restoreFetch);
  mockFetch(() => jsonResponse({ status: 1, msg: "something" }));
  const r = await verifyPayUPayment(TXN);
  assert.equal(r.ok, false);
  assert.equal(r.found, undefined);
  assert.ok(r.reason);
});

test("non-2xx HTTP response fails safely", async (t) => {
  t.after(restoreFetch);
  mockFetch(() => jsonResponse("Bad Gateway", 502));
  assert.deepEqual(await verifyPayUPayment(TXN), { ok: false, reason: "http_error" });
});

test("invalid JSON fails safely", async (t) => {
  t.after(restoreFetch);
  mockFetch(() => jsonResponse("<html>maintenance</html>"));
  assert.deepEqual(await verifyPayUPayment(TXN), { ok: false, reason: "invalid_response" });
});

test("network failure fails safely", async (t) => {
  t.after(restoreFetch);
  mockFetch(() => { throw new TypeError("fetch failed"); });
  assert.deepEqual(await verifyPayUPayment(TXN), { ok: false, reason: "network_error" });
});

test("request timeout fails safely", async (t) => {
  t.after(restoreFetch);
  mockFetch(() => {
    const err = new Error("This operation was aborted");
    err.name = "AbortError";
    throw err;
  });
  assert.deepEqual(await verifyPayUPayment(TXN), { ok: false, reason: "timeout" });
});

test("missing amt cannot produce an authorizable amount", async (t) => {
  t.after(restoreFetch);
  const body = successBody();
  delete body.transaction_details[TXN].amt;
  mockFetch(() => jsonResponse(body));

  const r = await verifyPayUPayment(TXN);
  assert.equal(r.found, true);
  assert.equal(r.amount, null, "absent amt must stay null so the route fails closed");
});

test("verify payment rejects a blank txnid without any network call", async (t) => {
  t.after(restoreFetch);
  mockFetch(() => jsonResponse(successBody()));
  for (const bad of [undefined, null, "", "   "]) {
    const r = await verifyPayUPayment(bad);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "txnid_missing");
  }
  assert.equal(calls.length, 0, "no request may be made for a missing txnid");
});
