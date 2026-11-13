import { Link } from "react-router-dom";
import PageLayout from "../components/PageLayout.jsx";
import { LegalContactDetails } from "../components/LegalLayout.jsx";
import { COMPANY } from "../legal/company.js";

export default function About() {
  return (
    <PageLayout
      eyebrow="About us"
      title={`About ${COMPANY.brand}`}
      lead={`${COMPANY.legalName} is a technology company based in Delhi, India. Through this website we sell website and automation services and practical business ebooks.`}
    >
      <div className="prose">
        <h2>What we sell</h2>
        <p>Everything on this website is a digital service or a digital product. We do not sell or ship physical goods.</p>
        <ul>
          <li><strong>Service packages</strong> you can order online: website redesign, technical website audits, WordPress care and error fixing, conversion optimisation, and data and automation basics.</li>
          <li><strong>Ebooks</strong> on digital security, analytics and data tracking, performance marketing and social media management.</li>
          <li><strong>Micro services</strong> such as website setup, speed improvement, e-commerce support, video editing, AI automation and website UI design. These are not sold through the cart; we agree scope and price with you first.</li>
        </ul>
        <p><Link to="/shop">Browse all services and ebooks</Link></p>

        <h2>Our purpose and how we choose what to offer</h2>
        <p>We aim to help businesses get practical website and digital work done without a long sales process. The packages listed for online ordering are the ones we can describe clearly and price up front. Work that needs a conversation about scope before a price makes sense is kept out of the cart and handled by enquiry instead.</p>

        <h2>The shopping experience</h2>
        <ul>
          <li>Each product has its own page with a description, what it covers and its price in INR.</li>
          <li>You add items to a cart and check out without creating an account. We ask for your name, email address and phone number.</li>
          <li>Payment is made on the secure page of the payment gateway you choose at checkout. Card, UPI and banking details are entered there, not on our website.</li>
          <li>After payment you return to an order status page that shows your order ID and whether the payment succeeded.</li>
          <li>Orders are fulfilled by our team, not automatically. We contact you using the details you gave at checkout.</li>
        </ul>

        <h2>Clear information and support</h2>
        <p>We try to say plainly what each product includes, and equally what the website does not do. Product pages do not list details we have not confirmed, and our policies describe how ordering, delivery, cancellations and refunds work today.</p>
        <p>Support is handled by people, by email and phone. See the <Link to="/faq">FAQ</Link> for common questions and the <Link to="/policies">Policies</Link> page for the full terms.</p>

        <h2>How to contact us</h2>
        <LegalContactDetails />
        <p>The same details are on our <Link to="/contact">Contact page</Link>.</p>
      </div>
    </PageLayout>
  );
}
