import { Link } from "react-router-dom";

export default function Hero() {
  return (
    <section className="hero" id="home">
      <div className="container hero-grid">
        <div>
          <span className="eyebrow">Firvanra.online</span>
          <h1>
            Your software and <em>IT growth</em> partner
          </h1>
          <p>
            A results-driven team that plans, builds, and ships seamless software
            solutions — from first sketch to launch and beyond.
          </p>
          <div className="hero-cta">
            <Link to="/shop" className="btn btn-primary">Browse the shop</Link>
            <Link to="/about" className="btn btn-ghost">Know more</Link>
          </div>
        </div>
        <div className="hero-art">
          <div className="blob b1" />
          <div className="blob b2" />
          <div className="tag">Bring excellency with our expertise</div>
        </div>
      </div>
    </section>
  );
}
