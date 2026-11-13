import { Link } from "react-router-dom";
import LegalPageLayout, { LegalContactDetails, Tbc } from "../components/LegalLayout.jsx";
import { COMPANY } from "../legal/company.js";

const mail = <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>;
const terms = <Link to="/terms-and-conditions">Terms &amp; Conditions</Link>;
const refund = <Link to="/refund-and-cancellation-policy">Refund &amp; Cancellation Policy</Link>;

// Every statement here restates the published Terms & Conditions or describes
// what the website code does. No delivery timeframe is stated: none is approved.
const sections = [
  { id: "scope", title: "What This Policy Covers", body: <>
    <p>{COMPANY.legalName} ("{COMPANY.brand}", "we") sells technology services and digital products such as ebooks through this website. We do not sell physical goods, so nothing is packed, dispatched or couriered. This policy explains how the services and digital products you order are delivered. It forms part of our {terms}.</p>
  </> },
  { id: "charges", title: "Shipping Charges", body: <>
    <p>There are no shipping, courier, handling or delivery charges, because nothing is physically shipped. The total shown in your cart and at checkout is the amount you are asked to pay, and we do not add fees after checkout.</p>
  </> },
  { id: "coverage", title: "Delivery Area", body: <>
    <p>Delivery is electronic, so there is no courier coverage area or pin-code restriction. Prices are in Indian Rupees and payment is made through the payment gateways offered at checkout. You need a working email address and phone number so that we can reach you about your order.</p>
  </> },
  { id: "ebooks", title: "Delivery of Digital Products and Ebooks", body: <>
    <p>The website does not provide an automatic download. Our team delivers digital products manually after your payment is confirmed by the payment gateway, normally by email to the address you gave at checkout. Please make sure that address is correct and check your spam or junk folder.</p>
    <p>We have not published a fixed delivery time for digital products. <Tbc>Owner to confirm the actual delivery method and an expected delivery time.</Tbc> If you have paid and not received your product, contact us as described below.</p>
  </> },
  { id: "services", title: "Delivery of Services", body: <>
    <p>Services are handled by our team. After your payment is confirmed we contact you using the email address or phone number you provided. Work begins once we have what we need from you, such as access or materials. Where no timeline has been agreed in writing, we give a reasonable time estimate when work starts; estimates are not guarantees.</p>
    <p>Delay in providing content, access, approvals or feedback extends the timeline. An order is complete when the agreed deliverables are handed over. <Tbc>Owner to confirm any standard delivery timeframe to be published.</Tbc></p>
  </> },
  { id: "confirmation", title: "Order Confirmation and Tracking", body: <>
    <p>After payment you are returned to an order status page showing your order ID (it starts with "FIR-") and the payment status. Please keep a note of the order ID. The website does not send an automatic confirmation email and does not offer an account area or an order-tracking page. For an update on an order, email {mail} with your order ID.</p>
  </> },
  { id: "problems", title: "Non-Delivery and Delivery Problems", body: <>
    <p>If a digital product does not arrive, a file is corrupt or inaccessible, you receive something other than what you ordered, or a service is not delivered, email {mail} with your order ID. We will deliver or correct the item, or refund you, as set out in the {refund}.</p>
  </> },
  { id: "contact", title: "Contact Details", body: <LegalContactDetails /> },
];

export default function ShippingAndDeliveryPolicy() {
  return (
    <LegalPageLayout
      title="Shipping & Delivery Policy"
      path="/shipping-and-delivery-policy"
      sections={sections}
      intro={<p>{COMPANY.brand} sells digital services and digital products only. Nothing is physically shipped, and there are no shipping charges. This policy explains how your order reaches you.</p>}
    />
  );
}
