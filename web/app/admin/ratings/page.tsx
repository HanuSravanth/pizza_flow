"use client";

// Ratings: aggregates of the star ratings/feedback customers leave on the
// bill page after paying (see the "Rate your order" section in app/page.tsx).
// Read-only — no admin actions here, just the numbers.

import { useEffect, useMemo, useState } from "react";
import { computePizzaRatingSummary } from "@/lib/analytics";
import { formatDateTime } from "@/lib/format";
import { getOrderFeedback, isDemoMode, type OrderFeedbackRecord } from "@/lib/data";

const PAGE_SIZE = 10;

export default function RatingsPage() {
  const [feedback, setFeedback] = useState<OrderFeedbackRecord[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [page, setPage] = useState(0);

  useEffect(() => {
    getOrderFeedback()
      .then(setFeedback)
      .catch((error: Error) => setLoadError(error.message));
  }, []);

  const pageCount = Math.max(1, Math.ceil((feedback?.length ?? 0) / PAGE_SIZE));
  const pageClamped = Math.min(page, pageCount - 1);
  const pagedFeedback = useMemo(
    () => (feedback ?? []).slice(pageClamped * PAGE_SIZE, pageClamped * PAGE_SIZE + PAGE_SIZE),
    [feedback, pageClamped],
  );

  if (loadError) return <div className="banner banner-error">Could not load ratings: {loadError}</div>;
  if (!feedback) return <p className="page-sub">Loading ratings…</p>;

  const summary = computePizzaRatingSummary(feedback);

  return (
    <>
      <h1>Ratings</h1>
      <p className="page-sub">What customers thought, straight from the bill-page feedback form.</p>
      {isDemoMode && (
        <div className="banner banner-demo">
          <strong>Demo mode:</strong> feedback comes from this browser&apos;s storage.
        </div>
      )}

      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">Feedback received</div>
          <div className="stat-value">{summary.feedbackCount}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Overall avg rating</div>
          <div className="stat-value">
            {summary.overallAvgRating != null ? `★ ${summary.overallAvgRating}` : "—"}
          </div>
          <div className="stat-sub">
            {summary.overallRatingCount > 0
              ? `from ${summary.overallRatingCount} rating${summary.overallRatingCount > 1 ? "s" : ""}`
              : "no overall ratings yet"}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Pizzas rated</div>
          <div className="stat-value">{summary.pizzas.length}</div>
        </div>
      </div>

      <div className="card">
        <h2>Top rated pizzas</h2>
        <div className="table-scroll">
          <table className="orders-table">
            <thead>
              <tr>
                <th>Pizza</th>
                <th>Avg rating</th>
                <th>Number of ratings</th>
              </tr>
            </thead>
            <tbody>
              {summary.pizzas.length === 0 && (
                <tr>
                  <td colSpan={3} style={{ color: "var(--muted)" }}>
                    No ratings yet.
                  </td>
                </tr>
              )}
              {summary.pizzas.map((p) => (
                <tr key={p.pizzaName}>
                  <td>{p.pizzaName}</td>
                  <td>★ {p.avgRating}</td>
                  <td>{p.ratingCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Feedback by order</h2>
        <p className="page-sub">Every submission, with the order it came from and the customer&apos;s comments.</p>
        <div className="table-scroll">
          <table className="orders-table">
            <thead>
              <tr>
                <th>Order ID</th>
                <th>When</th>
                <th>Overall</th>
                <th>Pizza ratings</th>
                <th>Tags</th>
                <th>Comments</th>
              </tr>
            </thead>
            <tbody>
              {feedback.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ color: "var(--muted)" }}>
                    No feedback yet.
                  </td>
                </tr>
              )}
              {pagedFeedback.map((entry) => (
                <tr key={entry.id}>
                  <td title={entry.orderId}>
                    <code>{entry.orderId ? entry.orderId.slice(0, 8).toUpperCase() : "—"}</code>
                  </td>
                  <td>{formatDateTime(entry.createdAt)}</td>
                  <td>{entry.overallRating != null ? `★ ${entry.overallRating}` : "—"}</td>
                  <td>
                    {Object.entries(entry.pizzaRatings).length === 0
                      ? "—"
                      : Object.entries(entry.pizzaRatings).map(([name, rating]) => (
                          <div key={name}>
                            {name}: ★ {rating}
                          </div>
                        ))}
                  </td>
                  <td>{entry.quickTags.length > 0 ? entry.quickTags.join(", ") : "—"}</td>
                  <td>{entry.comments || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {feedback.length > 0 && (
          <div className="pagination-bar">
            <span>
              {pageClamped * PAGE_SIZE + 1}–{Math.min((pageClamped + 1) * PAGE_SIZE, feedback.length)} of{" "}
              {feedback.length}
            </span>
            <div className="pagination-controls">
              <button
                className="btn btn-small btn-secondary"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={pageClamped === 0}
              >
                Prev
              </button>
              <span>
                Page {pageClamped + 1} of {pageCount}
              </span>
              <button
                className="btn btn-small btn-secondary"
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={pageClamped >= pageCount - 1}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
