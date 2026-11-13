import { Link } from "react-router-dom";
import PageLayout from "../components/PageLayout.jsx";
import { POLICIES } from "../components/LegalLayout.jsx";

const SUMMARY = {
  "/privacy-policy": "What personal data we collect through the website, why we use it and who receives it.",
  "/terms-and-conditions": "The terms for using the website and buying services or digital products: ordering, pricing, payments and responsibilities.",
  "/shipping-and-delivery-policy": "How services and ebooks are delivered. Nothing is physically shipped and there are no shipping charges.",
  "/refund-and-cancellation-policy": "How to cancel an order or ask for a refund, and how failed, duplicate or unconfirmed payments are handled.",
};

export default function Policies() {
  return (
    <PageLayout
      eyebrow="Legal"
      title="Policies"
      lead="The policies that apply when you browse, order from or contact Firvanra. Choose one to read it in full."
    >
      <ul className="grid policy-grid">
        {POLICIES.map(([path, label]) => (
          <li key={path} className="card">
            <h2><Link to={path}>{label}</Link></h2>
            <p>{SUMMARY[path]}</p>
            <Link to={path} className="text-link" aria-hidden="true" tabIndex={-1}>Read policy →</Link>
          </li>
        ))}
      </ul>
      <p className="faq-more">Looking for a quick answer? See the <Link className="text-link" to="/faq">FAQ</Link> or <Link className="text-link" to="/contact">contact us</Link>.</p>
    </PageLayout>
  );
}
