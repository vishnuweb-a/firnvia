const micro = [
  { title: "Website business setup", desc: "Professional setup to build a strong online presence and grow digitally.", help: "Strategy, design, development, and full setup for a smooth launch." },
  { title: "Website speed boost", desc: "Faster loading, better UX, and stronger search performance.", help: "We fix slow-loading issues and improve overall speed and stability." },
  { title: "E-commerce support", desc: "Manage, optimize, and grow your online store smoothly.", help: "Store setup, product management, and technical eCommerce support." },
  { title: "Video editing", desc: "Editing for ads, social, branding, and engaging visual content.", help: "Smooth transitions, effects, storytelling, and brand-focused visuals." },
  { title: "AI automation", desc: "Streamline tasks and automate business operations.", help: "Custom AI workflows, integrations, and automation tailored to you." },
  { title: "Website UI design", desc: "Modern, creative interfaces focused on UX and conversions.", help: "Clean, responsive designs tailored to your business goals." },
];

export default function MicroServices() {
  return (
    <section className="section" id="micro">
      <div className="container">
        <span className="eyebrow">What we do</span>
        <h2 className="section-title">Our micro services</h2>
        <p className="lead">Focused, fast-turnaround services to support specific needs.</p>
        <div className="micro" style={{ marginTop: 36 }}>
          {micro.map((m) => (
            <div className="micro-item" key={m.title}>
              <h3>{m.title}</h3>
              <p>{m.desc}</p>
              <div className="help">
                <strong>How Firvanra helps</strong>
                <p>{m.help}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
