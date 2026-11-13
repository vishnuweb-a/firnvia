import { Link, NavLink, useLocation } from "react-router-dom";
import { useState } from "react";
import { useCart } from "../context/CartContext.jsx";
import { POLICIES } from "../legal/company.js";

const LINKS = [
  ["/", "Home"],
  ["/shop", "Shop"],
  ["/about", "About Us"],
  ["/faq", "FAQ"],
  ["/policies", "Policies"],
  ["/contact", "Contact Us"],
];

export default function Header({ onCartClick }) {
  const { count } = useCart();
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  // Child pages highlight their parent: product pages → Shop, policy pages → Policies.
  const parent = pathname.startsWith("/product/") ? "/shop" : POLICIES.some(([p]) => p === pathname) ? "/policies" : null;
  return (
    <header className="header" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
      <div className="container nav">
        <Link to="/" className="brand" aria-label="Firvanra home">
          Firv<span>anra</span>
        </Link>
        {/* NavLink adds class "active" and aria-current="page" on the current page. */}
        <nav id="site-nav" aria-label="Main" className={`nav-links ${open ? "mobile-open" : ""}`}>
          {LINKS.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => (isActive || parent === to ? "active" : undefined)} onClick={() => setOpen(false)}>{label}</NavLink>
          ))}
        </nav>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <button className="cart-btn" onClick={onCartClick} aria-label={`Open cart, ${count} item${count === 1 ? "" : "s"}`}>
            🛒
            {count > 0 && <span className="cart-badge">{count}</span>}
          </button>
          <button className="hamburger" onClick={() => setOpen((o) => !o)} aria-label="Menu" aria-expanded={open} aria-controls="site-nav">
            {open ? "✕" : "☰"}
          </button>
        </div>
      </div>
    </header>
  );
}
