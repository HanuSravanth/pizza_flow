"use client";

// Floating "Ask your business anything" widget — the Owner Insights Copilot,
// available from any admin screen (dashboard, menu management, settings) as
// a pizza-slice bubble in the corner. It fetches and aggregates orders
// itself on first open, so it doesn't depend on which page it's mounted on.

import { useEffect, useRef, useState } from "react";
import { computeAggregates, type OrderAggregates } from "@/lib/analytics";
import { getOrders } from "@/lib/data";

type ChatEntry = { role: "q" | "a"; text: string };

export default function InsightsChatWidget() {
  const [open, setOpen] = useState(false);
  const [aggregates, setAggregates] = useState<OrderAggregates | null>(null);
  const [loadError, setLoadError] = useState("");
  const [question, setQuestion] = useState("");
  const [log, setLog] = useState<ChatEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [log, busy]);

  useEffect(() => {
    if (!open || aggregates || loadError) return;
    getOrders()
      .then((orders) => setAggregates(computeAggregates(orders)))
      .catch((error: Error) => setLoadError(error.message));
  }, [open, aggregates, loadError]);

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
        body: JSON.stringify({ question: q, aggregates }),
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

  return (
    <>
      <button
        className="chat-fab"
        aria-label={open ? "Close business copilot" : "Ask your business anything"}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "✕" : "🍕"}
      </button>

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
            <button className="chat-close" aria-label="Close" onClick={() => setOpen(false)}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <div className="chat-body">
            {loadError && <div className="banner banner-error">Could not load orders: {loadError}</div>}
            {!loadError && !aggregates && <p className="page-sub">Loading your sales data…</p>}

            {aggregates && (
              <div className="chat-log">
                {log.length === 0 && (
                  <div className="chat-empty">
                    <p>Hi Rajan! Ask me anything about your sales. Try one of these:</p>
                    <div className="chat-suggest-row">
                      {["Which pizza sells most?", "What did discounts cost me?", "Which table orders the most?"].map(
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
            )}
          </div>

          {aggregates && (
            <div className="chat-input-bar">
              <input
                type="text"
                placeholder="Ask about your sales…"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && ask()}
                disabled={busy}
              />
              <button
                className="chat-send"
                aria-label="Send"
                onClick={() => ask()}
                disabled={busy || !question.trim()}
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
