import { useState } from "react";
import { Link } from "react-router-dom";
import App from "../App.jsx";
import Footer from "./Footer.jsx";
import { COMPANY, POLICIES, LEGAL_VERSION, DRAFT_PREPARED, EFFECTIVE_DATE } from "../legal/company.js";

// Owner-review notes are no longer shown on the site; they are tracked in
// docs/LEGAL_OWNER_DECISIONS.md. Kept as a no-op so the markers stay in the source.
export function Tbc() {
  return null;
}

export function LegalContactDetails() {
  return (
    <address className="legal-address">
      <strong>{COMPANY.legalName}</strong> (brand: {COMPANY.brand})<br />
      {COMPANY.address}<br />
      Email: <a href={`mailto:${COMPANY.email}`}>{COMPANY.email}</a><br />
      Phone: <a href={`tel:+91${COMPANY.phone}`}>{COMPANY.phone}</a><br />
      Website: <a href={COMPANY.website}>{COMPANY.website.replace("https://", "")}</a>
    </address>
  );
}

export function LegalSection({ n, id, title, children }) {
  return (
    <section className="legal-section" id={id} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}><span className="legal-num">{n}.</span> {title}</h2>
      {children}
    </section>
  );
}

function PolicyTableOfContents({ sections }) {
  return (
    <nav className="legal-toc" aria-label="On this page">
      <h2>On this page</h2>
      <ol>
        {sections.map((s, i) => (
          <li key={s.id}><a href={`#${s.id}`}>{i + 1}. {s.title}</a></li>
        ))}
      </ol>
    </nav>
  );
}

export { POLICIES };

// sections: [{ id, title, body: ReactNode }]
export default function LegalPageLayout({ title, intro, sections, path }) {
  const [open, setOpen] = useState(false);
  return (
    <App>
      <main className="page legal">
        <div className="container legal-wrap">
          <aside className="legal-side">
            <button className="legal-toc-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
              Contents
            </button>
            <div className={open ? "legal-toc-box open" : "legal-toc-box"} onClick={() => setOpen(false)}>
              <PolicyTableOfContents sections={sections} />
            </div>
          </aside>
          <article className="legal-body">
            <span className="eyebrow">Legal</span>
            <h1>{title} — Firvanra</h1>
            <p className="legal-meta">
              Version {LEGAL_VERSION} ·{" "}
              {EFFECTIVE_DATE ? `Effective ${EFFECTIVE_DATE}` : `Effective date: not yet published (draft prepared ${DRAFT_PREPARED})`}
            </p>
            <div className="legal-intro">{intro}</div>
            {sections.map((s, i) => (
              <LegalSection key={s.id} n={i + 1} id={s.id} title={s.title}>{s.body}</LegalSection>
            ))}
            <p className="legal-also">
              Related policies:{" "}
              {POLICIES.filter(([p]) => p !== path).map(([p, l]) => (
                <span key={p}><Link to={p}>{l}</Link> · </span>
              ))}
              <Link to="/policies">All policies</Link>
            </p>
          </article>
        </div>
      </main>
      <Footer />
    </App>
  );
}
