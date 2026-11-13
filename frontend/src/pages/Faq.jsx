import { useState } from "react";
import { Link } from "react-router-dom";
import PageLayout from "../components/PageLayout.jsx";
import { COMPANY } from "../legal/company.js";

const mail = <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>;
const phone = <a href={`tel:+91${COMPANY.phone}`}>{COMPANY.phone}</a>;
const refund = <Link to="/refund-and-cancellation-policy">Refund &amp; Cancellation Policy</Link>;
const delivery = <Link to="/shipping-and-delivery-policy">Shipping &amp; Delivery Policy</Link>;

// Answers describe what the website does today. Keep them in step with the policy pages.
const GROUPS = [
  ["Ordering", [
    ["How do I place an order?", <>
      <p>Open the <Link to="/shop">Shop</Link>, choose a service or ebook and select “Add to cart”. Open the cart, select “Checkout”, enter your name, email address and phone number, choose a payment gateway, tick the box to accept the Terms &amp; Conditions and pay. You do not need to create an account.</p>
    </>],
    ["Where can I find product details and specifications?", <>
      <p>Every product has its own page. Select the product name or “Details” on any listing to see what it covers, who it is for, how it is delivered and its price. If something you need to know is not listed, ask us through the <Link to="/contact">Contact page</Link> before ordering.</p>
    </>],
    ["Do you sell physical products?", <>
      <p>No. We sell digital services and ebooks only, so nothing is packed or shipped.</p>
    </>],
  ]],
  ["Payments", [
    ["What payment methods are available?", <>
      <p>Payments are made online through third-party payment gateways. The gateways currently offered are shown at checkout, where you choose one. You then complete payment on that gateway's own page, which shows the methods it supports, such as UPI, cards or net banking. We do not offer cash on delivery, and we never see or store your card number, CVV, UPI PIN or OTP.</p>
    </>],
    ["My payment was deducted but the order was not confirmed. What should I do?", <>
      <p>First check your bank, card or UPI statement; a “failed” or “pending” status on our website is not proof either way. Please do not pay again straight away. Many failed debits are reversed automatically by the bank or payment provider.</p>
      <p>If the money was debited and you have no confirmed order, email {mail} with your name, the email and phone number used at checkout, your order ID or transaction reference, and the payment date, amount and method. We check the gateway records and then confirm the order, refund the amount, or tell you the reversal is with your bank. See “Failed Transactions” in the {refund}.</p>
    </>],
    ["Is there any extra charge at checkout?", <>
      <p>No. The total shown in your cart and at checkout is the amount you are asked to pay. We do not add fees after checkout.</p>
    </>],
  ]],
  ["Order status and delivery", [
    ["How do I know my order is confirmed? Can I track it?", <>
      <p>After paying you are returned to an order status page showing your order ID (it starts with “FIR-”) and whether the payment was successful, pending or failed. Please save the order ID or take a screenshot: the website does not send an automatic confirmation email and has no account area or order-tracking page.</p>
      <p>Orders are handled by our team, who contact you using the email address or phone number you gave. For an update, email {mail} with your order ID.</p>
    </>],
    ["Where do you deliver, and how long does delivery take?", <>
      <p>Nothing is shipped, so there is no courier coverage area. Ebooks are sent by our team after payment is confirmed, normally by email to the address you gave at checkout; they are not instant downloads. Services start once we have what we need from you, and we give a time estimate when work starts.</p>
      <p>We have not published a fixed delivery timeframe. If timing matters, ask us before ordering. Details are in the {delivery}.</p>
    </>],
    ["Are there any shipping charges?", <>
      <p>No. We do not sell physical goods, so there are no shipping, courier or delivery charges.</p>
    </>],
  ]],
  ["Cancellations, returns and refunds", [
    ["Can I cancel my order?", <>
      <p>Yes, you can ask. Email {mail} with your order ID as soon as possible; there is no self-service cancel button. If work has not started, the amount paid is refunded in full, subject to the limited exception explained in the policy. If work has started, the refund takes into account the work already done. See the {refund}.</p>
    </>],
    ["Can I return a product?", <>
      <p>Our products are digital, so there is nothing to send back and no return shipping. Whether a refund applies depends on the situation: for example, an ebook that has been delivered and works is not refunded for change of mind, while a service that was not delivered or is deficient is covered. The {refund} sets out each case.</p>
    </>],
    ["What if my ebook file is corrupt, I received the wrong product, or a service is not as described?", <>
      <p>Tell us at {mail} with your order ID and what went wrong. For a corrupt or unusable file we send a working copy, or refund if we cannot. For a wrong product we send the correct one, or refund. For a service that is deficient or materially different from its description, we first try to correct it within a reasonable time and refund an appropriate part or all of the amount if we cannot.</p>
    </>],
    ["How do I request a refund, and how long does it take?", <>
      <p>Email {mail} with your name, the email and phone number used at checkout, your order ID or transaction reference, the payment date, amount and method, and the reason. Never send a PIN, password, OTP, full card number or CVV.</p>
      <p>A person reviews each request, verifies the payment with the gateway and replies with the decision. Approved refunds are sent back through the payment channel you used where the gateway and your bank allow it. Once we start a refund, the time it takes to reach you is set by the payment provider and your bank. See “Refund Processing Time” in the {refund}.</p>
    </>],
  ]],
  ["Support and privacy", [
    ["How do I contact customer support?", <>
      <p>Email {mail} or call {phone}. For anything about an order, payment or refund, email is best because we can reply with a written record; include your order ID. The same details are on the <Link to="/contact">Contact page</Link>.</p>
    </>],
    ["What personal information do you collect?", <>
      <p>At checkout we ask for your name, email address and phone number, and we receive the payment result and transaction reference from the gateway. Your cart is kept in your own browser. The full description is in the <Link to="/privacy-policy">Privacy Policy</Link>.</p>
    </>],
  ]],
];

function Item({ id, q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="faq-item">
      <h3>
        <button id={`${id}-q`} className="faq-q" aria-expanded={open} aria-controls={`${id}-a`} onClick={() => setOpen(!open)}>
          <span>{q}</span>
          <span className="faq-icon" aria-hidden="true">{open ? "−" : "+"}</span>
        </button>
      </h3>
      <div id={`${id}-a`} className="faq-a prose" role="region" aria-labelledby={`${id}-q`} hidden={!open}>
        {a}
      </div>
    </div>
  );
}

export default function Faq() {
  return (
    <PageLayout
      eyebrow="Help"
      title="Frequently asked questions"
      lead="Quick answers about ordering, payments, delivery, cancellations and refunds. The policy pages linked in each answer have the full detail."
    >
      <div className="faq">
        {GROUPS.map(([group, items], g) => (
          <section key={group} aria-labelledby={`faq-g${g}`}>
            <h2 id={`faq-g${g}`}>{group}</h2>
            {items.map(([q, a], i) => <Item key={q} id={`faq-${g}-${i}`} q={q} a={a} />)}
          </section>
        ))}
        <p className="faq-more">Still have a question? <Link className="text-link" to="/contact">Contact us</Link>.</p>
      </div>
    </PageLayout>
  );
}
