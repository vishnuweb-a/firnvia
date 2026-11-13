import { Link } from "react-router-dom";
import PageLayout from "../components/PageLayout.jsx";

export default function NotFound() {
  return (
    <PageLayout title="Page not found" lead="The page you are looking for does not exist or has moved.">
      <p><Link className="btn btn-primary" to="/">Back to home</Link> <Link className="btn btn-ghost" to="/shop">Browse the shop</Link></p>
    </PageLayout>
  );
}
