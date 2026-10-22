// Outbound-only, opt-in field-name normalization for the AirPay 2 → KKChat relay.
//
// AIRPAY2_KKCHAT_FIELD_CASE (read per call):
//   unset / anything else  "passthrough": the outgoing body is exactly what it
//                          was before this module existed.
//   "uppercase"            known AirPay 2 field aliases are renamed to the
//                          uppercase names of AirPay's uppercase callback
//                          structure (the shape of the uppercase JSON body KKChat
//                          received via Postman). Applies to JSON forwarding
//                          only; the form/raw rollback always sends the original
//                          bytes.
//
// The caller runs this ONLY after the inbound callback has passed the CRC32
// integrity check and AirPay's Verify API. The inbound payload is never changed.
//
// Guarantees:
//   - Only key NAMES change, and only for the aliases below. Values are never
//     changed; numbers keep their exact source digits (no float rounding, no
//     "12.50" → "12.5"); ap_SecureHash is never computed or replaced.
//   - Unknown keys (udf*, custom fields, nested objects) are kept as received.
//   - Two aliases of one field with different values fail closed: nothing is
//     sent, rather than silently choosing one.
//
// The uppercase names are not a confirmed KKChat requirement. Keep this off until
// KKChat confirms its handler parses them.

// Exactly the aliases services/airpay2.js extractTxnFields already accepts for
// verification. Nothing is guessed beyond those.
const ALIAS_TO_UPPERCASE = Object.freeze({
  merchant_id: "MERCID",
  MERCHANTID: "MERCID",
  mercid: "MERCID",
  orderid: "TRANSACTIONID",
  ap_transactionid: "APTRANSACTIONID",
  amount: "AMOUNT",
  transaction_status: "TRANSACTIONSTATUS",
  transaction_payment_status: "TRANSACTIONPAYMENTSTATUS",
  message: "MESSAGE",
  currency_code: "CURRENCYCODE",
  chmod: "CHMOD",
  customer_vpa: "CUSTOMERVPA",
  ap_securehash: "ap_SecureHash",
  AP_SECUREHASH: "ap_SecureHash",
});

/** "uppercase" only when explicitly configured; otherwise "passthrough". */
export function kkchatFieldCaseMode() {
  return (process.env.AIRPAY2_KKCHAT_FIELD_CASE || "").trim().toLowerCase() === "uppercase"
    ? "uppercase" : "passthrough";
}

function fail(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  return Object.assign(err, extra);
}

// Numbers are kept as their source text, so re-serializing cannot alter them.
function keepNumberSource(_key, value, context) {
  if (typeof value !== "number") return value;
  if (typeof JSON.rawJSON === "function" && context?.source !== undefined) return JSON.rawJSON(context.source);
  // Runtime without source access: refuse a number that would not round-trip.
  if (context?.source !== undefined && String(value) !== context.source)
    throw fail("KKCHAT_UNSAFE_NUMBER", "Outgoing KKChat JSON has a number that cannot be preserved");
  return value;
}

/**
 * Rename known AirPay 2 aliases in an outgoing KKChat JSON body.
 * @param {Buffer|string} jsonBody the JSON request body built for KKChat
 * @returns {string} the normalized JSON body
 * @throws {Error} code KKCHAT_FIELD_ALIAS_CONFLICT (err.field_names: names only,
 *   never values), KKCHAT_INVALID_OUTGOING_JSON or KKCHAT_UNSAFE_NUMBER
 */
export function normalizeKkchatJsonBody(jsonBody) {
  const text = Buffer.isBuffer(jsonBody) ? jsonBody.toString("utf8") : String(jsonBody);
  let source;
  try { source = JSON.parse(text, keepNumberSource); }
  catch (err) {
    if (err?.code) throw err;
    throw fail("KKCHAT_INVALID_OUTGOING_JSON", "Outgoing KKChat JSON could not be parsed");
  }
  if (!source || typeof source !== "object" || Array.isArray(source) || JSON.isRawJSON?.(source))
    throw fail("KKCHAT_INVALID_OUTGOING_JSON", "Outgoing KKChat JSON must be an object");

  const out = Object.create(null);
  const from = Object.create(null); // output key -> the input key that set it
  for (const [key, value] of Object.entries(source)) {
    const target = Object.hasOwn(ALIAS_TO_UPPERCASE, key) ? ALIAS_TO_UPPERCASE[key] : key;
    if (Object.hasOwn(out, target)) {
      // Equal duplicates collapse into one; different values fail closed.
      if (JSON.stringify(out[target]) !== JSON.stringify(value))
        throw fail("KKCHAT_FIELD_ALIAS_CONFLICT", "Conflicting AirPay aliases in outgoing KKChat request",
          { field_names: [from[target], key] });
      continue;
    }
    out[target] = value;
    from[target] = key;
  }
  return JSON.stringify(out);
}
