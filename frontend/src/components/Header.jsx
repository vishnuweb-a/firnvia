import { Link } from "react-router-dom";
import { useState } from "react";
import { useCart } from "../context/CartContext.jsx";

export default function Header({ onCartClick }) {
  const { count } = useCart();
  const [open, setOpen] = useState(false);
  return (
    <header className="header">
      <div className="container nav">
        <Link to="/" className="brand">
          Firv<span>anra</span>
        </Link>
        <nav className={`nav-links ${open ? "mobile-open" : ""}`}>
          <Link to="/#home" onClick={() => setOpen(false)}>Home</Link>
          <Link to="/#services" onClick={() => setOpen(false)}>Our Services</Link>
          <Link to="/#about" onClick={() => setOpen(false)}>About us</Link>
          <Link to="/#contact" onClick={() => setOpen(false)}>Contact us</Link>
        </nav>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <button className="cart-btn" onClick={onCartClick} aria-label="Open cart">
            🛒
            {count > 0 && <span className="cart-badge">{count}</span>}
          </button>
          <button className="hamburger" onClick={() => setOpen((o) => !o)} aria-label="Menu">
            ☰
          </button>
        </div>
      </div>
    </header>
  );
}
