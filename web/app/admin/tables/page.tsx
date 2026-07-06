"use client";

// Admin "Tables" tab: a live grid of every dine-in table — occupied (seated,
// via table_sessions) or available — auto-polled every 15s. Tapping an
// occupied table opens its running order and a "Close table" action for a
// customer who left without paying (see closeTableAsAdmin in lib/data).

import { useCallback, useEffect, useState } from "react";
import { closeTableAsAdmin, getLiveTables, isDemoMode } from "@/lib/data";
import { formatDateTime, formatPaise } from "@/lib/format";
import type { LiveTable } from "@/lib/types";

const POLL_INTERVAL_MS = 15000;

export default function TablesPage() {
  const [tables, setTables] = useState<LiveTable[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [selected, setSelected] = useState<LiveTable | null>(null);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState("");

  const refresh = useCallback(() => {
    getLiveTables()
      .then((next) => {
        setTables(next);
        setLastUpdated(new Date());
        setLoadError("");
        // Keep the open modal's data current without closing it under the staff member.
        setSelected((prev) => (prev ? (next.find((t) => t.tableNumber === prev.tableNumber) ?? null) : null));
      })
      .catch((error: Error) => setLoadError(error.message));
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  async function closeTable() {
    if (!selected) return;
    setClosing(true);
    setCloseError("");
    const message = await closeTableAsAdmin(selected.tableNumber);
    setClosing(false);
    if (message) {
      setCloseError(message);
      return;
    }
    setSelected(null);
    refresh();
  }

  if (loadError) return <div className="banner banner-error">Could not load tables: {loadError}</div>;
  if (!tables) return <p className="page-sub">Loading tables…</p>;

  return (
    <>
      <h1>Live tables</h1>
      <p className="page-sub">Who&apos;s seated right now, and what they&apos;ve ordered so far.</p>
      {isDemoMode && (
        <div className="banner banner-demo">
          <strong>Demo mode:</strong> seating and orders come from this browser&apos;s storage.
        </div>
      )}

      <div className="table-grid-head">
        <div className="table-legend">
          <span className="table-legend-item">
            <span className="table-legend-swatch available" /> Available
          </span>
          <span className="table-legend-item">
            <span className="table-legend-swatch occupied" /> Occupied
          </span>
        </div>
        <div className="table-grid-head-actions">
          {lastUpdated && (
            <span className="page-sub" style={{ margin: 0 }}>
              Updated {lastUpdated.toLocaleTimeString("en-IN")}
            </span>
          )}
          <button className="btn btn-small btn-secondary" onClick={refresh}>
            Refresh
          </button>
        </div>
      </div>

      <div className="table-grid">
        {tables.map((t) => (
          <button
            key={t.tableNumber}
            className={`table-cell ${t.occupied ? "occupied" : "available"}`}
            disabled={!t.occupied}
            onClick={() => setSelected(t)}
          >
            <span className="table-cell-number">Table {t.tableNumber}</span>
            <span className="table-cell-status">{t.occupied ? "Occupied" : "Available"}</span>
            {t.occupied && (
              <span className="table-cell-detail">
                {t.order ? formatPaise(t.order.totalPaise) : "Seated"}
              </span>
            )}
          </button>
        ))}
      </div>

      {selected && (
        <div className="modal-backdrop" onClick={() => setSelected(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Table {selected.tableNumber}</h3>
              <button className="modal-close" aria-label="Close" onClick={() => setSelected(null)}>
                ✕
              </button>
            </div>
            <p className="page-sub">
              Seated since {selected.seatedAt ? formatDateTime(selected.seatedAt) : "—"}
            </p>
            {selected.order ? (
              <>
                <p>
                  <strong>{selected.order.customerName}</strong>
                  <br />
                  <small>{selected.order.phone}</small>
                </p>
                <hr />
                {selected.order.lines.map((line, i) => (
                  <p key={i}>
                    {line.quantity}× {line.pizzaName} ({line.baseName}
                    {line.toppingNames.length > 0 && `, ${line.toppingNames.join(", ")}`})
                    <span style={{ float: "right" }}>{formatPaise(line.lineTotalPaise)}</span>
                  </p>
                ))}
                <hr />
                <p style={{ fontWeight: 800 }}>
                  Running total <span style={{ float: "right" }}>{formatPaise(selected.order.totalPaise)}</span>
                </p>
              </>
            ) : (
              <p className="page-sub">Seated — no order confirmed yet.</p>
            )}
            {closeError && <p className="error-text">{closeError}</p>}
            <button
              className="btn btn-secondary"
              style={{ width: "100%", marginTop: 12 }}
              disabled={closing}
              onClick={closeTable}
            >
              {closing ? "Closing…" : "Close table"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
