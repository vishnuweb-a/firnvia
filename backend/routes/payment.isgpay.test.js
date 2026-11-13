// ISGPay (UAT): config, paise, signature, AES/EncData, create, return, callback,
// status authority, idempotency. axios is mocked: nothing external is contacted.
// Fake credentials only.
//
// Run: node --test routes/payment.isgpay.test.js

import test, { before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const CFG = {
  ISGPAY_ENABLED: "true",
  ISGPAY_ENV: "uat",
  ISGPAY_BANK_ID: "000004",
  ISGPAY_MERCHANT_ID: "100000020000001",
  ISGPAY_TERMINAL_ID: "CG000001",
  ISGPAY_MCC: "7372",
  ISGPAY_PASS_CODE: "FAKEPASS",
  ISGPAY_SECURE_SECRET: "0F5DD14AE2E38C7EBD8814D29CF6F6F0",
  ISGPAY_ENC_KEY: "ABCDEF0123456789ABCDEF0123456789",
  ISGPAY_SALE_URL: "https://sandbox.isgpay.com/ISGPay-Genius/request.action",
  ISGPAY_STATUS_URL: "https://sandbox.isgpay.com/ISGPay-Genius/Status",
  ISGPAY_RETURN_URL: "https://firvanra.online/api/payments/isgpay/return",
  ISGPAY_CALLBACK_URL: "https://firvanra.online/api/payments/isgpay/callback",
  ISGPAY_CURRENCY: "356",
  ISGPAY_PAY_OPT: "upi",
  ISGPAY_ACCEPTABLE_PAYMENT_MODES: "upi",
};
Object.assign(process.env, CFG, { VERCEL: "1", PUBLIC_BASE_URL: "https://firvanra.online" });

const axios = (await import("axios")).default;
const app = (await import("../server.js")).default;
const { orders } = await import("./orders.js");
const svc = await import("../services/isgpay.js");

// ── ISGPay Status mock ──────────────────────────────────────────────────────
const statusCalls = [];
const book = new Map(); // TxnRefNo -> record fields | function
mock.method(axios, "post", async (url, body, opts) => {
  if (url !== CFG.ISGPAY_STATUS_URL) throw new Error(`unexpected axios.post ${url}`);
  statusCalls.push({ url, body, opts });
  const ref = new URLSearchParams(body).get("TxnRefNo");
  const entry = book.get(ref);
  if (typeof entry === "function") return entry();
  const rec = { BankId: CFG.ISGPAY_BANK_ID, MerchantId: CFG.ISGPAY_MERCHANT_ID, TerminalId: CFG.ISGPAY_TERMINAL_ID,
    TxnRefNo: ref, TxnType: "Status", ResponseCode: "RNF", Message: "Request Not Found", ...(entry || {}) };
  rec.SecureHash = svc.secureHash(rec, CFG.ISGPAY_SECURE_SECRET);
  return { data: new URLSearchParams(rec).toString() };
});

let server, base;
before(async () => {
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { mock.restoreAll(); await new Promise((r) => server.close(r)); });
beforeEach(() => { statusCalls.length = 0; Object.assign(process.env, CFG); });

// ── helpers ─────────────────────────────────────────────────────────────────
let seq = 0;
function localOrder(total = 199) {
  const id = `FIR-i${Date.now().toString(36)}${++seq}`;
  const order = { id, total, items: [{ id: "p", title: "T", price: total, qty: 1 }],
    buyer: { firstName: "Asha", email: "a@b.co", phone: "+91 90000 00000" }, status: "pending", createdAt: new Date().toISOString() };
  orders.set(id, order);
  return order;
}
const postJson = (path, body) => fetch(base + path, { method: "POST", redirect: "manual",
  headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const postForm = (path, fields) => fetch(base + path, { method: "POST", redirect: "manual",
  headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
const cfg = () => svc.isgpayConfig();

async function created(total = 199) {
  const order = localOrder(total);
  const res = await postJson("/api/payments/isgpay/create", { orderId: order.id, amount: 1 });
  assert.equal(res.status, 200);
  return { order, body: await res.json(), ref: order.isgpayAttempts.at(-1).txnRefNo };
}
/** A provider envelope (return/callback) for a TxnRefNo, signed + encrypted like ISGPay. */
function envelope(ref, over = {}, { secret = CFG.ISGPAY_SECURE_SECRET, outer = {} } = {}) {
  const f = { BankId: CFG.ISGPAY_BANK_ID, MerchantId: CFG.ISGPAY_MERCHANT_ID, TerminalId: CFG.ISGPAY_TERMINAL_ID,
    TxnRefNo: ref, Amount: "19900", Currency: "356", ResponseCode: "00", Message: "Transaction Successful", ...over };
  const enc = svc.encryptAes(svc.serializeEncData({ ...f, SecureHash: svc.secureHash(f, secret) }), CFG.ISGPAY_ENC_KEY);
  return { MerchantId: CFG.ISGPAY_MERCHANT_ID, TerminalId: CFG.ISGPAY_TERMINAL_ID, BankId: CFG.ISGPAY_BANK_ID, EncData: enc, ...outer };
}

// ── config ──────────────────────────────────────────────────────────────────
test('ISGPAY_ENABLED="false" (or anything but "true") keeps it disabled', async () => {
  for (const v of ["false", "", "0", "yes", "FALSE"]) {
    process.env.ISGPAY_ENABLED = v;
    assert.deepEqual(await (await fetch(`${base}/api/payments/isgpay/availability`)).json(), { enabled: false });
  }
  process.env.ISGPAY_ENABLED = "TRUE";
  assert.deepEqual(await (await fetch(`${base}/api/payments/isgpay/availability`)).json(), { enabled: true });
});

test("create is refused server-side when disabled or misconfigured; no names/secrets leaked", async () => {
  for (const [k, v] of [["ISGPAY_ENABLED", "false"], ["ISGPAY_ENC_KEY", "short"], ["ISGPAY_ENV", "production"],
    ["ISGPAY_SECURE_SECRET", ""], ["ISGPAY_SALE_URL", "http://insecure.example"]]) {
    Object.assign(process.env, CFG, { [k]: v });
    const res = await postJson("/api/payments/isgpay/create", { orderId: localOrder().id });
    assert.equal(res.status, 503, k);
    const text = await res.text();
    assert.ok(!text.includes("ISGPAY_") && !text.includes(CFG.ISGPAY_SECURE_SECRET));
  }
});

test("BankId keeps leading zeros", () => assert.equal(cfg().bankId, "000004"));

// ── amount ──────────────────────────────────────────────────────────────────
test("₹199 → 19900 paise; decimals exact; invalid rejected", () => {
  assert.equal(svc.toPaise(199), "19900");
  assert.equal(svc.toPaise(1), "100");
  assert.equal(svc.toPaise(1.15), "115");
  assert.equal(svc.toPaise(101.2), "10120");
  for (const bad of [0, -1, NaN, Infinity, "199", null]) assert.equal(svc.toPaise(bad), null);
});

// ── signature ───────────────────────────────────────────────────────────────
test("SecureHash = SHA256(secret + values by ASCII name order) — the PDF §4 example", () => {
  const fields = { MerchantId: "MER123", OrderInfo: "Order456", Amount: "2995" };
  const want = crypto.createHash("sha256").update("0F5DD14AE2E38C7EBD8814D29CF6F6F02995MER123Order456").digest("hex");
  assert.equal(svc.secureHash(fields, "0F5DD14AE2E38C7EBD8814D29CF6F6F0"), want);
  // Not HMAC:
  assert.notEqual(want, crypto.createHmac("sha256", "0F5DD14AE2E38C7EBD8814D29CF6F6F0").update("2995MER123Order456").digest("hex"));
});

test("ordering is ASCII ('Card' < 'CardNum' < 'card'); SecureHash and empties excluded; '0' kept", () => {
  const h = svc.secureHash({ card: "c", CardNum: "B", Card: "A", Empty: "", Nul: null, Zero: "0", SecureHash: "x" }, "S");
  assert.equal(h, crypto.createHash("sha256").update("SAB0c").digest("hex"));
});

test("verifySecureHash: valid passes, tampered/foreign-secret/garbage fails", () => {
  const f = { TxnRefNo: "R1", Amount: "19900" };
  const ok = { ...f, SecureHash: svc.secureHash(f, "S") };
  assert.ok(svc.verifySecureHash(ok, "S"));
  assert.ok(svc.verifySecureHash({ ...ok, SecureHash: ok.SecureHash.toUpperCase() }, "S"));
  assert.ok(!svc.verifySecureHash({ ...ok, Amount: "100" }, "S"));
  assert.ok(!svc.verifySecureHash(ok, "T"));
  assert.ok(!svc.verifySecureHash({ ...f, SecureHash: "zz" }, "S"));
  assert.ok(!svc.verifySecureHash(f, "S"));
});

// ── AES / EncData ───────────────────────────────────────────────────────────
test("AES-256-ECB round-trip is byte-compatible with the supplied kit's Utility.js", () => {
  const plain = "BankId||000004::Amount||19900::SecureHash||ab";
  // Kit: createCipheriv("aes-256-ecb", EncKey /* string */, ''); update(utf8→base64) + final(base64)
  const k = crypto.createCipheriv("aes-256-ecb", CFG.ISGPAY_ENC_KEY, "");
  const kitCipher = k.update(plain, "utf8", "base64") + k.final("base64");
  assert.equal(svc.encryptAes(plain, CFG.ISGPAY_ENC_KEY), kitCipher);
  assert.equal(svc.decryptAes(kitCipher, CFG.ISGPAY_ENC_KEY), plain);
  assert.throws(() => svc.decryptAes(kitCipher, "B".repeat(32)));
});

test("EncData format: Name||value::…, no spaces, SecureHash last, delimiters rejected", () => {
  assert.equal(svc.serializeEncData({ TxnRefNo: "R", Amount: "0", Empty: "", SecureHash: "H" }),
    "Amount||0::TxnRefNo||R::SecureHash||H");
  for (const bad of ["a||b", "a::b", "a:", "a|"])
    assert.throws(() => svc.serializeEncData({ OrderInfo: bad }), svc.IsgpayInputError);
  assert.deepEqual({ ...svc.parseEncData("A||1::B||x|y::C||") }, { A: "1", B: "x|y", C: "" });
  assert.throws(() => svc.parseEncData("A||1::A||2"), /duplicate/);
  assert.throws(() => svc.parseEncData("A||1::junk"), /malformed/);
});

// ── create ──────────────────────────────────────────────────────────────────
test("create: form POST to SALE_URL with exactly MerchantId/TerminalId/BankId/EncData; payload signed", async () => {
  const { order, body, ref } = await created(199);
  assert.equal(body.type, "form");
  assert.equal(body.method, "POST");
  assert.equal(body.action, CFG.ISGPAY_SALE_URL);
  assert.equal(body.attemptId, ref);
  assert.deepEqual(Object.keys(body.fields).sort(), ["BankId", "EncData", "MerchantId", "TerminalId"]);
  assert.equal(body.fields.BankId, "000004");

  const f = svc.parseEncData(svc.decryptAes(body.fields.EncData, CFG.ISGPAY_ENC_KEY));
  assert.ok(svc.verifySecureHash(f, CFG.ISGPAY_SECURE_SECRET));
  assert.equal(f.Amount, "19900"); // from the stored order — client "amount: 1" ignored
  assert.equal(f.Currency, "356");
  assert.equal(f.TxnType, "Pay");
  assert.equal(f.Command, "Pay");
  assert.equal(f.PassCode, "FAKEPASS");
  assert.equal(f.MCC, "7372");
  assert.equal(f.ReturnURL, CFG.ISGPAY_RETURN_URL);
  assert.equal(f.payOpt, "upi");
  assert.equal(f.AcceptablePaymentModes, "upi");
  assert.equal(f.Phone, "9000000000");
  assert.equal(f.OrderInfo, order.id.replace(/[^A-Za-z0-9]/g, ""));
  for (const k of ["Version", "CardNumber", "ExpiryDate", "CardSecurityCode"]) assert.ok(!(k in f), k);
  assert.ok(/^[A-Za-z0-9]{1,40}$/.test(ref));
  assert.equal(order.gateway, "isgpay");
  assert.equal(order.status, "pending");
  assert.equal(statusCalls.length, 0);
});

test("create: unique TxnRefNo per attempt; unknown/paid orders refused", async () => {
  const { order, ref } = await created();
  await postJson("/api/payments/isgpay/create", { orderId: order.id });
  assert.notEqual(order.isgpayAttempts[1].txnRefNo, ref);
  assert.equal((await postJson("/api/payments/isgpay/create", { orderId: "FIR-nope" })).status, 404);
  order.status = "paid";
  assert.equal((await postJson("/api/payments/isgpay/create", { orderId: order.id })).status, 409);
});

// ── return ──────────────────────────────────────────────────────────────────
test("return: verified + Status 00 → paid, 303 to order page with no payload in the URL", async () => {
  const { order, ref } = await created();
  book.set(ref, { ResponseCode: "00", Amount: "19900" });
  const res = await postForm("/api/payments/isgpay/return", envelope(ref));
  assert.equal(res.status, 303);
  const loc = res.headers.get("location");
  assert.equal(loc, `https://firvanra.online/order/${order.id}?status=pending&gateway=isgpay`);
  assert.equal(order.status, "paid");
  assert.equal(statusCalls.length, 1);
  assert.ok(!statusCalls[0].body.includes(" ") && statusCalls[0].url === CFG.ISGPAY_STATUS_URL, "credentials in body, not URL");
});

test("return: signed '00' alone is not success — Status says pending → stays pending", async () => {
  const { order, ref } = await created();
  book.set(ref, { ResponseCode: "STO02" });
  assert.equal((await postForm("/api/payments/isgpay/return", envelope(ref))).status, 303);
  assert.equal(order.status, "pending");
});

test("return: invalid hash rejected before any state change or Status call", async () => {
  const { order, ref } = await created();
  const res = await postForm("/api/payments/isgpay/return", envelope(ref, {}, { secret: "WRONG" }));
  assert.equal(res.status, 400);
  assert.equal(order.status, "pending");
  assert.equal(order.isgpayAttempts[0].returnAt, undefined);
  assert.equal(statusCalls.length, 0);
});

test("return: amount / reference / currency / outer-identity mismatches rejected", async () => {
  const { order, ref } = await created();
  for (const env of [envelope(ref, { Amount: "100" }), envelope(ref, { Currency: "840" }),
    envelope(ref, {}, { outer: { MerchantId: "999" } }), envelope(ref, { TerminalId: "OTHER001" }),
    { ...envelope(ref), EncData: "not-base64!" }]) {
    assert.equal((await postForm("/api/payments/isgpay/return", env)).status, 400);
  }
  // A different, unknown reference: honest "session unavailable".
  const res = await postForm("/api/payments/isgpay/return", envelope("ISGUNKNOWN123"));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "https://firvanra.online/order/session-unavailable?gateway=isgpay");
  assert.equal(order.status, "pending");
  assert.equal(statusCalls.length, 0);
});

test("return: Status amount mismatch never marks paid", async () => {
  const { order, ref } = await created();
  book.set(ref, { ResponseCode: "00", Amount: "100" });
  await postForm("/api/payments/isgpay/return", envelope(ref, { Amount: undefined }));
  assert.equal(order.status, "pending");
});

test("return: un-encoded '+' in EncData (arrives as space) still decrypts", async () => {
  const { order, ref } = await created();
  book.set(ref, { ResponseCode: "00", Amount: "19900" });
  let env;
  for (let i = 0; i < 50 && !env?.EncData.includes("+"); i++) env = envelope(ref, { UDF01: String(i) });
  assert.ok(env.EncData.includes("+"), "fixture has a '+'");
  // '+' left un-percent-encoded, so the form parser turns it into a space.
  const raw = new URLSearchParams(env).toString().replace(/%2B/g, "+");
  const res = await fetch(`${base}/api/payments/isgpay/return`, { method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: raw });
  assert.equal(res.status, 303);
  assert.equal(order.status, "paid");
});

// ── status failures / missing attempt ───────────────────────────────────────
test("Status API network failure / bad hash / garbage → pending, never invented", async () => {
  for (const behaviour of [
    () => { const e = new Error("t"); e.code = "ECONNABORTED"; throw e; },
    () => ({ data: "TxnRefNo=X&ResponseCode=00&SecureHash=" + "0".repeat(64) }),
    () => ({ data: "<html>error</html>" }),
  ]) {
    const { order, ref } = await created();
    book.set(ref, behaviour);
    statusCalls.length = 0;
    const res = await fetch(`${base}/api/payments/isgpay/status/${ref}`);
    const body = await res.json();
    assert.equal(body.status, "pending");
    assert.equal(body.verification, "inconclusive");
    assert.equal(order.status, "pending");
    assert.ok(statusCalls.length >= 1 && statusCalls.length <= 2, "bounded retries");
  }
});

test("status route: missing in-memory attempt → 404 'session unavailable', nothing created", async () => {
  const n = orders.size;
  const res = await fetch(`${base}/api/payments/isgpay/status/ISGGONE0000000000`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).status, "unavailable");
  assert.equal(orders.size, n);
});

test("status route: definitive decline → failed", async () => {
  const { order, ref } = await created();
  book.set(ref, { ResponseCode: "CAN" });
  assert.equal((await (await fetch(`${base}/api/payments/isgpay/status/${ref}`)).json()).status, "failed");
  assert.equal(order.status, "failed");
});

// ── callback ────────────────────────────────────────────────────────────────
test("callback: duplicates are safe — completion runs once, ack returned each time", async () => {
  const { order, ref } = await created();
  book.set(ref, { ResponseCode: "00", Amount: "19900" });
  const r1 = await postForm("/api/payments/isgpay/callback", envelope(ref));
  assert.equal(r1.status, 200);
  assert.deepEqual(await r1.json(), { MerchantId: CFG.ISGPAY_MERCHANT_ID, TerminalId: CFG.ISGPAY_TERMINAL_ID,
    BankId: "000004", Acknowledgement: "Received" });
  const paidAt = order.paidAt;
  assert.equal(order.status, "paid");
  const r2 = await postForm("/api/payments/isgpay/callback", envelope(ref));
  assert.equal(r2.status, 200);
  assert.equal(order.paidAt, paidAt);
  assert.ok(!order.isgpayAttempts[0].duplicateCharge);
});

test("callback: stale failure after success never downgrades", async () => {
  const { order, ref } = await created();
  book.set(ref, { ResponseCode: "00", Amount: "19900" });
  await postForm("/api/payments/isgpay/callback", envelope(ref));
  book.set(ref, { ResponseCode: "05" });
  order.isgpayAttempts[0].lastCheckedAt = 0;
  await postForm("/api/payments/isgpay/callback", envelope(ref, { ResponseCode: "05" }));
  assert.equal(order.status, "paid");
});

test("callback: invalid hash 400, unknown attempt 404, Status down 503 (so ISGPay re-posts)", async () => {
  const { order, ref } = await created();
  assert.equal((await postForm("/api/payments/isgpay/callback", envelope(ref, {}, { secret: "X" }))).status, 400);
  assert.equal((await postForm("/api/payments/isgpay/callback", envelope("ISGNOPE"))).status, 404);
  book.set(ref, () => { throw new Error("down"); });
  assert.equal((await postForm("/api/payments/isgpay/callback", envelope(ref))).status, 503);
  assert.equal(order.status, "pending");
});

test("callback/return work while ISGPAY_ENABLED=false (late results still settle)", async () => {
  const { order, ref } = await created();
  process.env.ISGPAY_ENABLED = "false";
  book.set(ref, { ResponseCode: "00", Amount: "19900" });
  assert.equal((await postForm("/api/payments/isgpay/callback", envelope(ref))).status, 200);
  assert.equal(order.status, "paid");
});

// ── Version (explicit, never automatic) ─────────────────────────────────────
test("Version: absent unless ISGPAY_VERSION is set; then in EncData (hashed), outer form and Status", async () => {
  const a = await created();
  assert.ok(!("Version" in a.body.fields));
  book.set(a.ref, { ResponseCode: "STO02" });
  await fetch(`${base}/api/payments/isgpay/status/${a.ref}`);
  assert.ok(!new URLSearchParams(statusCalls.at(-1).body).has("Version"));

  process.env.ISGPAY_VERSION = "1";
  const b = await created();
  assert.equal(b.body.fields.Version, "1");
  const f = svc.parseEncData(svc.decryptAes(b.body.fields.EncData, CFG.ISGPAY_ENC_KEY));
  assert.equal(f.Version, "1");
  assert.ok(svc.verifySecureHash(f, CFG.ISGPAY_SECURE_SECRET));
  book.set(b.ref, { ResponseCode: "STO02" });
  statusCalls.length = 0;
  await fetch(`${base}/api/payments/isgpay/status/${b.ref}`);
  const sent = Object.fromEntries(new URLSearchParams(statusCalls[0].body));
  assert.equal(sent.Version, "1");
  assert.ok(svc.verifySecureHash(sent, CFG.ISGPAY_SECURE_SECRET), "Version is inside the status hash");
  assert.equal(b.order.isgpayAttempts.length, 1, "no automatic second sale");

  process.env.ISGPAY_VERSION = "v1";
  assert.equal((await postJson("/api/payments/isgpay/create", { orderId: localOrder().id })).status, 503);
  delete process.env.ISGPAY_VERSION;
});

// ── empty HTTP 200 + diagnostics ────────────────────────────────────────────
function captureLogs() {
  const lines = [];
  const spies = ["log", "warn", "error"].map((m) =>
    mock.method(console, m, (...a) => lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "))));
  return { lines, restore: () => spies.forEach((s) => s.mock.restore()) };
}

test("empty HTTP 200 status → inconclusive (empty_response), not retried, not paid", async () => {
  const { order, ref } = await created();
  book.set(ref, () => ({ status: 200, headers: { "content-type": "text/html;charset=UTF-8" }, data: "" }));
  statusCalls.length = 0;
  const r = await svc.reconcileAttempt(order, order.isgpayAttempts[0]);
  assert.deepEqual([r.outcome, r.reason], ["unavailable", "empty_response"]);
  assert.equal(statusCalls.length, 1);
  assert.equal(order.status, "pending");
});

test("detectStatusFormat labels bodies without parsing them", () => {
  assert.equal(svc.detectStatusFormat(""), "empty");
  assert.equal(svc.detectStatusFormat("  \r\n"), "empty");
  assert.equal(svc.detectStatusFormat("<html>"), "html");
  assert.equal(svc.detectStatusFormat('{"a":1}'), "json");
  assert.equal(svc.detectStatusFormat("A||1::B||2"), "pipe");
  assert.equal(svc.detectStatusFormat("A=1&B=2"), "kv");
  assert.equal(svc.detectStatusFormat("MerchantId=1&EncData=x"), "kv_encdata");
  assert.equal(svc.detectStatusFormat("ok"), "other");
});

test("secureHashMatch reports raw vs kit url-decoded variant; acceptance unchanged", () => {
  const f = { TxnRefNo: "R1", Message: "Transaction Successful" };
  const h = svc.secureHash(f, "S");
  assert.equal(svc.secureHashMatch({ ...f, SecureHash: h }, "S"), "raw");
  assert.equal(svc.secureHashMatch({ ...f, Message: "Transaction+Successful", SecureHash: h }, "S"), "url_decoded");
  assert.equal(svc.secureHashMatch({ ...f, SecureHash: h }, "T"), null);
});

test("diagnostics cover sale/return/status and never leak secrets, PassCode, EncData or customer data", async () => {
  const cap = captureLogs();
  let env, order;
  try {
    const c = await created();
    order = c.order;
    book.set(c.ref, () => ({ status: 200, headers: { "content-type": "text/plain" }, data: "" }));
    env = envelope(c.ref);
    await postForm("/api/payments/isgpay/return", env);
    await postForm("/api/payments/isgpay/callback", envelope(c.ref, {}, { secret: "WRONG" }));
  } finally { cap.restore(); }
  const all = cap.lines.join("\n");
  for (const secret of [CFG.ISGPAY_PASS_CODE, CFG.ISGPAY_SECURE_SECRET, CFG.ISGPAY_ENC_KEY, env.EncData,
    "a@b.co", "9000000000", "Asha"])
    assert.ok(!all.includes(secret), `leaked ${secret.slice(0, 6)}…`);

  const ev = (name) => cap.lines.filter((l) => l.startsWith(`[isgpay ${name}]`)).map((l) => JSON.parse(l.slice(l.indexOf("{"))));
  const [sale] = ev("sale_submit");
  assert.equal(sale.amount, "19900");
  assert.equal(sale.endpoint, "/ISGPay-Genius/request.action");
  assert.ok(sale.encFields.includes("PassCode") && sale.encFields.at(-1) === "SecureHash");
  assert.equal(sale.version, "absent");
  const [ret] = ev("return_received");
  assert.deepEqual([ret.decrypt, ret.signature, ret.outerIdentity, ret.innerIdentity, ret.consistency, ret.result],
    ["ok", "raw", "match", "match", "ok", "accepted"]);
  const [cb] = ev("callback_received");
  assert.deepEqual([cb.decrypt, cb.signature, cb.result], ["ok", "invalid", "rejected"]);
  const [req] = ev("status_request");
  assert.equal(req.endpoint, "/ISGPay-Genius/Status");
  assert.deepEqual(req.bodyFields, ["BankId", "MerchantId", "TerminalId", "TxnRefNo", "PassCode", "TxnType", "MCC", "SecureHash"]);
  const [st] = ev("status_response");
  assert.deepEqual([st.httpStatus, st.contentType, st.bytes, st.format, st.signature], [200, "text/plain", 0, "empty", "not_checked"]);
});

test("order-page poll reconciles a pending ISGPay order", async () => {
  const { order, ref } = await created();
  book.set(ref, { ResponseCode: "00", Amount: "19900" });
  const o = await (await fetch(`${base}/api/orders/${order.id}`)).json();
  assert.equal(o.status, "paid");
});
