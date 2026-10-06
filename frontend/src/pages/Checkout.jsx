import { useState } from "react";
import { useNavigate } from "react-router-dom";
import App from "../App.jsx";
import Footer from "../components/Footer.jsx";
import PaymentMethodSelector from "../components/PaymentMethodSelector.jsx";
import { useCart } from "../context/CartContext.jsx";
import { api } from "../api.js";
import {
  DEFAULT_PAYMENT_PROVIDER,
  handleCheckoutResult,
  providerName,
} from "../utils/payment.js";

const inr = (n) => `₹${n.toLocaleString("en-IN")}`;

export default function Checkout() {
  const { items, total } = useCart();
  const navigate = useNavigate();
  const [buyer, setBuyer] = useState({ firstName: "", lastName: "", email: "", phone: "" });
  const [provider, setProvider] = useState(DEFAULT_PAYMENT_PROVIDER);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const change = (e) => setBuyer({ ...buyer, [e.target.name]: e.target.value });

  const pay = async () => {
    if (busy) return; // guards a second click landing before the disable renders
    setError(null);
    if (!buyer.firstName || !buyer.email || !buyer.phone)
      return setError("Please fill name, email, and phone.");
    setBusy(true);
    try {
      const order = await api.createOrder(
        items.map((i) => ({ id: i.id, qty: i.qty })),
        buyer
      );
      const result = await api.initiatePayment(provider, order.id);

      // AirPay without credentials still answers with a simulated checkout.
      if (result.simulated) {
        const simulated = await api.simulatePayment(order.id);
        // The cart is cleared by OrderStatus once the backend reports "paid",
        // not here — see below.
        if (simulated?.status !== "paid")
          throw new Error("Simulated payment did not complete");
        return navigate(`/order/${order.id}?status=pending&sim=1`);
      }

      // AirPay returns a form payload without a `type`; normalise it so the
      // generic handler can route all three providers the same way.
      handleCheckoutResult(result.type ? result : { ...result, type: "form" });

      // Deliberately no clear() here. The customer is leaving for a hosted
      // gateway and may cancel, fail or close the tab; their cart must survive
      // that. It is cleared only against an authoritative "paid" status.
    } catch (e) {
      // Provider/network detail stays in the response — the customer gets copy
      // they can act on.
      setError("We couldn't start the payment. Please try again.");
      setBusy(false);
    }
  };

  const payLabel = busy
    ? `Opening ${providerName(provider)}…`
    : `Pay ${inr(total)} with ${providerName(provider)}`;

  return (
    <App>
      <main className="page">
        <div className="container" style={{ maxWidth: 900 }}>
          <h2 className="section-title">Checkout</h2>
          {items.length === 0 ? (
            <p className="lead">Your cart is empty. <a href="/" style={{ color: "var(--accent-deep)" }}>Browse services</a>.</p>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 30, alignItems: "start" }}>
              <div className="panel">
                <h3 style={{ marginBottom: 18 }}>Billing details</h3>
                {error && <div className="notice err">{error}</div>}
                <div className="field"><label>First name *</label><input name="firstName" value={buyer.firstName} onChange={change} disabled={busy} /></div>
                <div className="field"><label>Last name</label><input name="lastName" value={buyer.lastName} onChange={change} disabled={busy} /></div>
                <div className="field"><label>Email *</label><input name="email" type="email" value={buyer.email} onChange={change} disabled={busy} /></div>
                <div className="field"><label>Phone *</label><input name="phone" value={buyer.phone} onChange={change} disabled={busy} /></div>
              </div>

              <div className="panel">
                <h3 style={{ marginBottom: 14 }}>Order summary</h3>
                {items.map((i) => (
                  <div className="summary-line" key={i.id}>
                    <span>{i.title} × {i.qty}</span>
                    <span>{inr(i.price * i.qty)}</span>
                  </div>
                ))}
                <div className="summary-total" style={{ marginBottom: 22 }}><span>Total</span><span>{inr(total)}</span></div>

                <PaymentMethodSelector value={provider} onChange={setProvider} disabled={busy} />

                <button className="btn btn-accent" style={{ width: "100%", justifyContent: "center" }} disabled={busy} onClick={pay}>
                  {payLabel}
                </button>
                <p style={{ fontSize: "0.8rem", color: "var(--muted)", marginTop: 12, textAlign: "center" }}>
                  You'll be redirected to {providerName(provider)} to complete payment securely.
                </p>
              </div>
            </div>
          )}
        </div>
      </main>
      <Footer />
    </App>
  );
}
