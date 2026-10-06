// Provider checkout handling. The backend owns every payment parameter —
// amounts, transaction ids, checksums and hashes. Nothing here recomputes,
// reorders or edits a value it was given; the helpers only move the signed
// payload into the browser navigation the provider expects.

export const PAYMENT_PROVIDERS = [
  { id: "airpay", name: "AirPay", blurb: "Secure hosted checkout" },
  { id: "sabpaisa", name: "SabPaisa", blurb: "UPI, cards and net banking" },
  { id: "payu", name: "PayU", blurb: "UPI, cards and net banking" },
];

export const DEFAULT_PAYMENT_PROVIDER = "airpay";

export const isValidProvider = (id) =>
  PAYMENT_PROVIDERS.some((p) => p.id === id);

export const providerName = (id) =>
  PAYMENT_PROVIDERS.find((p) => p.id === id)?.name || "";

/**
 * Build a hidden form from a signed gateway payload and submit it.
 *
 * Field values are written to the inputs exactly as received: a hosted
 * checkout rejects the request if any hashed field differs by a character.
 * Nothing is logged — the payload carries hashes, txn ids and buyer contact.
 */
export function submitHostedPaymentForm({ action, method, fields }) {
  if (!action || typeof action !== "string")
    throw new Error("Missing checkout action");
  if (!fields || typeof fields !== "object")
    throw new Error("Missing checkout fields");

  const form = document.createElement("form");
  form.method = (method || "POST").toUpperCase() === "GET" ? "GET" : "POST";
  form.action = action;
  form.style.display = "none";

  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    // Preserved verbatim. null/undefined would stringify to "null"/"undefined".
    input.value = value == null ? "" : String(value);
    form.appendChild(input);
  }

  document.body.appendChild(form);
  form.submit();

  // The submit navigates away, so this normally never runs. It only matters
  // when navigation is blocked, where a stray form must not linger.
  const cleanup = setTimeout(() => form.remove(), 8000);
  cleanup?.unref?.(); // no-op in a browser; keeps a test runner from waiting

  return form;
}

/**
 * Route a provider initiate response to the right browser flow.
 * `type` is the only provider-specific thing the caller needs to know about.
 */
export function handleCheckoutResult(result, deps = {}) {
  const navigate = deps.navigate || ((url) => window.location.assign(url));
  const submitForm = deps.submitForm || submitHostedPaymentForm;

  if (!result || typeof result !== "object")
    throw new Error("Unsupported payment flow");

  if (result.type === "redirect") {
    if (!result.checkoutUrl || typeof result.checkoutUrl !== "string")
      throw new Error("Unsupported payment flow");
    // Used exactly as issued: the gateway signs the query it built.
    navigate(result.checkoutUrl);
    return "redirect";
  }

  if (result.type === "form") {
    submitForm({
      action: result.action,
      method: result.method,
      fields: result.fields,
    });
    return "form";
  }

  throw new Error("Unsupported payment flow");
}

/** Statuses the backend can report. Only "paid" is a success. */
export const isPaid = (status) => status === "paid";
export const isFailed = (status) => status === "failed";
export const isSettled = (status) => isPaid(status) || isFailed(status);
