import Link from "next/link";

export default function NotFound() {
  return (
    <div style={{ padding: "80px 20px", textAlign: "center", maxWidth: "480px", margin: "0 auto" }}>
      <div className="card">
        <h1 style={{ fontSize: "3rem", margin: "0 0 10px 0" }}>404</h1>
        <h2>Page Not Found</h2>
        <p className="page-sub" style={{ margin: "10px 0 20px 0" }}>
          The page you are looking for does not exist or has been moved.
        </p>
        <Link href="/" className="btn" style={{ display: "inline-block", width: "100%" }}>
          Return to Ordering
        </Link>
      </div>
    </div>
  );
}
