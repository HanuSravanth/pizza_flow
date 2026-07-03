"use client";

// Admin dashboard: stats, all orders, and the End-of-Day Digest. Auth,
// navigation and the floating Insights chat widget live in app/admin/layout.tsx
// — this page renders only once a session is confirmed.

import { useEffect, useMemo, useState } from "react";
import { computeAggregates, todaysOrders } from "@/lib/analytics";
import { formatDateTime, formatPaise, paiseToRupees } from "@/lib/format";
import { getOrders, isDemoMode } from "@/lib/data";
import { PAYMENT_MODES, type CompletedOrder, type PaymentMode } from "@/lib/types";
import { AdminDailyChart, type DailyPoint } from "@/components/AdminDailyChart";

const PAGE_SIZE = 10;
const CHART_DAYS = 14;

export default function AdminPage() {
  const [orders, setOrders] = useState<CompletedOrder[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [paymentFilter, setPaymentFilter] = useState<"All" | PaymentMode>("All");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(0);

  useEffect(() => {
    getOrders()
      .then(setOrders)
      .catch((error: Error) => setLoadError(error.message));
  }, []);

  useEffect(() => {
    setPage(0);
  }, [search, paymentFilter, dateFrom, dateTo]);

  const aggregates = useMemo(() => (orders ? computeAggregates(orders) : null), [orders]);
  const today = useMemo(() => (orders ? computeAggregates(todaysOrders(orders)) : null), [orders]);

  const dailySeries = useMemo<DailyPoint[]>(() => {
    if (!orders) return [];
    const byDate = new Map<string, { pizzas: number; revenue: number; discount: number }>();
    for (const order of orders) {
      const date = order.createdAt.slice(0, 10);
      const entry = byDate.get(date) ?? { pizzas: 0, revenue: 0, discount: 0 };
      entry.pizzas += order.lines.reduce((sum, line) => sum + line.quantity, 0);
      entry.revenue += paiseToRupees(order.totalPaise);
      entry.discount += paiseToRupees(order.discountPaise);
      byDate.set(date, entry);
    }
    const series: DailyPoint[] = [];
    const cursor = new Date();
    for (let i = CHART_DAYS - 1; i >= 0; i--) {
      const d = new Date(cursor);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const entry = byDate.get(key) ?? { pizzas: 0, revenue: 0, discount: 0 };
      series.push({ date: key, ...entry });
    }
    return series;
  }, [orders]);

  const filteredOrders = useMemo(() => {
    if (!orders) return [];
    const q = search.trim().toLowerCase();
    return orders.filter((order) => {
      if (paymentFilter !== "All" && order.paymentMode !== paymentFilter) return false;
      const orderDate = order.createdAt.slice(0, 10);
      if (dateFrom && orderDate < dateFrom) return false;
      if (dateTo && orderDate > dateTo) return false;
      if (!q) return true;
      const haystack = [
        order.customerName,
        order.phone,
        order.tableNumber != null ? `table ${order.tableNumber}` : "",
        ...order.lines.map((line) => line.pizzaName),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [orders, search, paymentFilter, dateFrom, dateTo]);

  const pageCount = Math.max(1, Math.ceil(filteredOrders.length / PAGE_SIZE));
  const pagedOrders = filteredOrders.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  if (loadError) return <div className="banner banner-error">Could not load orders: {loadError}</div>;
  if (!orders || !aggregates || !today) return <p className="page-sub">Loading orders…</p>;

  return (
    <>
      <h1>Admin dashboard</h1>
      <p className="page-sub">Every order, every rupee — live from the database.</p>
      {isDemoMode && (
        <div className="banner banner-demo">
          <strong>Demo mode:</strong> no Supabase configured — login is bypassed and orders come
          from this browser&apos;s storage.
        </div>
      )}

      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">Orders (all time)</div>
          <div className="stat-value">{aggregates.orderCount}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Revenue (all time)</div>
          <div className="stat-value">{formatPaise(Math.round(aggregates.totalRevenue * 100))}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Orders today</div>
          <div className="stat-value">{today.orderCount}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Revenue today</div>
          <div className="stat-value">{formatPaise(Math.round(today.totalRevenue * 100))}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Discounts given</div>
          <div className="stat-value">{formatPaise(Math.round(aggregates.totalDiscountGiven * 100))}</div>
        </div>
      </div>

      <AdminDailyChart data={dailySeries} />

      <div className="admin-grid">
        <div className="card">
          <h2>All orders</h2>
          <div className="filter-bar">
            <input
              type="text"
              placeholder="Search name, phone, table, pizza…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              className="select"
              value={paymentFilter}
              onChange={(e) => setPaymentFilter(e.target.value as "All" | PaymentMode)}
            >
              <option value="All">All payments</option>
              {PAYMENT_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </select>
            <label className="filter-date-field">
              From
              <input type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} />
            </label>
            <label className="filter-date-field">
              To
              <input type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} />
            </label>
            {(search || paymentFilter !== "All" || dateFrom || dateTo) && (
              <button
                className="btn btn-small btn-secondary"
                onClick={() => {
                  setSearch("");
                  setPaymentFilter("All");
                  setDateFrom("");
                  setDateTo("");
                }}
              >
                Clear
              </button>
            )}
          </div>
          <div className="table-scroll">
            <table className="orders-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Table</th>
                  <th>Customer</th>
                  <th>Items</th>
                  <th>Total</th>
                  <th>Payment</th>
                </tr>
              </thead>
              <tbody>
                {filteredOrders.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ color: "var(--muted)" }}>
                      {orders.length === 0 ? "No orders yet." : "No orders match your filters."}
                    </td>
                  </tr>
                )}
                {pagedOrders.map((order) => (
                  <tr key={order.id}>
                    <td>{formatDateTime(order.createdAt)}</td>
                    <td>{order.tableNumber ?? "—"}</td>
                    <td>
                      {order.customerName}
                      <small>{order.phone}</small>
                    </td>
                    <td>
                      {order.lines.map((line, i) => (
                        <div key={i}>
                          {line.quantity}× {line.pizzaName}
                          <small>
                            {line.baseName}
                            {line.toppingNames.length > 0 && ` · ${line.toppingNames.join(", ")}`}
                          </small>
                        </div>
                      ))}
                    </td>
                    <td>
                      <strong>{formatPaise(order.totalPaise)}</strong>
                      {order.discountPaise > 0 && <small>disc -{formatPaise(order.discountPaise)}</small>}
                      <small>GST {formatPaise(order.gstPaise)}</small>
                    </td>
                    <td>{order.paymentMode}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filteredOrders.length > 0 && (
            <div className="pagination-bar">
              <span>
                {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filteredOrders.length)} of{" "}
                {filteredOrders.length}
              </span>
              <div className="pagination-controls">
                <button
                  className="btn btn-small btn-secondary"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                >
                  Prev
                </button>
                <span>
                  Page {page + 1} of {pageCount}
                </span>
                <button
                  className="btn btn-small btn-secondary"
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  disabled={page >= pageCount - 1}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>

        <DigestCard todayAggregates={today} />
      </div>
    </>
  );
}

function DigestCard({ todayAggregates }: { todayAggregates: ReturnType<typeof computeAggregates> }) {
  const [digest, setDigest] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function generate() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/ai/digest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aggregates: todayAggregates }),
      });
      const payload = await response.json();
      if (response.ok) setDigest(payload.digest);
      else setError(payload.error ?? "Unavailable right now.");
    } catch {
      setError("The digest writer is unavailable right now.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card ai-panel digest-sidebar">
      <h3>
        End-of-day digest <span className="ai-sparkle" aria-hidden="true">✦</span>
      </h3>
      <p className="ai-note">
        One click, one manager&apos;s report on today&apos;s trading — revenue, top sellers,
        discounts given, GST collected, payment split, and anything unusual.
      </p>
      <button className="btn" style={{ marginTop: 10, width: "100%" }} onClick={generate} disabled={busy}>
        {busy ? <span className="spinner">writing…</span> : "Write today's report"}
      </button>
      {error && <p className="error-text">{error}</p>}
      {digest && <div className="digest-box">{digest}</div>}
    </div>
  );
}
