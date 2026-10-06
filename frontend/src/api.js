const base = "/api";

async function req(path, opts = {}) {
  const res = await fetch(base + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed (${res.status})`);
  }
  return res.json();
}

// Gateway initiate calls carry the order id and nothing else. The backend
// derives the amount from the stored order and signs every payment field, so
// sending a total, txnid or hash from here would at best be ignored.
const initiators = {
  airpay: (orderId) =>
    req("/payment/airpay/initiate", { method: "POST", body: { orderId } }),
  sabpaisa: (orderId) =>
    req("/payment/sabpaisa/initiate", { method: "POST", body: { orderId } }),
  payu: (orderId) =>
    req("/payment/payu/initiate", { method: "POST", body: { orderId } }),
};

export const api = {
  products: (type) => req(`/products${type ? `?type=${type}` : ""}`),
  createOrder: (items, buyer) =>
    req("/orders", { method: "POST", body: { items, buyer } }),
  getOrder: (id) => req(`/orders/${id}`),
  initiateAirPay: (orderId) => initiators.airpay(orderId),
  initiateSabPaisa: (orderId) => initiators.sabpaisa(orderId),
  initiatePayU: (orderId) => initiators.payu(orderId),
  initiatePayment: (provider, orderId) => {
    const start = initiators[provider];
    if (!start) throw new Error("Unsupported payment provider");
    return start(orderId);
  },
  simulatePayment: (orderId) =>
    req(`/payment/airpay/simulate/${orderId}`, { method: "POST" }),
  contact: (data) => req("/contact", { method: "POST", body: data }),
};
