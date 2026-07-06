'use client';

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Application error boundary triggered:", error);
  }, [error]);

  return (
    <div style={{ padding: "80px 20px", textAlign: "center", maxWidth: "480px", margin: "0 auto" }}>
      <div className="card">
        <h1 style={{ fontSize: "3rem", margin: "0 0 10px 0", color: "var(--color-error, #e11d48)" }}>Error</h1>
        <h2>Something went wrong</h2>
        <p className="page-sub" style={{ margin: "10px 0 20px 0" }}>
          We encountered an unexpected error. Please try reloading the interface.
        </p>
        <button
          onClick={() => reset()}
          className="btn"
          style={{ width: "100%" }}
        >
          Try Again
        </button>
      </div>
    </div>
  );
}
