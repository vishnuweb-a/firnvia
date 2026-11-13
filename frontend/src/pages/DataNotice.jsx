import { Link } from "react-router-dom";
import LegalPageLayout, { LegalContactDetails, Tbc } from "../components/LegalLayout.jsx";
import { COMPANY } from "../legal/company.js";

const mail = <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>;
const terms = <Link to="/terms-and-conditions">Terms &amp; Conditions</Link>;
const refund = <Link to="/refund-and-cancellation-policy">Refund &amp; Cancellation Policy</Link>;

const sections = [
  { id: "introduction", title: "Introduction and Who We Are", body: <>
    <p>{COMPANY.legalName} ("{COMPANY.brand}", "we") operates {COMPANY.website.replace("https://", "")} and decides why and how personal data collected through it is used. In the language of India's Digital Personal Data Protection Act, 2023 ("DPDP Act") we act as the data fiduciary for that data.</p>
    <p>This policy describes what the website actually does today. If our practices change we will update this page.</p>
    <p><strong>Legal status.</strong> The DPDP Act was enacted in 2023 and the DPDP Rules, 2025 were notified on 13 November 2025. Their provisions come into force in phases: some took effect on notification, and the main duties on notice, consent, security safeguards and breach notification are due to begin about 18 months after notification, around May 2027. Until then, other Indian law, including the Information Technology Act, 2000 and its rules, continues to apply. We are preparing for the new rules and describe their rights here in advance as good practice. <Tbc>Owner/lawyer to verify the commencement position again before publication.</Tbc></p>
  </> },
  { id: "categories", title: "Personal Data We Collect", body: <>
    <ul>
      <li><strong>Contact details</strong> you give when you email or phone us: your name, email address, phone number and what you tell us.</li>
      <li><strong>Order details</strong> you give at checkout: first and last name, email, phone number, and the items you order and their price.</li>
      <li><strong>Payment and transaction identifiers</strong>: order ID, gateway transaction references and payment status returned by the Payment Gateway.</li>
      <li><strong>Technical data</strong>: your IP address and request details handled by our hosting infrastructure when you visit the website.</li>
      <li><strong>Cart data</strong> kept in your own browser, described below.</li>
    </ul>
    <p>We do not collect your card number, CVV, UPI PIN, net-banking credentials or OTP. You enter those on the Payment Gateway's pages, not ours.</p>
  </> },
  { id: "enquiries", title: "Enquiries by Email and Phone", body: <>
    <p>The website does not have a contact form. When you email or phone us, we receive the contact details and information you choose to give, and we use them to reply to you and to handle your request. <Tbc>Owner to confirm who monitors the mailbox and phone line. The backend still exposes POST /api/contact, which writes submissions to server logs; no page on the site calls it.</Tbc></p>
  </> },
  { id: "checkout", title: "Checkout and Order Information", body: <>
    <p>When you check out, we create an order that holds your name, email, phone, the items and total. Orders are currently held in the memory of the server process. They are not saved to a database and can be lost when the server restarts or scales. For that reason we may ask you for your order ID or payment proof if you contact us about an order.</p>
  </> },
  { id: "payments", title: "Payment and Transaction Identifiers", body: <>
    <p>We receive the outcome of your payment and identifiers such as the transaction ID from the Payment Gateway you chose at checkout. We use these to match your payment to your order and to investigate payment problems.</p>
  </> },
  { id: "technical", title: "Website Technical Data", body: <>
    <p>Our website loads web fonts (Sora and Inter) from Google Fonts. When your browser requests them, Google receives your IP address and browser details under its own privacy policy. Our hosting providers process standard request data to serve the website and keep it secure.</p>
  </> },
  { id: "cart-storage", title: "Cart Information in Your Browser", body: <>
    <p>Your cart (the items and quantities you choose) is saved in your browser's localStorage under the name "firvanra_cart", so it remains if you leave and return. This stays on your device; it is only sent to us as part of the order you place. You can clear it by emptying your cart or clearing your browser's site data.</p>
  </> },
  { id: "cookies", title: "Cookies and Similar Technologies", body: <>
    <p>The website's own code does not set cookies and does not use analytics, advertising or tracking tools. Third-party Payment Gateway pages that you are redirected to may set their own cookies under their own policies. <Tbc>Owner to confirm no analytics or marketing scripts are added outside the code reviewed.</Tbc></p>
  </> },
  { id: "purposes", title: "Why We Use Your Data", body: <>
    <ul>
      <li>To process your order, accept payment and verify its result.</li>
      <li>To deliver services and digital products and contact you about them.</li>
      <li>To answer your enquiries and complaints, and handle refund requests.</li>
      <li>To prevent fraud and keep the website secure.</li>
      <li>To meet legal, tax and accounting obligations.</li>
    </ul>
    <p>We do not sell your personal data. We do not currently use it for marketing emails.</p>
  </> },
  { id: "basis", title: "Legal Basis and Consent", body: <>
    <p>We use your data because you give it to us for a purpose you can see, such as ordering a service or sending an enquiry, because it is needed to perform your order, and because the law requires certain records. Your acceptance of the {terms} at checkout is agreement to a contract; it is not a general consent to any other use of your personal data. The website does not currently record consent in a durable consent log. <Tbc>Owner decision needed before the DPDP consent and notice duties begin.</Tbc></p>
  </> },
  { id: "gateways", title: "Payment Gateway Sharing", body: <>
    <p>To complete payment, your order amount, order ID and the contact details you gave (name, email, phone) are shared with the Payment Gateway you select. The gateways currently offered are named on the checkout page. Each gateway is responsible for its own handling of data under its own privacy policy.</p>
  </> },
  { id: "hosting", title: "Hosting and Infrastructure Providers", body: <>
    <p>The website and its API are hosted using Vercel infrastructure, and the API is served at api.firvanra.online. These providers process data on our behalf to run the service. <Tbc>Owner to confirm the hosting regions and any other providers used.</Tbc></p>
  </> },
  { id: "callbacks", title: "External Callback and Webhook Recipients", body: <>
    <p>We do not only keep payment data to ourselves. For payments made with SabPaisa, and with the checkout option labelled "AirPay 2", after we verify a payment notification from the gateway we forward the notification to kkchat.in, an external service. That notification can include transaction details and the payer details the gateway supplies. Notifications for the other payment options are not forwarded there. <Tbc>Owner to state who operates kkchat.in, why the data is sent, and the basis for sharing it. This is unconfirmed in the project code.</Tbc></p>
  </> },
  { id: "retention", title: "Data Retention", body: <>
    <p>We have not set an automated retention schedule and the website does not delete data automatically. Orders held in server memory disappear when the server process is replaced. Server logs, gateway records and any emails remain with us or the providers until deleted. We keep records we are legally required to keep, such as payment and tax records, for as long as the law requires. <Tbc>Owner to approve a retention period for each category of data.</Tbc></p>
  </> },
  { id: "security", title: "Security Safeguards", body: <>
    <p>We use the safeguards that come with our hosting and payment providers, including HTTPS for the website and verification of payment notifications from the gateways. Card and bank details are entered on the gateways' pages, not ours. No system is completely secure, and we cannot guarantee absolute security. We do not claim that stored data is encrypted at rest.</p>
  </> },
  { id: "rights", title: "Your Rights and How to Use Them", body: <>
    <p>You can ask us to tell you what personal data of yours we hold and how it is used, to correct or complete it, to delete it, and to nominate someone to exercise these rights if you die or cannot do so yourself. To make a request, email {mail} from the address you used with us and say what you need. These requests are handled manually by a person; the website has no automated request system. We will verify who you are before acting, and we may need to keep some data to meet legal duties. <Tbc>Owner to approve a response time (for example 30 days).</Tbc></p>
  </> },
  { id: "withdrawal", title: "Withdrawing Consent", body: <>
    <p>Where we rely on your consent, you can withdraw it by emailing {mail}. Withdrawal does not affect what we did before, and we may not be able to complete an order or support request without the data. We will keep what the law requires us to keep.</p>
  </> },
  { id: "correction", title: "Correction and Deletion", body: <>
    <p>Email us to correct inaccurate details. To have data deleted, email us the same way. We delete what we can unless we must keep it for legal, tax or dispute purposes. Data already passed to Payment Gateways or other recipients must be requested from them directly as well.</p>
  </> },
  { id: "children", title: "Children's Data", body: <>
    <p>The website is meant for adults and businesses. It is not directed at children, and we do not knowingly collect data from anyone under 18. If you believe a child has given us data, email us and we will delete it. The DPDP Act requires verifiable parental consent for children's data once its relevant provisions begin.</p>
  </> },
  { id: "international", title: "International Processing", body: <>
    <p>Some providers, such as Google Fonts and Vercel, may process data on servers outside India. We have not restricted processing to India. <Tbc>Owner to confirm provider locations.</Tbc></p>
  </> },
  { id: "breach", title: "Data Breach Handling", body: <>
    <p>If we become aware of a breach that affects your personal data, we will investigate and limit it, and we will notify the authorities and affected people where the law requires. We do not have an automated breach-detection system.</p>
  </> },
  { id: "grievance", title: "Grievance and Privacy Contact", body: <>
    <p>Send privacy questions and complaints to {mail} or call <a href={`tel:+91${COMPANY.phone}`}>{COMPANY.phone}</a>. If we do not resolve your complaint you may complain to the Data Protection Board of India once it is operating. See also our {refund} for payment issues.</p>
    <LegalContactDetails />
    <p><Tbc>Owner to name a privacy/grievance contact person. None has been invented here.</Tbc></p>
  </> },
  { id: "updates", title: "Policy Updates and Effective Date", body: <>
    <p>We will publish changes on this page with a new version number and date. Version 0.1 (draft). <Tbc>The effective date will be the date the owner approves and publishes this policy.</Tbc></p>
  </> },
];

export default function DataNotice() {
  return (
    <LegalPageLayout
      title="Privacy Policy"
      path="/privacy-policy"
      sections={sections}
      intro={<p>This policy explains what personal data {COMPANY.brand} collects through its website, why, and who receives it. It should be read with our {terms}.</p>}
    />
  );
}
