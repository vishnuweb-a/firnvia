import App from "../App.jsx";
import Footer from "./Footer.jsx";

// Shell for content pages: header/cart from App, one <h1>, footer.
// children may be a function to receive { openCart }.
export default function PageLayout({ eyebrow, title, lead, children }) {
  return (
    <App>
      {(ctx) => (
        <>
          <main className="page">
            <div className="container">
              <header className="page-head">
                {eyebrow && <span className="eyebrow">{eyebrow}</span>}
                <h1>{title}</h1>
                {lead && <p className="lead">{lead}</p>}
              </header>
              {typeof children === "function" ? children(ctx) : children}
            </div>
          </main>
          <Footer />
        </>
      )}
    </App>
  );
}
