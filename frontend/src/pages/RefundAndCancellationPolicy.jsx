import { Link } from "react-router-dom";
import LegalPageLayout, { LegalContactDetails, Tbc } from "../components/LegalLayout.jsx";
import { COMPANY } from "../legal/company.js";

const mail = <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a>;
const terms = <Link to="/terms-and-conditions">Terms &amp; Conditions</Link>;
const privacy = <Link to="/privacy-policy">Privacy Policy</Link>;

const sections = [
  { id: "introduction", title: "Introduction", body: <>
    <p>This policy explains when and how you can cancel an order or ask for a refund from {COMPANY.legalName} ("{COMPANY.brand}", "we"). It forms part of our {terms}.</p>
    <p>Today, cancellation and refund requests are handled manually by our team by email. The website has no self-service cancellation or refund feature, no refund dashboard and no automated refund processing. Refunds are issued only after a person at {COMPANY.brand} has reviewed and approved the request.</p>
  </> },
  { id: "applicability", title: "Applicability", body: <>
    <p>This policy applies to orders for technology services, website and software development, website maintenance, consulting, and digital goods such as ebooks, paid through the payment gateways offered at checkout on our website. Where a signed or accepted Project Agreement says something different on a particular point, it applies to that point, but never in a way that removes a right you have under mandatory law.</p>
  </> },
  { id: "principles", title: "General Refund Principles", body: <>
    <ul>
      <li>We assess each request on its facts, fairly and in good faith.</li>
      <li>We do not treat any purchase as non-refundable in every circumstance. If we fail to deliver what you paid for, or the service is deficient or materially different from what was described, you are entitled to a remedy, which may be re-performance, a partial refund or a full refund depending on the case.</li>
      <li>Where we have properly performed work or incurred genuine, disclosed costs, we may take these into account in a refund calculation, as explained below.</li>
      <li>Your rights under the Consumer Protection Act, 2019 and other mandatory law are not reduced by this policy.</li>
    </ul>
  </> },
  { id: "before-start", title: "Cancellation Before Service Commencement", body: <>
    <p>To cancel before work starts, email {mail} with your order reference as soon as possible. Work is treated as having started when we have begun it, for example by contacting you to start the project, accessing your site or materials, or sending you a work-in-progress item. We will tell you in writing if we say work has started, and we will be able to show you the basis for that.</p>
    <p>If work has not started, we will refund the amount paid in full. A deduction is made only for a genuine, non-recoverable cost we have already incurred for your order (for example a third-party purchase made at your request) that was disclosed to you before or at the time of ordering, and only where the law allows. <Tbc>Owner to confirm whether any pre-commencement deduction applies; none is assumed here.</Tbc></p>
  </> },
  { id: "after-start", title: "Cancellation After Service Commencement", body: <>
    <p>If you cancel after work has started, we calculate the refund as the amount you paid, minus (a) the fair value of work already completed in line with the order or agreed milestones, and (b) disclosed third-party costs already committed that cannot be recovered. We will show you the calculation. We have not set fixed cancellation percentages.</p>
    <p>You may keep Deliverables for work you have paid for and not been refunded for. Deliverables for work that has been refunded remain ours, and any rights in them end. If a Project Agreement addresses ownership on cancellation, it applies.</p>
  </> },
  { id: "completed", title: "Completed Services", body: <>
    <p>Once a service has been completed and delivered in line with the agreed scope, change of mind is not a ground for a refund. If the service is deficient, materially different from the description, or was not delivered, you may report this and we will first try to correct it within a reasonable time. If we cannot, or it is not reasonable to ask you to wait, we will refund an appropriate part or all of the amount paid. Your statutory remedies are preserved.</p>
  </> },
  { id: "maintenance", title: "Website Maintenance Services", body: <>
    <ul>
      <li><strong>Before coverage starts:</strong> full refund, subject to the section on cancellation before commencement.</li>
      <li><strong>During the agreed period:</strong> you may cancel and we will refund the unused part of the period, less the value of work already done and any disclosed third-party commitments that cannot be recovered.</li>
      <li><strong>One-time versus annual services:</strong> the order description states the period. The refund for an annual service is calculated on the unused part of that year.</li>
      <li><strong>Renewals:</strong> the website does not offer automatic renewal or recurring billing. A renewal is a new order.</li>
    </ul>
    <p><Tbc>Owner to confirm the standard service periods for maintenance orders.</Tbc></p>
  </> },
  { id: "digital", title: "Digital Products and Ebooks", body: <>
    <ul>
      <li><strong>Paid but not delivered:</strong> we will deliver the product or refund you in full.</li>
      <li><strong>Delivered and accessible:</strong> as digital content cannot be returned once delivered, we do not refund change-of-mind requests after the product has been delivered and opened. This restriction does not apply to the cases below.</li>
      <li><strong>Duplicate purchase:</strong> we will refund the duplicate payment.</li>
      <li><strong>Corrupt or unusable file:</strong> we will send a working copy, or refund if we cannot.</li>
      <li><strong>Wrong product supplied:</strong> we will send the correct product, or refund.</li>
      <li><strong>Materially misdescribed product:</strong> we will refund.</li>
    </ul>
    <p>This restriction on change-of-mind refunds is shown at checkout before you pay and does not limit your rights under consumer law. Ebooks are currently delivered manually, not by automatic download.</p>
  </> },
  { id: "returns", title: "Returns and Return Shipping", body: <>
    <p>We sell services and digital products only. We do not sell or ship physical goods, so there is no item to send back, no return window to meet and no return shipping cost for you or for us. Where a digital product is faulty, is not the one you ordered or was materially misdescribed, the remedies in "Digital Products and Ebooks" above apply. Where a service was not delivered or is deficient, see "Completed Services". How orders reach you is explained in our <Link to="/shipping-and-delivery-policy">Shipping &amp; Delivery Policy</Link>.</p>
  </> },
  { id: "failed", title: "Failed Transactions", body: <>
    <p>A "failed" or "pending" status on our website is not proof that your money was not debited. Please check your bank, card or UPI app statement. Many failed debits are reversed automatically by your bank or payment provider; the timing is set by them and by banking rules and not by us.</p>
    <p>If money was debited and you have no confirmed order, email {mail} with the details listed under "Refund Request Procedure". We will check the gateway records and then either confirm the order, or refund the amount, or tell you the reversal is with your bank.</p>
  </> },
  { id: "duplicate", title: "Duplicate or Excess Payments", body: <>
    <p>If you pay twice for the same order, pay through two different gateways, or are charged more than the checkout total, tell us. We will verify the transactions with the gateway and, where the extra payment is confirmed, refund it. Where the gateway or your bank has already reversed a payment automatically, no refund from us is needed. We distinguish refunds that we initiate from reversals that your bank or the payment provider carries out.</p>
  </> },
  { id: "unauthorised", title: "Incorrect Amount or Unauthorised Transactions", body: <>
    <p>If an amount differs from what you were shown or you did not authorise a transaction, report it to us immediately at {mail} and to your bank or card issuer. We can check whether the transaction relates to an order on our website, but we are not a bank. Unauthorised-transaction and chargeback procedures are run by your bank, card network or UPI provider, and you are free to use them at any time.</p>
  </> },
  { id: "company-cancel", title: "Company-Initiated Cancellation", body: <>
    <p>If we cannot fulfil an accepted order, for example because of a pricing error, a service we cannot deliver, or a payment we cannot verify, we will tell you and refund in full what you paid for that order. We do not charge a cancellation fee when we cancel.</p>
  </> },
  { id: "procedure", title: "Refund Request Procedure", body: <>
    <p>Email {mail}. <Tbc>Owner to confirm this mailbox is monitored and who handles it before publication.</Tbc> Please include:</p>
    <ul>
      <li>your name and the email and phone number used at checkout;</li>
      <li>the order ID (it starts with "FIR-") or the transaction reference;</li>
      <li>payment date, amount and method;</li>
      <li>the reason for your request and any supporting evidence, such as a payment screenshot.</li>
    </ul>
    <p><strong>Never send your PIN, password, OTP, full card number, CVV or UPI credentials.</strong> We will never ask for them. Requests are reviewed manually.</p>
  </> },
  { id: "review", title: "Refund Review and Eligibility", body: <>
    <ol>
      <li>We acknowledge your request.</li>
      <li>We verify the transaction against payment gateway records.</li>
      <li>We assess eligibility under this policy.</li>
      <li>We approve or reject the request and tell you the reason in writing.</li>
      <li>If approved, we start the refund through the payment channel described below.</li>
      <li>If you are not satisfied with the outcome, you may escalate as described under "Grievance Escalation".</li>
    </ol>
    <p>We do not provide an online refund-tracking page. We will update you by email or phone.</p>
  </> },
  { id: "timing", title: "Refund Processing Time", body: <>
    <p>A refund involves several different steps, and only the first three are in our control. We have not published fixed timeframes for our own steps. <Tbc>Owner to approve refund service levels (docs/LEGAL_OWNER_DECISIONS.md item 3). Proposed figures stay out of public copy until approved.</Tbc></p>
    <ol>
      <li><strong>Acknowledgement:</strong> we confirm that we have received your request.</li>
      <li><strong>Eligibility review:</strong> carried out once we have all the information.</li>
      <li><strong>Refund initiation:</strong> we start the refund after approval.</li>
      <li><strong>Payment provider processing:</strong> set by the gateway.</li>
      <li><strong>Bank credit or reversal:</strong> set by your bank or card issuer; we cannot promise a date.</li>
    </ol>
    <p>If a law or regulator sets a mandatory time for a step, that time applies instead.</p>
  </> },
  { id: "method", title: "Original Payment Method", body: <>
    <p>We aim to send approved refunds back through the payment channel you used, as far as the payment gateway and your bank allow. Because refunds are processed by hand through the gateway's merchant tools or an agreed alternative, we cannot promise automatic return to the original source in every case. If original-source refund is not possible, we will ask you for an alternative way to receive the money.</p>
  </> },
  { id: "partial", title: "Partial Refunds", body: <>
    <p>A partial refund may apply where a service was partly delivered, where milestones were completed, or where only part of an order is affected. We will give you the amount paid, the value of work delivered or costs deducted, and the refund amount, so you can see how it was worked out.</p>
  </> },
  { id: "non-refundable", title: "Non-Refundable Situations", body: <>
    <p>Subject to your statutory rights, we may decline a refund where: a service was fully performed in line with the agreed scope and accepted; an agreed milestone was completed and approved; the request is for change of mind on a digital product that was delivered and works; a third-party charge was disclosed to you and cannot be recovered; or the request is based on facts we have verified to be untrue. These exclusions do not apply to non-delivery, deficient service, wrong product, or other cases protected by law.</p>
  </> },
  { id: "exceptions", title: "Exceptions and Consumer Remedies", body: <>
    <p>Nothing in this policy limits your remedies for non-delivery, deficiency in service, supply of the wrong goods or products, unfair contract terms, or any other right under the Consumer Protection Act, 2019 or other applicable law. You may approach the National Consumer Helpline (1915) or the appropriate Consumer Commission.</p>
  </> },
  { id: "chargebacks", title: "Chargebacks and Disputes", body: <>
    <p>You may raise a dispute with your bank, card issuer or payment provider at any time and we will not discourage that. We will respond to genuine dispute enquiries with the records we hold. We ask that you contact us first when practical, since many issues can be solved faster directly.</p>
  </> },
  { id: "escalation", title: "Grievance Escalation", body: <>
    <p>Complaints can be sent to {mail} or by phone to <a href={`tel:+91${COMPANY.phone}`}>{COMPANY.phone}</a>. Write "Grievance" in the subject line to escalate an unresolved request.</p>
    <p><Tbc>Owner to name a Grievance Officer (name, designation, contact details) and a response time. No grievance officer is named here because none has been supplied, and none has been invented.</Tbc></p>
  </> },
  { id: "amendments", title: "Amendments and Contact Details", body: <>
    <p>We may amend this policy by publishing a new version on this page. An amendment applies to orders placed after it is published; for earlier orders, the policy in force when you placed the order continues to apply unless the new version is more favourable to you. See also our {privacy} for how we handle the information you send us.</p>
    <LegalContactDetails />
    <p>Version 0.1 (draft). <Tbc>Effective date to be set on owner approval.</Tbc></p>
  </> },
];

export default function RefundAndCancellationPolicy() {
  return (
    <LegalPageLayout
      title="Refund & Cancellation Policy"
      path="/refund-and-cancellation-policy"
      sections={sections}
      intro={<p>This policy sets out how cancellations and refunds work for orders placed with {COMPANY.brand}, and how to ask for one. Please read it together with our {terms}.</p>}
    />
  );
}
