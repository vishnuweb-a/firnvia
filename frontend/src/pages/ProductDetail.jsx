import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import App from "../App.jsx";
import Footer from "../components/Footer.jsx";
import { useCart } from "../context/CartContext.jsx";
import { COMPANY } from "../legal/company.js";
import { CATEGORIES, DETAILS, TYPE_LABEL, inr, useProducts } from "../content/products.js";
import { setSeo } from "../seo.js";

// Facts by product type. Each line restates the published Terms & Conditions.
const SERVICE_INFO = [
  ["Format", "A digital service. Nothing physical is shipped."],
  ["After you order", "Orders are handled by our team, not automatically. Once your payment is confirmed we contact you using the email address or phone number you gave at checkout."],
  ["When work starts", "Work begins once we have what we need from you. We give a time estimate when work starts; estimates are not guarantees."],
  ["What we need from you", "Content, access details, approvals and feedback relevant to the work. Delays in providing these extend the timeline."],
  ["Scope", "The description on this page, together with any written confirmation from us, defines what you are buying. Work beyond it is quoted and agreed with you first."],
];
const EBOOK_INFO = [
  ["Format", "A digital product (ebook). Nothing physical is shipped."],
  ["Delivery", "Sent to you by our team after your payment is confirmed, normally by email to the address you give at checkout. It is not an instant download."],
  ["Licence", "A personal, non-transferable licence for your own learning or internal business use. It may not be copied, resold, shared or published."],
  ["Before you buy", "Page count and file format are not listed here. If you need to know either before ordering, please ask us."],
  ["Refunds", "Digital products are not refunded for change of mind once delivered. If the file is corrupt, is not what you ordered, or never arrives, we replace it or refund you."],
];

export default function ProductDetail() {
  const { id } = useParams();
  const { products, loading, error } = useProducts();
  const { add } = useCart();
  const product = products.find((p) => p.id === id);
  const detail = DETAILS[id];
  const path = `/product/${id}`;

  useEffect(() => {
    if (product) setSeo({ title: `${product.title} — Firvanra`, description: `${product.blurb} ${inr(product.price)}.`, path });
    else if (!loading) setSeo({ title: "Product not found — Firvanra", description: "This product is not in the Firvanra catalogue.", path, noindex: true });
  }, [product, loading, path]);

  // No availability, rating or review fields: the site has no stock data and no reviews.
  const jsonLd = product && JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
    description: product.blurb,
    sku: product.id,
    category: CATEGORIES[product.type],
    brand: { "@type": "Brand", name: COMPANY.brand },
    offers: { "@type": "Offer", url: COMPANY.website + path, priceCurrency: "INR", price: product.price },
  }).replace(/</g, "\\u003c");

  return (
    <App>
      {({ openCart }) => (
        <>
          <main className="page">
            <div className="container">
              {loading && <p className="lead" role="status">Loading product…</p>}
              {error && <div className="notice err">We couldn't load this product. Please refresh the page to try again.</div>}
              {!loading && !error && !product && (
                <header className="page-head">
                  <h1>Product not found</h1>
                  <p className="lead">This product is not in our catalogue. <Link className="text-link" to="/shop">Browse all products</Link>.</p>
                </header>
              )}
              {product && (
                <article>
                  <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
                  <nav className="crumbs" aria-label="Breadcrumb">
                    <Link to="/shop">Shop</Link> / <Link to={`/shop?category=${product.type}`}>{CATEGORIES[product.type]}</Link> / <span aria-current="page">{product.title}</span>
                  </nav>
                  <div className="pd-grid">
                    <div className="prose">
                      <span className="eyebrow">{TYPE_LABEL[product.type]}</span>
                      <h1>{product.title}</h1>
                      <p className="pd-overview">{product.blurb}</p>

                      {detail && (
                        <>
                          <h2>What it covers</h2>
                          <ul>{detail.covers.map((c) => <li key={c}>{c}</li>)}</ul>
                          <h2>Who it is for</h2>
                          <p>{detail.use}</p>
                          {detail.note && <p>{detail.note}</p>}
                        </>
                      )}

                      <h2>Good to know</h2>
                      <dl className="pd-facts">
                        {(product.type === "ebook" ? EBOOK_INFO : SERVICE_INFO).map(([k, v]) => (
                          <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
                        ))}
                      </dl>
                    </div>

                    <aside className="panel pd-buy" aria-label="Price and ordering">
                      <div className="pd-price">{inr(product.price)}</div>
                      <p className="pd-meta">Price in INR. The cart total is the amount you pay at checkout; no shipping or delivery fee is added.</p>
                      <p className="pd-meta"><strong>Availability:</strong> available to order online.</p>
                      <button className="btn btn-accent" style={{ width: "100%" }} onClick={() => { add(product); openCart(); }}>
                        Add to cart
                      </button>
                      <ul className="pd-links">
                        <li><Link to="/shipping-and-delivery-policy">Shipping &amp; Delivery Policy</Link></li>
                        <li><Link to="/refund-and-cancellation-policy">Refund &amp; Cancellation Policy</Link></li>
                        <li><Link to="/contact">Ask a question about this product</Link></li>
                      </ul>
                    </aside>
                  </div>
                </article>
              )}
            </div>
          </main>
          <Footer />
        </>
      )}
    </App>
  );
}
