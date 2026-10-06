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
            <a href="#about" className="btn btn-primary">Know more</a>
            <a href="#contact" className="btn btn-ghost">Contact us</a>
          </div>
        </div>
        <div className="hero-art">
          <div className="blob b1" />
          <div className="blob b2" />
          {/* Replace with the client's hero image: <img src="/img/hero.png" alt="" /> */}
          <div className="tag">Bring excellency with our expertise</div>
        </div>
      </div>
    </section>
  );
}
