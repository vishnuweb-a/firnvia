// Backend-to-backend relay of AirPay 2 callbacks to KKChat.
//
// The destination is a constant. Nothing from the request can change it.
// The body is the callback's ORIGINAL raw bytes with its ORIGINAL content type,
// so KKChat receives exactly what AirPay sent (transaction ids, merchant id,
// status, amount and ap_SecureHash untouched) and can verify it independently.
//
// Delivery is best-effort. There is no durable queue (the app has no database):
// retries are bounded and happen inside the current request only, and the
// dedup memory below is per-process and lost on restart / across Vercel
// instances. A delivery that fails here is lost unless AirPay re-sends the
// callback — which the route encourages by not acknowledging an IPN whose
// forwarding failed.

export const KKCHAT_AIRPAY2_CALLBACK_URL =
  "https://kkchat.in/callback/cpm/arp_firvanra/collection";

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_ATTEMPTS   = 2;
const RETRY_DELAY_MS     = 300;
const DEDUP_LIMIT        = 5000;

// key -> { at } for deliveries KKChat accepted; key -> Promise while in flight.
const delivered = new Map();
const inFlight  = new Map();

function remember(key) {
  delivered.set(key, { at: Date.now() });
  // Bounded: evict oldest (Map preserves insertion order).
  while (delivered.size > DEDUP_LIMIT) delivered.delete(delivered.keys().next().value);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attemptOnce(rawBody, contentType, timeoutMs) {
  try {
    const res = await fetch(KKCHAT_AIRPAY2_CALLBACK_URL, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: rawBody,
      redirect: "manual", // a redirect is not a delivery
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Drain so the connection can be reused; the body is not logged.
    await res.arrayBuffer().catch(() => {});
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
    return { ok: false, status: res.status, retryable: res.status >= 500 || res.status === 429 };
  } catch (err) {
    const timeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    return { ok: false, error: timeout ? "timeout" : "network", retryable: true };
  }
}

/**
 * Forward one verified callback to KKChat.
 *
 * @param {object} p
 * @param {Buffer|string} p.rawBody      exact bytes received from AirPay
 * @param {string}        p.contentType  the callback's Content-Type header
 * @param {string}        p.dedupKey     identity of this event (txn + status)
 * @param {string}        [p.logRef]     non-sensitive id for logs (AirPay txn id)
 * @returns {Promise<{ok:boolean, duplicate?:boolean, status?:number, error?:string, attempts?:number}>}
 */
export async function forwardAirpay2Callback({
  rawBody, contentType, dedupKey, logRef = "",
  timeoutMs = DEFAULT_TIMEOUT_MS, attempts = DEFAULT_ATTEMPTS,
}) {
  if (dedupKey && delivered.has(dedupKey)) {
    console.log("[airpay2 forward] duplicate, already delivered:", logRef);
    return { ok: true, duplicate: true };
  }
  // A browser return and an IPN for the same event can race: share one delivery.
  if (dedupKey && inFlight.has(dedupKey)) {
    const shared = await inFlight.get(dedupKey);
    return { ...shared, duplicate: true };
  }

  const run = (async () => {
    let last;
    for (let i = 1; i <= attempts; i++) {
      last = await attemptOnce(rawBody, contentType, timeoutMs);
      if (last.ok || !last.retryable || i === attempts) {
        last.attempts = i;
        break;
      }
      await sleep(RETRY_DELAY_MS * i);
    }
    if (last.ok) {
      if (dedupKey) remember(dedupKey);
      console.log("[airpay2 forward] delivered:", { ref: logRef, status: last.status, attempts: last.attempts });
    } else {
      console.error("[airpay2 forward] failed:", {
        ref: logRef, status: last.status, error: last.error, attempts: last.attempts,
      });
    }
    const { retryable, ...result } = last;
    return result;
  })();

  if (dedupKey) inFlight.set(dedupKey, run);
  try {
    return await run;
  } finally {
    if (dedupKey) inFlight.delete(dedupKey);
  }
}

/** Test hook: forget every remembered delivery. */
export function _resetForwarderState() {
  delivered.clear();
  inFlight.clear();
}
