// AirPay v4 "Simple Transaction" integration (airpay.co.in, India / INR).
// Implements the exact flow from https://docs.airpay.co.in/v4 :
//   OAuth2 token  ->  encrypted transaction form  ->  hosted gateway  ->  callback.
//
// Crypto primitives (per AirPay docs):
//   encryptionKey = md5(username + "~:~" + password)         [AES-256-CBC key]
//   encrypt(json) = ivHex(16) + base64( AES-256-CBC(json) )  [PKCS7 padding]
//   decrypt(resp) = AES-256-CBC( base64(resp[16:]) , iv=resp[0:16] )
//   checksum(obj) = sha256( <values sorted by key, concatenated> + YYYY-MM-DD(IST) )
//   privatekey    = sha256( secret + "@" + username + ":|:" + password )
//   ap_SecureHash = crc32( orderid:apTxnId:amount:txnStatus:message:mid:username )

import crypto from "crypto";
import https from "https";
import axios from "axios";
import CRC32 from "crc-32";

// DEMO-ONLY: when AIRPAY_INSECURE_TLS=true, skip TLS certificate verification
// for the AirPay calls. Use this only to demo the gateway opening when AirPay's
// endpoint serves an expired certificate. REMOVE for production.
const insecureAgent =
  process.env.AIRPAY_INSECURE_TLS === "true"
    ? new https.Agent({ rejectUnauthorized: false })
    : undefined;

const cfg = {
  merchantId: process.env.AIRPAY_MERCHANT_ID || "",
  username: process.env.AIRPAY_USERNAME || "",
  password: process.env.AIRPAY_PASSWORD || "",
  secret: process.env.AIRPAY_SECRET || "", // used only for privatekey
  clientId: process.env.AIRPAY_CLIENT_ID || "",
  clientSecret: process.env.AIRPAY_CLIENT_SECRET || "",
  // AES key: AirPay derives it from username/password. Override only if AirPay
  // explicitly gave you a separate encryption key.
  encryptionKey: process.env.AIRPAY_ENCRYPTION_KEY || "",
  oauthUrl:
    process.env.AIRPAY_OAUTH_URL ||
    "https://kraken.airpay.co.in/airpay/pay/v4/api/oauth2/",
  payUrl: process.env.AIRPAY_PAY_URL || "https://payments.airpay.co.in/pay/v4/",
};

export const airpayConfigured = () =>
  Boolean(cfg.merchantId && cfg.username && cfg.password && cfg.secret && cfg.clientId && cfg.clientSecret);

function encryptionKey() {
  if (cfg.encryptionKey) return cfg.encryptionKey;
  return crypto.createHash("md5").update(`${cfg.username}~:~${cfg.password}`).digest("hex"); // 32 chars
}

// Current date in IST (AirPay servers use IST) as YYYY-MM-DD.
function istDate() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function encrypt(plain) {
  const key = Buffer.from(encryptionKey(), "utf8"); // 32 bytes -> AES-256
  const ivStr = crypto.randomBytes(8).toString("hex"); // 16-char string
  const cipher = crypto.createCipheriv("aes-256-cbc", key, Buffer.from(ivStr, "utf8"));
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]).toString("base64");
  return ivStr + enc;
}

function decrypt(payload) {
  const key = Buffer.from(encryptionKey(), "utf8");
  const ivStr = payload.slice(0, 16);
  const enc = payload.slice(16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, Buffer.from(ivStr, "utf8"));
  const dec = Buffer.concat([decipher.update(Buffer.from(enc, "base64")), decipher.final()]);
  return dec.toString("utf8");
}

function checksum(obj) {
  const concatenated = Object.keys(obj)
    .sort()
    .map((k) => obj[k])
    .join("");
  return crypto.createHash("sha256").update(concatenated + istDate()).digest("hex");
}

function privatekey() {
  return crypto
    .createHash("sha256")
    .update(`${cfg.secret}@${cfg.username}:|:${cfg.password}`)
    .digest("hex");
}

// ---- Step 1: OAuth2 access token ----
export async function getAccessToken() {
  const data = {
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    merchant_id: cfg.merchantId,
    grant_type: "client_credentials",
  };
  const body = new URLSearchParams({
    merchant_id: cfg.merchantId,
    encdata: encrypt(JSON.stringify(data)),
    checksum: checksum(data),
  });

  const res = await axios.post(cfg.oauthUrl, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15000,
    httpsAgent: insecureAgent,
  });

  // Response is encrypted in `response`; some envs return JSON directly.
  let parsed = res.data;
  if (parsed && typeof parsed === "object" && parsed.response) {
    parsed = JSON.parse(decrypt(parsed.response));
  } else if (typeof parsed === "string") {
    try { parsed = JSON.parse(decrypt(parsed)); } catch { parsed = JSON.parse(parsed); }
  }
  const token = parsed?.data?.access_token || parsed?.access_token;
  if (!token) throw new Error(`AirPay OAuth failed: ${JSON.stringify(parsed)}`);
  return token;
}

// ---- Step 2: build the auto-submit form that opens the gateway ----
export async function buildCheckoutForm(order, buyer) {
  const token = await getAccessToken();

  const [firstName, ...rest] = (buyer.firstName || "Customer").trim().split(" ");
  const data = {
    buyer_email: buyer.email,
    buyer_phone: String(buyer.phone),
    buyer_firstname: firstName || "Customer",
    buyer_lastname: buyer.lastName || rest.join(" ") || "NA",
    amount: order.total.toFixed(2),
    orderid: order.id,
    currency_code: "356",
    iso_currency: "INR",
  };

  return {
    action: `${cfg.payUrl}?token=${encodeURIComponent(token)}`,
    method: "POST",
    fields: {
      privatekey: privatekey(),
      merchant_id: cfg.merchantId,
      encdata: encrypt(JSON.stringify(data)),
      checksum: checksum(data),
    },
  };
}

// ---- Step 3: verify the callback AirPay posts to your success URL ----
// Field-name casing can differ by account; we read both v4 (lowercase) and
// legacy (uppercase) names. Confirm against your first sandbox callback.
function pick(b, ...names) {
  for (const n of names) if (b[n] !== undefined && b[n] !== "") return b[n];
  return "";
}

export function verifyCallback(body) {
  const orderid = pick(body, "orderid", "TRANSACTIONID");
  const apTxnId = pick(body, "ap_transactionid", "APTRANSACTIONID");
  const amount = pick(body, "amount", "AMOUNT");
  const txnStatus = pick(body, "transaction_status", "TRANSACTIONSTATUS");
  const message = pick(body, "message", "MESSAGE");
  const received = pick(body, "ap_SecureHash", "ap_securehash");

  // crc32 over colon-joined values; CRC32.str returns signed -> make unsigned.
  const hashInput = [orderid, apTxnId, amount, txnStatus, message, cfg.merchantId, cfg.username].join(":");
  const computed = (CRC32.str(hashInput) >>> 0).toString();

  // FAILS CLOSED. A callback with no ap_SecureHash is unverifiable, not valid:
  // previously a missing hash was treated as "ok", so anyone who could POST to
  // the callback could mark an order paid simply by omitting the hash field.
  const hashOk = Boolean(received) && computed === String(received);
  const paid =
    String(txnStatus) === "200" ||
    String(pick(body, "transaction_payment_status", "TRANSACTIONPAYMENTSTATUS")).toUpperCase() === "SUCCESS";

  return { ok: hashOk, paid, orderid, apTxnId, amount, message, computed, received, raw: body };
}

export const _internals = { encrypt, decrypt, checksum, privatekey, encryptionKey, istDate };
