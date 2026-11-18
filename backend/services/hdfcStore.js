// Durable HDFC transaction store — the Supabase project dedicated to HDFC
// (hdfc_orders / hdfc_payment_attempts / hdfc_order_items / hdfc_status_history).
//
// Server-only: PostgREST with the server secret key (service_role). The key is
// read per call, never logged, never returned. No other gateway touches this.
//
// HDFC_DB_ENABLED=true turns it on (default off: HDFC stays purely in-memory,
// exactly as before). Requires migration 20261118010000_hdfc_persistence.sql.
//
// Stored: amounts, statuses, ids, method type/name, timestamps, product snapshot.
// Never stored: card numbers, CVV, VPA, email, phone, names, raw provider bodies.

import axios from "axios";
import { getProduct } from "../data/products.js";

const TIMEOUT_MS = 8000;
const env = (n) => (process.env[n] || "").trim();

export const hdfcDbEnabled = () => env("HDFC_DB_ENABLED").toLowerCase() === "true";

/** code: not_configured | unavailable | conflict | unresolved | paid | mismatch | not_found | invalid */
export class HdfcStoreError extends Error {
  constructor(code) { super(`hdfc store: ${code}`); this.code = code; }
}

// Function exceptions (P0001) -> stable codes.
const RPC_ERRORS = {
  hdfc_attempt_conflict: "conflict", hdfc_attempt_unresolved: "unresolved", hdfc_order_paid: "paid",
  hdfc_order_mismatch: "mismatch", hdfc_items_total_mismatch: "mismatch", hdfc_attempt_not_found: "not_found",
};

async function rest(method, path, body, prefer) {
  const url = env("SUPABASE_URL").replace(/\/+$/, "");
  const key = env("SUPABASE_SECRET_KEY") || env("SUPABASE_SERVICE_ROLE_KEY");
  if (!/^https:\/\/[^/]+$/.test(url) || !key) throw new HdfcStoreError("not_configured");
  const opts = { timeout: TIMEOUT_MS, headers: { apikey: key, Authorization: `Bearer ${key}`,
    "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) } };
  const full = `${url}/rest/v1${path}`;
  try {
    const res = method === "get" ? await axios.get(full, opts) : await axios[method](full, body, opts);
    return res.data;
  } catch (err) {
    const msg = err?.response?.data?.message;
    if (RPC_ERRORS[msg]) throw new HdfcStoreError(RPC_ERRORS[msg]);
    if (err?.response?.data?.code === "23505") throw new HdfcStoreError("conflict"); // unique hdfc_order_id / attempt_number
    // Status/code only — the request carried the key.
    console.error("[hdfc store]", method, path.split("?")[0], err?.response?.status ?? err?.code ?? "error", err?.response?.data?.code || "");
    throw new HdfcStoreError("unavailable");
  }
}

// ── value normalisation (matches the table CHECKs) ──────────────────────────
const printable = (v, n) => v === undefined || v === null || v === "" ? null :
  String(v).replace(/[^\x20-\x7E]/g, "").slice(0, n) || null;
export const dbStatus = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 40) || "UNKNOWN";
const methodType = (t) => { const s = String(t || "").toUpperCase(); return s === "UPI" || s === "CARD" ? s : "UNKNOWN"; };
const iso = (v) => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const reasonCode = (s) => s ? String(s).toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40) : null;

// ── rows -> the in-memory order shape the HDFC routes already use ───────────
function attemptFromRow(r) {
  return {
    attemptNumber: r.attempt_number,
    hdfcOrderId: r.hdfc_order_id,
    providerOrderRef: r.provider_order_ref,
    customerId: r.customer_ref,
    amount: Number(r.transaction_amount).toFixed(2),
    currency: r.currency,
    allowedMethods: r.allowed_payment_methods || ["UPI"],
    providerStatus: r.transaction_status,
    providerStatusId: r.hdfc_status_id,
    paymentMethodType: r.payment_method_type === "UNKNOWN" ? null : r.payment_method_type,
    paymentMethod: r.payment_method,
    txnId: r.hdfc_transaction_id,
    errorCode: r.error_code,
    verified: Boolean(r.verified_at),
    verifiedAt: r.verified_at,
    sessionError: r.session_error,
    conflictReason: r.conflict_reason,
    createdAt: r.created_at,
  };
}

function orderFromRow(r) {
  const attempts = (r.hdfc_payment_attempts || []).map(attemptFromRow).sort((a, b) => a.attemptNumber - b.attemptNumber);
  const paid = attempts.find((a) => a.verified);
  const last = attempts[attempts.length - 1];
  return {
    id: r.website_order_id,
    items: (r.hdfc_order_items || []).map((i) => ({ id: i.sku, title: i.product_name, price: Number(i.unit_price), qty: i.quantity })),
    total: Number(r.expected_amount),
    status: r.order_status,
    gateway: "hdfc",
    hdfcAttempts: attempts,
    hdfcOrderId: last?.hdfcOrderId,
    ...(paid ? { hdfcPaidOrderId: paid.hdfcOrderId, hdfcTxnId: paid.txnId, paidAt: paid.verifiedAt, paidAmount: paid.amount } : {}),
    createdAt: r.created_at,
  };
}

