"use client";

// Floating "Ask your business anything" widget — the Owner Insights Copilot,
// available from any admin screen (dashboard, menu management, settings) as
// a pizza-slice bubble in the corner. It fetches and aggregates orders
// itself on first open, so it doesn't depend on which page it's mounted on.
//
// The dashboard's "Today's digest" button also drives this widget (via
// lib/insightsChatBus): it opens the popup and generates the end-of-day report
// as a chat answer, so the digest lives in the conversation rather than its own
// box. That's why the free-form "ask" UI is gated on `insightsEnabled` while
// the digest works whenever `digestEnabled` — the two AI features toggle
// independently in admin settings.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { computeAggregates, computePizzaRatingSummary, computePromoCodeStats, todaysOrders } from "@/lib/analytics";
import { getOrderFeedback, getOrders, getPromoCodes } from "@/lib/data";
import type { OrderFeedbackRecord, PromoCode } from "@/lib/data";
import { onDigestRequested } from "@/lib/insightsChatBus";
import type { CompletedOrder } from "@/lib/types";

type ChatEntry = { role: "q" | "a"; text: string };

export default function InsightsChatWidget({
  insightsEnabled = true,
  digestEnabled = true,
}: {
  insightsEnabled?: boolean;
  digestEnabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [orders, setOrders] = useState<CompletedOrder[] | null>(null);
  const [feedback, setFeedback] = useState<OrderFeedbackRecord[] | null>(null);
  const [promoCodes, setPromoCodes] = useState<PromoCode[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [question, setQuestion] = useState("");
  const [log, setLog] = useState<ChatEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  // Ref mirrors of the loaded data so async actions (the digest, triggered
  // while the popup may still be closed) read the latest value without a
  // stale closure.
  const ordersRef = useRef<CompletedOrder[] | null>(null);
  const feedbackRef = useRef<OrderFeedbackRecord[] | null>(null);
  const promoCodesRef = useRef<PromoCode[] | null>(null);

  // All-time aggregates, ratings and promo performance power the free-form
  // copilot; the digest computes its own today-only slice on demand (see runDigest).
  const aggregates = useMemo(() => (orders ? computeAggregates(orders) : null), [orders]);
  const ratings = useMemo(() => (feedback ? computePizzaRatingSummary(feedback) : null), [feedback]);
  const promoStats = useMemo(
    () => (orders && promoCodes ? computePromoCodeStats(orders, promoCodes) : null),
    [orders, promoCodes]
  );

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [log, busy]);

  /** Load orders once (from either an open or a digest request) and cache them. */
  const ensureOrders = useCallback(async (): Promise<CompletedOrder[]> => {
    if (ordersRef.current) return ordersRef.current;
    const loaded = await getOrders();
    ordersRef.current = loaded;
    setOrders(loaded);
    return loaded;
  }, []);

  /** Load ratings + promo code history once, alongside orders, for the free-form copilot. */
  const ensureExtras = useCallback(async (): Promise<void> => {
    const [fb, promos] = await Promise.all([
      feedbackRef.current ?? getOrderFeedback(),
      promoCodesRef.current ?? getPromoCodes(),
    ]);
    feedbackRef.current = fb;
    promoCodesRef.current = promos;
    setFeedback(fb);
    setPromoCodes(promos);
  }, []);

  // Warm the data as soon as the copilot is opened, so the first question is snappy.
  useEffect(() => {
    if (!open || loadError) return;
    if (ordersRef.current && feedbackRef.current && promoCodesRef.current) return;
    Promise.all([ensureOrders(), ensureExtras()]).catch((error: Error) => setLoadError(error.message));
  }, [open, loadError, ensureOrders, ensureExtras]);

  async function ask(text?: string) {
    const q = (text ?? question).trim();
    if (!q || busy || !aggregates) return;
    setBusy(true);
    setQuestion("");
    setLog((prev) => [...prev, { role: "q", text: q }]);
    try {
      const response = await fetch("/api/ai/insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, aggregates, ratings, promoCodes: promoStats }),
      });
      const payload = await response.json();
      setLog((prev) => [
        ...prev,
        { role: "a", text: response.ok ? payload.answer : payload.error ?? "Unavailable right now." },
      ]);
    } catch {
      setLog((prev) => [...prev, { role: "a", text: "The copilot is unavailable right now." }]);
    } finally {
      setBusy(false);
    }
  }

  // Open the popup and write today's digest into the chat as an answer bubble.
  const runDigest = useCallback(async () => {
    setOpen(true);
    setBusy(true);
    setLog((prev) => [...prev, { role: "q", text: "Write today's report" }]);
    try {
      const loaded = await ensureOrders();
      const todayAggregates = computeAggregates(todaysOrders(loaded));
      const response = await fetch("/api/ai/digest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aggregates: todayAggregates }),
      });
      const payload = await response.json();
      setLog((prev) => [
        ...prev,
        { role: "a", text: response.ok ? payload.digest : payload.error ?? "Unavailable right now." },
      ]);
    } catch {
      setLog((prev) => [...prev, { role: "a", text: "The digest writer is unavailable right now." }]);
    } finally {
      setBusy(false);
    }
  }, [ensureOrders]);

  // Subscribe to the dashboard's "Today's digest" button.
  useEffect(() => {
    if (!digestEnabled) return;
    return onDigestRequested(() => {
      void runDigest();
    });
  }, [digestEnabled, runDigest]);

  if (!insightsEnabled && !digestEnabled) return null;

  return (
    <>
      {insightsEnabled && (
        <button
          className="chat-fab"
          aria-label={open ? "Close business copilot" : "Ask your business anything"}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "✕" : "🍕"}
        </button>
      )}

      {open && (
        <div className="chat-popup" role="dialog" aria-label="Business copilot">
          <div className="chat-popup-head">
            <div className="chat-popup-title">
              <span className="chat-popup-avatar">🍕</span>
              <div>
                <strong>
                  Business Copilot <span className="ai-sparkle" aria-hidden="true">✦</span>
                </strong>
                <small>Ask your business anything</small>
              </div>
            </div>
            <div className="chat-popup-actions">
              {log.length > 0 && (
                <button
                  className="chat-close"
                  aria-label="Clear chat"
                  title="Clear chat"
                  disabled={busy}
                  onClick={() => setLog([])}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="M2.5 4h11M6 4V2.5A.5.5 0 0 1 6.5 2h3a.5.5 0 0 1 .5.5V4m1.5 0-.6 9a1 1 0 0 1-1 .9H5.6a1 1 0 0 1-1-.9L4 4"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              )}
              <button className="chat-close" aria-label="Close" onClick={() => setOpen(false)}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          </div>

          <div className="chat-body">
            {loadError && <div className="banner banner-error">Could not load orders: {loadError}</div>}
            {!loadError && insightsEnabled && !aggregates && log.length === 0 && (
              <p className="page-sub">Loading your sales data…</p>
            )}

            <div className="chat-log">
              {log.length === 0 && insightsEnabled && aggregates && (
                <div className="chat-empty">
                  <p>Hi Rajan! Ask me anything about your sales. Try one of these:</p>
                  <div className="chat-suggest-row">
                    {[
                      "Which pizza sells most on weekends?",
                      "Which pizza is rated the worst?",
                      "How are my promo codes performing?",
                    ].map(
                      (s) => (
                        <button key={s} className="chat-suggest" onClick={() => ask(s)}>
                          {s}
                        </button>
                      )
                    )}
                  </div>
                </div>
              )}
              {log.map((entry, index) => (
                <div key={index} className={`chat-msg ${entry.role === "q" ? "chat-q" : "chat-a"}`}>
                  {entry.text}
                </div>
              ))}
              {busy && (
                <div className="chat-msg chat-a chat-typing" aria-label="Thinking">
                  <span /><span /><span />
                </div>
              )}
              <div ref={logEndRef} />
            </div>
          </div>

          {insightsEnabled && (
            <div className="chat-input-bar">
              <input
                type="text"
                placeholder="Ask about your sales…"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && ask()}
                disabled={busy || !aggregates}
              />
              <button
                className="chat-send"
                aria-label="Send"
                onClick={() => ask()}
                disabled={busy || !aggregates || !question.trim()}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M1.7 1.3a.75.75 0 0 1 .8-.1l12 6a.75.75 0 0 1 0 1.4l-12 6a.75.75 0 0 1-1-.9L3.2 8 1.5 2.2a.75.75 0 0 1 .2-.9zM4.6 8.75l-1.1 3.8L12 8 3.5 3.45l1.1 3.8h4.15a.75.75 0 0 1 0 1.5H4.6z" />
                </svg>
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
