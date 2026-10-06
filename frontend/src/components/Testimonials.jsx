const items = [
  { role: "Website design service", quote: "A modern site and smooth automation setup — professional, fast, and they understood our business.", name: "Client A", place: "India", initials: "CA" },
  { role: "Performance optimization", quote: "From design to performance tuning, everything was handled well and delivered on time.", name: "Client B", place: "India", initials: "CB" },
  { role: "Video editing", quote: "The videos gave our brand a fresh look — engaging and perfect for our campaigns.", name: "Client C", place: "India", initials: "CC" },
];

export default function Testimonials() {
  return (
    <section className="section tband">
      <div className="container">
        <span className="eyebrow">Firvanra.online</span>
        <h2 className="section-title">Our testimonials</h2>
        <p className="lead">
          Our customers speak for us — real results that made an impact day to day.
        </p>
        <div className="t-grid">
          {items.map((t) => (
            <div className="t-card" key={t.name}>
              <div className="role">{t.role}</div>
              <p className="quote">"{t.quote}"</p>
              <div className="who">
                <div className="avatar">{t.initials}</div>
                <div>
                  <b>{t.name}</b>
                  <small>{t.place}</small>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
