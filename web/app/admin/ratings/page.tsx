"use client";

// Ratings: aggregates of the star ratings/feedback customers leave on the
// bill page after paying (see the "Rate your order" section in app/page.tsx).
// Read-only — no admin actions here, just the numbers.

import { useEffect, useMemo, useState } from "react";
import {
  buildFeedbackDataset,
  computePizzaRatingSummary,
  type FeedbackAnalysis,
  type FeedbackEntryForAi,
  type RatingSummary,
} from "@/lib/analytics";
import { formatDateTime } from "@/lib/format";
import { getEffectiveAiFeatures, getOrderFeedback, isDemoMode, type OrderFeedbackRecord } from "@/lib/data";

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

      <FeedbackAiPanel feedback={feedback} summary={summary} />

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

// ------------------------------------------------------- AI feedback analyst
// The LLM clusters recent feedback into themes but may only cite entries by
// index; the route validates the indexes and this panel recomputes every count
// and pulls every quote from the actual entries — the model never states a
// number the app didn't verify.

function FeedbackAiPanel({ feedback, summary }: { feedback: OrderFeedbackRecord[]; summary: RatingSummary }) {
  const [enabled, setEnabled] = useState(false);
  const [analysis, setAnalysis] = useState<FeedbackAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getEffectiveAiFeatures()
      .then((features) => setEnabled(features.feedback))
      .catch(() => {});
  }, []);

  const dataset = useMemo(() => buildFeedbackDataset(feedback), [feedback]);
  const byIndex = useMemo(() => new Map(dataset.map((e) => [e.index, e])), [dataset]);

  if (!enabled || feedback.length === 0) return null;

  async function analyse() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/ai/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entries: dataset,
          stats: {
            overallAvgRating: summary.overallAvgRating,
            overallRatingCount: summary.overallRatingCount,
            feedbackCount: summary.feedbackCount,
          },
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not analyse the feedback.");
      setAnalysis(payload.analysis);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not analyse the feedback — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h2>What the feedback is telling you</h2>
      <p className="page-sub">
        Groups the {dataset.length} most recent submissions into themes — what to fix and why it
        probably happens. For your eyes only; nothing here is sent to any customer. Counts and
        quotes are verified against the actual entries.
      </p>

      {!analysis && (
        <button className="btn" onClick={analyse} disabled={busy}>
          {busy ? "Analysing…" : "Analyse the feedback"}{" "}
          <span className="ai-sparkle" aria-hidden="true">✦</span>
        </button>
      )}
      {error && <p className="error-text" style={{ marginTop: 10 }}>{error}</p>}

      {analysis && (
        <>
          {analysis.themes.length === 0 && (
            <p className="page-sub">{analysis.note || "Not enough feedback yet to find reliable themes."}</p>
          )}
          {analysis.themes.map((theme, idx) => {
            const supporting = theme.entryIndexes
              .map((i) => byIndex.get(i))
              .filter((e): e is FeedbackEntryForAi => Boolean(e));
            const quotes = supporting.filter((e) => e.comment).slice(0, 2);
            return (
              <div key={idx} className="theme-block">
                <p style={{ margin: "0 0 4px" }}>
                  <span className={`sentiment sentiment-${theme.sentiment}`}>{theme.sentiment}</span>{" "}
                  <strong>{theme.title}</strong>{" "}
                  <span className="page-sub" style={{ fontSize: 12.5 }}>
                    — {supporting.length} of {dataset.length} entries
                  </span>
                </p>
                {quotes.map((q) => (
                  <p key={q.index} className="quote">
                    “{q.comment}” <span style={{ fontStyle: "normal" }}>({q.dayOfWeek} {q.hour})</span>
                  </p>
                ))}
                {theme.rootCause && (
                  <p className="page-sub" style={{ margin: "4px 0" }}>
                    <strong>Likely cause:</strong> {theme.rootCause}
                  </p>
                )}
                {theme.suggestedAction && (
                  <p className="page-sub" style={{ margin: "4px 0" }}>
                    <strong>Try this week:</strong> {theme.suggestedAction}
                  </p>
                )}
              </div>
            );
          })}
          {analysis.themes.length > 0 && analysis.note && (
            <p className="page-sub" style={{ marginTop: 10 }}>{analysis.note}</p>
          )}
          <button className="btn btn-small btn-secondary" style={{ marginTop: 12 }} onClick={analyse} disabled={busy}>
            {busy ? "Analysing…" : "Analyse again"}{" "}
            <span className="ai-sparkle" aria-hidden="true">✦</span>
          </button>
        </>
      )}
    </div>
  );
}