const ORDER_SELECT = "select=*,hdfc_order_items(*),hdfc_payment_attempts(*)";

/** The stored order (by website or HDFC order id), or null. Throws HdfcStoreError. */
export async function loadHdfcOrder({ websiteOrderId, hdfcOrderId }) {
  if (!websiteOrderId && hdfcOrderId) {
    const rows = await rest("get", `/hdfc_payment_attempts?hdfc_order_id=eq.${encodeURIComponent(hdfcOrderId)}&select=hdfc_orders(website_order_id)`);
    websiteOrderId = rows?.[0]?.hdfc_orders?.website_order_id;
  }
  if (!websiteOrderId) return null;
  const rows = await rest("get", `/hdfc_orders?website_order_id=eq.${encodeURIComponent(websiteOrderId)}&${ORDER_SELECT}`);
  return rows?.[0] ? orderFromRow(rows[0]) : null;
}

/**
 * Load from the store and merge into the in-memory map. Stored state wins
 * (status, attempts); memory keeps what the store never holds (buyer, throttle
 * timestamps). Returns the merged order, or null if not stored.
 */
export async function hydrateHdfcOrder(map, ref) {
  const stored = await loadHdfcOrder(ref);
  if (!stored) return null;
  const cur = map.get(stored.id);
  if (!cur) { map.set(stored.id, stored); return stored; }
  const prev = new Map((cur.hdfcAttempts || []).map((a) => [a.hdfcOrderId, a]));
  const { items, total, createdAt, ...state } = stored; // keep the live cart object
  Object.assign(cur, state, { hdfcAttempts: stored.hdfcAttempts.map((a) => ({ ...prev.get(a.hdfcOrderId), ...a })) });
  if (!cur.items?.length) Object.assign(cur, { items, total });
  return cur;
}

/**
 * Write-ahead: persist the order, its product snapshot and the new attempt
 * BEFORE the HDFC session is created. Throws HdfcStoreError.
 * @returns {Promise<number>} attempt number
 */
export async function beginHdfcAttempt(order, prep, cfg) {
  const items = (order.items || []).map((l) => {
    const type = getProduct(l.id)?.type; // catalog fact, never invented
    if (!type || !l.title || !(l.qty > 0) || typeof l.price !== "number") throw new HdfcStoreError("invalid");
    return { product_name: String(l.title).slice(0, 200), product_type: type, sku: String(l.id).slice(0, 64),
      quantity: l.qty, unit_price: l.price };
  });
  const last = order.hdfcAttempts?.[order.hdfcAttempts.length - 1];
  const r = await rest("post", "/rpc/hdfc_begin_attempt", { p: {
    website_order_id: order.id, merchant_id: cfg.merchantId, expected_amount: prep.amount,
    transaction_amount: prep.amount, gateway_environment: cfg.env, customer_ref: prep.customerId,
    allowed_payment_methods: prep.allowedMethods, hdfc_order_id: prep.hdfcOrderId,
    expected_previous_attempt: last?.attemptNumber ?? 0, items,
  } });
  return r?.attempt_number;
}

/** Non-status facts about an attempt (session outcome). Throws HdfcStoreError. */
export async function patchHdfcAttempt(hdfcOrderId, { providerOrderRef, sessionError }) {
  const body = {};
  if (providerOrderRef !== undefined) body.provider_order_ref = printable(providerOrderRef, 128);
  if (sessionError !== undefined) body.session_error = reasonCode(sessionError);
  await rest("patch", `/hdfc_payment_attempts?hdfc_order_id=eq.${encodeURIComponent(hdfcOrderId)}`, body, "return=minimal");
}

/**
 * Persist an Order-Status-verified attempt state. `expectedStatus` is the
 * status this instance last saw; if another writer moved it, nothing changes.
 * @returns {Promise<{applied:boolean, changed?:boolean}>} Throws HdfcStoreError.
 */
export async function persistHdfcStatus(order, attempt, record, expectedStatus, source) {
  const status = dbStatus(attempt.providerStatus);
  const reason = attempt.duplicateCharge ? "duplicate_charge" : attempt.nonUpiPayment ? "non_upi"
    : attempt.mismatchReason ? `mismatch_${attempt.mismatchReason}`
    : attempt.verified && status !== "CHARGED" ? "refunded_after_charge" : null;
  return rest("post", "/rpc/hdfc_apply_status", { p: {
    hdfc_order_id: attempt.hdfcOrderId,
    expected_status: dbStatus(expectedStatus),
    transaction_status: status,
    hdfc_status_id: int(attempt.providerStatusId),
    payment_method_type: attempt.paymentMethodType ? methodType(attempt.paymentMethodType) : null,
    payment_method: printable(record?.payment_method, 64),
    hdfc_transaction_id: printable(attempt.txnId, 128),
    error_code: printable(record?.bank_error_code || record?.error_code, 60),
    provider_created_at: iso(record?.date_created),
    provider_updated_at: iso(record?.last_updated),
    verified: Boolean(attempt.verified && status === "CHARGED"),
    conflicted: Boolean(reason),
    conflict_reason: reasonCode(reason),
    order_status: order.status,
    event_source: source,
  } });
}
