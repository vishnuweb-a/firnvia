import { useState } from "react";
import { useCart } from "../context/CartContext.jsx";

export default function Header({ onCartClick }) {
  const { count } = useCart();
  const [open, setOpen] = useState(false);
  return (
    <header className="header">
      <div className="container nav">
        <a href="/" className="brand">
          Firv<span>anra</span>
        </a>
        <nav className={`nav-links ${open ? "mobile-open" : ""}`}>
          <a href="#home" onClick={() => setOpen(false)}>Home</a>
          <a href="#services" onClick={() => setOpen(false)}>Our Services</a>
          <a href="#about" onClick={() => setOpen(false)}>About us</a>
          <a href="#contact" onClick={() => setOpen(false)}>Contact us</a>
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
