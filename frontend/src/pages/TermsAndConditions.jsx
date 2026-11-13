import { Link } from "react-router-dom";
import LegalPageLayout, { LegalContactDetails, Tbc } from "../components/LegalLayout.jsx";
import { COMPANY } from "../legal/company.js";

const mail = <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>;
const refund = <Link to="/refund-and-cancellation-policy">Refund &amp; Cancellation Policy</Link>;
const privacy = <Link to="/privacy-policy">Privacy Policy</Link>;

const sections = [
  { id: "introduction", title: "Introduction and Acceptance", body: <>
    <p>This website, {COMPANY.website.replace("https://", "")}, is operated by {COMPANY.legalName}, a company based in Delhi, India, trading as {COMPANY.brand}. These Terms &amp; Conditions ("Terms") govern purchases of services and digital products made through the website.</p>
    <p>Browsing the website does not by itself create a contract with us. You agree to these Terms when you tick the acceptance box at checkout and proceed to pay, or when you otherwise accept them in writing. If you and we have signed a separate Project Agreement for a particular piece of work, that agreement applies to that work, and these Terms fill any gaps it leaves.</p>
    <p>Nothing in these Terms removes any right you have as a consumer under the Consumer Protection Act, 2019 or other mandatory Indian law. If a clause cannot lawfully apply to you, it applies only to the extent the law allows.</p>
  </> },
  { id: "definitions", title: "Definitions", body: <ul>
    <li><strong>Company</strong>, "we", "us": {COMPANY.legalName}.</li>
    <li><strong>Website</strong>: {COMPANY.website} and its pages.</li>
    <li><strong>Customer</strong>: a person who places an Order. <strong>User</strong>: anyone who visits or uses the Website.</li>
    <li><strong>Services</strong>: the technology, website, software, maintenance, consulting and related services offered by us.</li>
    <li><strong>Digital Products</strong>: downloadable or electronically supplied content such as ebooks.</li>
    <li><strong>Order</strong>: a request to buy Services or Digital Products placed through the checkout.</li>
    <li><strong>Payment</strong>: the amount paid for an Order. <strong>Payment Gateway</strong>: a third-party provider that processes the Payment (the gateways currently offered are shown at checkout, where you choose one).</li>
    <li><strong>Project Agreement</strong>: a written agreement, proposal or statement of work, signed or accepted by both parties, that sets out scope, price or timeline for specific work.</li>
    <li><strong>Deliverables</strong>: the work product we agree to hand over for an Order.</li>
    <li><strong>Refund</strong>: return of money to the Customer. <strong>Cancellation</strong>: withdrawal of an Order before it is fulfilled. Both are explained in the {refund}.</li>
  </ul> },
  { id: "business-info", title: "Business Information", body: <>
    <p>The business details currently published on our website are:</p>
    <LegalContactDetails />
    <p><Tbc>Owner to add before publication, if applicable: CIN, GSTIN and any other registration details. None are stated here because none are recorded in the website code. The address above is the address displayed on the website; it has not been confirmed as a registered office.</Tbc></p>
  </> },
  { id: "scope", title: "Scope of Products and Services", body: <>
    <p>Our website currently lists these Services for purchase: website redesign, technical website audit, WordPress care (maintenance), WordPress error fixing, conversion optimisation, and data and automation basics. It also sells ebooks as Digital Products. The website additionally describes micro services such as website setup, speed improvement, e-commerce support, video editing, AI automation and website UI design; where these cannot be bought at checkout, they are provided only after we agree scope and price with you.</p>
    <p>The description of each item on the website, together with any written confirmation from us, defines what you are buying. We do not offer services that are not described on the website or agreed in writing.</p>
  </> },
  { id: "eligibility", title: "Customer Eligibility and Responsibilities", body: <>
    <p>You must be legally capable of entering a contract under Indian law (generally, 18 years or older). If you buy for a business, you confirm you are authorised to do so.</p>
    <p>The website does not require you to create an account. At checkout you give your name, email address and phone number. You agree to provide accurate details, keep them current, use the Services lawfully, and give us the information, access and approvals we reasonably need to perform the Services.</p>
  </> },
  { id: "ordering", title: "Service Ordering and Contract Formation", body: <>
    <p>These are separate steps and we treat them separately:</p>
    <ol>
      <li><strong>Placing an Order</strong>: you submit your cart and details at checkout. This is an offer to buy.</li>
      <li><strong>Payment initiation</strong>: you are sent to a Payment Gateway to pay.</li>
      <li><strong>Payment confirmation</strong>: the Payment Gateway confirms the outcome to us. Only then do we treat the Payment as received.</li>
      <li><strong>Acceptance</strong>: we accept the request for Services when we confirm it to you or begin work. We may decline an Order we cannot fulfil, in which case the {refund} applies.</li>
      <li><strong>Commencement</strong>: work begins once we have what we need from you, such as access or materials.</li>
      <li><strong>Deliverables</strong>: the Order is complete when the agreed Deliverables are handed over.</li>
    </ol>
    <p>A successful Payment shows that money was received. It does not mean the service has been performed. Orders are currently handled manually; we contact you using the email address or phone number you provided.</p>
  </> },
  { id: "pricing", title: "Pricing, Taxes, and Payments", body: <>
    <p>Prices on the website are in Indian Rupees (INR). The amount shown in your cart and at checkout is the amount you will be asked to pay, and we do not add fees after checkout. <Tbc>Owner to confirm whether displayed prices include GST and whether tax invoices are issued; the code does not show this.</Tbc></p>
    <p>You authorise the Payment when you complete it with the Payment Gateway. Payments are processed by third-party gateways, which have their own terms and are outside our control. We do not guarantee that any gateway will always be available.</p>
    <p>If a Payment fails or stays pending, check your bank or payment-app statement before paying again, because a failed status on our website is not proof that no money was debited. If you are charged twice, or charged without a confirmed Order, write to us as described in the {refund}. We verify such cases against gateway records before deciding on a Refund.</p>
  </> },
  { id: "project-scope", title: "Project Scope and Deliverables", body: <>
    <p>The scope of work is what the Order description or any Project Agreement states. Where a Project Agreement sets milestones or timelines, those apply. Where nothing is agreed, we will give a reasonable time estimate when work starts; estimates are not guarantees. We have not set a fixed number of revisions or a fixed delivery deadline for standard orders. <Tbc>Owner to confirm any standard revision allowance or delivery timeframe to be published.</Tbc></p>
    <p>You are responsible for supplying content, access credentials, approvals and feedback on time. Delay in providing these extends the timeline and is not a failure on our part.</p>
    <p>Work outside the agreed scope is a change request. We will tell you the effect on price and time and will proceed only after you agree. Deliverables are treated as accepted when you confirm acceptance, or when you have had a reasonable opportunity to review them and have not reported a material non-conformity with the agreed scope.</p>
  </> },
  { id: "maintenance", title: "Website Maintenance and Support", body: <>
    <p>Maintenance services, such as the WordPress care service, cover the tasks and period described in the Order or Project Agreement. They do not cover work outside that description, and we are not responsible for faults caused by third-party hosts, plugins, themes or services we do not control.</p>
    <p>The website does not set up automatic recurring billing. Any renewal or extension must be agreed and paid for separately. <Tbc>Owner to confirm the standard service period for maintenance orders.</Tbc></p>
  </> },
  { id: "digital-products", title: "Digital Products", body: <>
    <p>When you buy a Digital Product you receive a personal, non-exclusive, non-transferable licence to use it for your own learning or internal business purposes, unless the product description says otherwise. You may not copy, resell, share or publish it. Copyright remains with us or our licensors.</p>
    <p>Delivery is not automated by the website. We deliver Digital Products manually after Payment is confirmed, normally by email to the address you gave. <Tbc>Owner to confirm the actual delivery method and expected delivery time.</Tbc> If you do not receive a product, or a file is corrupt, inaccessible or not the product you bought, contact us and we will resolve it under the {refund}.</p>
  </> },
  { id: "ip", title: "Intellectual Property Rights", body: <>
    <p>Website content, branding, designs and code owned by us remain ours. Third-party content, themes, plugins and fonts remain with their owners and are subject to their licences. Materials you give us stay yours, and you confirm you have the right to give them to us.</p>
    <p>Ownership of source code and Deliverables is governed by the Project Agreement. Unless a written agreement says otherwise, once we have received full payment you may use the Deliverables for the purpose for which they were made; this does not transfer our pre-existing tools, libraries or know-how. <Tbc>Owner to confirm whether ownership of paid Deliverables passes to the Customer on full payment.</Tbc></p>
  </> },
  { id: "confidentiality", title: "Customer Data and Confidentiality", body: <>
    <p>We treat non-public project information, credentials and files you give us as confidential and use them only to deliver your Services. This does not apply to information that is public, already known to us, or that we must disclose by law.</p>
    <p>How we handle personal data is explained in our {privacy}.</p>
  </> },
  { id: "prohibited", title: "Prohibited Activities", body: <>
    <p>You must not use the website or Services to commit fraud, make unauthorised payments, gain unauthorised access to systems or data, introduce malicious code, infringe intellectual property, disrupt the website, give a false identity or payment details, or do anything unlawful. We may refuse service and report unlawful activity to the authorities.</p>
  </> },
  { id: "third-party", title: "Third-Party Services", body: <>
    <p>We rely on third parties including Payment Gateways, hosting and infrastructure providers, and external services your project may use. Their terms and availability are outside our control. Where a Service depends on a third party, our responsibility is limited to our own part of the work.</p>
  </> },
  { id: "refunds", title: "Refunds and Cancellations", body: <>
    <p>Refunds and cancellations are governed by our {refund}, any applicable Project Agreement, and mandatory law. Nothing in these Terms makes all purchases non-refundable.</p>
  </> },
  { id: "availability", title: "Service Availability and Disruption", body: <>
    <p>The website may be unavailable at times for maintenance, third-party failure or internet disruption. We will make reasonable efforts to restore it, but we do not guarantee uninterrupted access.</p>
  </> },
  { id: "warranties", title: "Warranties and Disclaimers", body: <>
    <p>We will perform Services with reasonable skill and care and supply what you ordered as described. Beyond this, and to the extent the law permits, we do not promise results that depend on factors outside our control, such as search rankings, sales or third-party platform behaviour. This section does not limit your rights under the Consumer Protection Act, 2019.</p>
  </> },
  { id: "liability", title: "Limitation of Liability", body: <>
    <p>To the extent permitted by law, our total liability for a claim arising from an Order is limited to the amount you paid for that Order, and we are not liable for indirect or consequential loss such as lost profit. <Tbc>Owner/lawyer to confirm the liability cap.</Tbc> Nothing in these Terms excludes or limits liability that cannot be excluded by law, including for fraud or wilful misconduct, or your statutory consumer remedies.</p>
  </> },
  { id: "indemnity", title: "Indemnification", body: <>
    <p>You will compensate us for reasonable losses and costs arising from a third-party claim that results from your unlawful use of the website, your breach of these Terms, or materials you supplied that infringe someone's rights. This applies only to the extent the loss was caused by you and is permitted by law.</p>
  </> },
  { id: "termination", title: "Suspension and Termination", body: <>
    <p>We may suspend or end access to the website or an Order if you breach these Terms, supply false information, make a payment we reasonably believe is fraudulent, or if the law requires. Where practicable we will tell you why and give you a chance to respond. If we end a paid Order for reasons not caused by you, we will refund as set out in the {refund}. You may stop using the website at any time and may ask to cancel an Order under the same policy.</p>
  </> },
  { id: "disputes", title: "Complaints and Dispute Resolution", body: <>
    <p>Write to {mail} with your name, order reference and the issue. We will review your complaint and reply. If you are not satisfied you may approach the consumer commission, the National Consumer Helpline (1915) or any other forum open to you.</p>
    <p>These Terms are governed by the laws of India. Subject to the jurisdiction a consumer has by law, including the right to file a consumer complaint where you reside or work, the courts at Delhi have jurisdiction over disputes. We do not require you to use private arbitration.</p>
  </> },
  { id: "changes", title: "Changes to Terms", body: <>
    <p>We may update these Terms by publishing a new version here with its version number and date. Orders already accepted continue under the Terms that applied when you accepted them, unless you agree to the new version or the law requires otherwise.</p>
  </> },
  { id: "general", title: "Severability and Entire Agreement", body: <>
    <p>If any part of these Terms is held unenforceable, the rest remains in effect. These Terms, the {refund}, the {privacy} and any Project Agreement together form the whole agreement for the relevant Order. A separately negotiated written contract prevails over these Terms for the matters it covers.</p>
  </> },
  { id: "contact", title: "Contact Information", body: <LegalContactDetails /> },
  { id: "version", title: "Effective Date and Version", body: <>
    <p>Version 0.1 (draft). <Tbc>The effective date will be the day the owner approves and publishes these Terms. They do not apply before that date.</Tbc></p>
  </> },
];

export default function TermsAndConditions() {
  return (
    <LegalPageLayout
      title="Terms & Conditions"
      path="/terms-and-conditions"
      sections={sections}
      intro={<p>These Terms explain how you may use the {COMPANY.brand} website and what you can expect when you buy from us. Please read them with our {refund} and {privacy}.</p>}
    />
  );
}
