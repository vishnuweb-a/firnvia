import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import PageLayout from "../components/PageLayout.jsx";
import ProductCard from "../components/ProductCard.jsx";
import { CATEGORIES, useProducts } from "../content/products.js";

export default function Shop() {
  const { products, loading, error } = useProducts();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const category = CATEGORIES[params.get("category")] ? params.get("category") : "all";

  const q = query.trim().toLowerCase();
  const shown = products.filter(
    (p) => (category === "all" || p.type === category) && (!q || `${p.title} ${p.blurb}`.toLowerCase().includes(q))
  );

  return (
    <PageLayout
      eyebrow="Shop"
      title="All services & ebooks"
      lead="Everything you can order online from Firvanra. Prices are in INR and the cart total is what you pay at checkout."
    >
      {({ openCart }) => (
        <>
          <div className="shop-bar">
            <div className="chips" role="group" aria-label="Filter by category">
              {[["all", "All"], ...Object.entries(CATEGORIES)].map(([id, label]) => (
                <button
                  key={id}
                  className="chip"
                  aria-pressed={category === id}
                  onClick={() => setParams(id === "all" ? {} : { category: id }, { replace: true })}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="field shop-search">
              <label htmlFor="shop-search" className="sr-only">Search products</label>
              <input id="shop-search" type="search" placeholder="Search services and ebooks" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          </div>

          <p className="shop-count" role="status">
            {loading ? "Loading products…" : error ? "" : `${shown.length} of ${products.length} products`}
          </p>
          {error && <div className="notice err">We couldn't load the catalogue. Please refresh the page to try again.</div>}
          {!loading && !error && shown.length === 0 && (
            <p className="empty">No products match your search. Try a different word or choose “All”.</p>
          )}
          <div className="grid grid-3">
            {shown.map((p) => <ProductCard key={p.id} product={p} onAdded={openCart} />)}
          </div>
        </>
      )}
    </PageLayout>
  );
}
