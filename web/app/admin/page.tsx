"use client";

// Admin dashboard: stats, all orders, and Today's Digest. Auth,
// navigation and the floating Insights chat widget live in app/admin/layout.tsx
// — this page renders only once a session is confirmed.

import { useEffect, useMemo, useState } from "react";
import { computeAggregates, computeRepeatCustomers, todaysOrders } from "@/lib/analytics";
import { formatDateTime, formatPaise, paiseToRupees } from "@/lib/format";
import { getEffectiveAiFeatures, getOrders, isDemoMode, getOutletSettings } from "@/lib/data";
import { PAYMENT_MODES, type CompletedOrder, type PaymentMode } from "@/lib/types";
import { AdminDailyChart, type DailyPoint } from "@/components/AdminDailyChart";
import { requestDigestInChat } from "@/lib/insightsChatBus";

const PAGE_SIZE = 10;
const REPEAT_PAGE_SIZE = 5;
const CHART_DAYS = 14; // trailing window shown when the range is open-ended
const CHART_MAX_DAYS = 92; // guard so a huge custom range can't render 1000 bars

type StatPeriod = "today" | "7d" | "30d" | "all" | "custom";

const PERIOD_LABELS: Record<StatPeriod, string> = {
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  all: "All time",
  custom: "Custom range",
};

// Local yyyy-mm-dd for a date. The <input type="date"> fields, the table's
// "When" column (formatDateTime) and todaysOrders() all work in the browser's
// local timezone, so the range filter must too — slicing the UTC ISO string
// instead makes orders near midnight fall on the wrong calendar day.
function localDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Parse a "yyyy-mm-dd" key back into a local-midnight Date. `new Date(str)`
// would read it as UTC and shift a day west of Greenwich — do it by parts.
function parseDateKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// yyyy-mm-dd bounds for a preset period, in local time — used to drive both the
// stat cards and the orders table's own date filter from the one dropdown.
function presetRange(period: Exclude<StatPeriod, "custom">): { from: string; to: string } {
  const today = localDateKey(new Date());
  if (period === "all") return { from: "", to: "" };
  if (period === "today") return { from: today, to: today };
  const days = period === "7d" ? 7 : 30;
  const from = new Date();
  from.setDate(from.getDate() - (days - 1));
  return { from: localDateKey(from), to: today };
}

function ordersInRange(orders: CompletedOrder[], from: string, to: string): CompletedOrder[] {
  return orders.filter((o) => {
    const date = localDateKey(new Date(o.createdAt));
    if (from && date < from) return false;
    if (to && date > to) return false;
    return true;
  });
}

export default function AdminPage() {
  const [orders, setOrders] = useState<CompletedOrder[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [paymentFilter, setPaymentFilter] = useState<"All" | PaymentMode>("All");
  const [statPeriod, setStatPeriod] = useState<StatPeriod>("today");
  const [dateFrom, setDateFrom] = useState(() => presetRange("today").from);
  const [dateTo, setDateTo] = useState(() => presetRange("today").to);
  const [page, setPage] = useState(0);
  const [repeatPage, setRepeatPage] = useState(0);
  const [digestEnabled, setDigestEnabled] = useState(true);

  // Dynamic role & outlet configuration
  const [outletLocation, setOutletLocation] = useState("New Ashok Nagar, Delhi");

  // The period dropdown is the one control for both the stat cards and the
  // orders table below: picking a preset sets the date range; editing a date
  // field directly switches the dropdown to "Custom range" so the two stay in sync.
  function selectPeriod(next: StatPeriod) {
    setStatPeriod(next);
    if (next !== "custom") {
      const { from, to } = presetRange(next);
      setDateFrom(from);
      setDateTo(to);
    }
  }

  function editDate(which: "from" | "to", value: string) {
    if (which === "from") setDateFrom(value);
    else setDateTo(value);
    setStatPeriod("custom");
  }

  useEffect(() => {
    getOrders()
      .then(setOrders)
      .catch((error: Error) => setLoadError(error.message));
    getEffectiveAiFeatures()
      .then((features) => setDigestEnabled(features.digest))
      .catch(() => {});
    getOutletSettings()
      .then((settings) => {
        setOutletLocation(settings.location);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setPage(0);
  }, [search, paymentFilter, dateFrom, dateTo]);

  const today = useMemo(() => (orders ? computeAggregates(todaysOrders(orders)) : null), [orders]);
  const periodStats = useMemo(
    () => (orders ? computeAggregates(ordersInRange(orders, dateFrom, dateTo)) : null),
    [orders, dateFrom, dateTo],
  );

  // The chart spans the same date range as the stats and table. When the range
  // is open-ended ("All time" / no "from"), it falls back to a trailing
  // CHART_DAYS window ending at "to" so it stays readable rather than plotting
  // the entire history.
  const dailySeries = useMemo<DailyPoint[]>(() => {
    if (!orders) return [];
    const byDate = new Map<string, { pizzas: number; revenue: number; discount: number }>();
    for (const order of orders) {
      const date = localDateKey(new Date(order.createdAt));
      const entry = byDate.get(date) ?? { pizzas: 0, revenue: 0, discount: 0 };
      entry.pizzas += order.lines.reduce((sum, line) => sum + line.quantity, 0);
      entry.revenue += paiseToRupees(order.totalPaise);
      entry.discount += paiseToRupees(order.discountPaise);
      byDate.set(date, entry);
    }

    const toDate = dateTo ? parseDateKey(dateTo) : new Date();
    let fromDate: Date;
    if (dateFrom) {
      fromDate = parseDateKey(dateFrom);
    } else {
      fromDate = new Date(toDate);
      fromDate.setDate(fromDate.getDate() - (CHART_DAYS - 1));
    }
    const floor = new Date(toDate);
    floor.setDate(floor.getDate() - (CHART_MAX_DAYS - 1));
    if (fromDate < floor) fromDate = floor;

    const series: DailyPoint[] = [];
    for (const d = new Date(fromDate); d <= toDate; d.setDate(d.getDate() + 1)) {
      const key = localDateKey(d);
      const entry = byDate.get(key) ?? { pizzas: 0, revenue: 0, discount: 0 };
      series.push({ date: key, ...entry });
    }
    return series;
  }, [orders, dateFrom, dateTo]);

  const filteredOrders = useMemo(() => {
    if (!orders) return [];
    const q = search.trim().toLowerCase();
    return orders.filter((order) => {
      if (paymentFilter !== "All" && order.paymentMode !== paymentFilter) return false;
      const orderDate = localDateKey(new Date(order.createdAt));
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

  const repeatCustomers = useMemo(() => (orders ? computeRepeatCustomers(orders) : []), [orders]);
  const repeatPageCount = Math.max(1, Math.ceil(repeatCustomers.length / REPEAT_PAGE_SIZE));
  const repeatPageClamped = Math.min(repeatPage, repeatPageCount - 1);
  const pagedRepeatCustomers = repeatCustomers.slice(
    repeatPageClamped * REPEAT_PAGE_SIZE,
    repeatPageClamped * REPEAT_PAGE_SIZE + REPEAT_PAGE_SIZE,
  );

  if (loadError) return <div className="banner banner-error">Could not load orders: {loadError}</div>;
  if (!orders || !today || !periodStats) return <p className="page-sub">Loading orders…</p>;

  return (
    <>
      <h1>Admin dashboard – {outletLocation}</h1>
      <p className="page-sub">Every order, every rupee — live from the database.</p>
      {isDemoMode && (
        <div className="banner banner-demo">
          <strong>Demo mode:</strong> no Supabase configured — login is bypassed and orders come
          from this browser&apos;s storage.
        </div>
      )}

      <div className="stat-row-head">
        {statPeriod === "custom" && (
          <div className="stat-head-dates">
            <label className="filter-date-field">
              From
              <input
                type="date"
                value={dateFrom}
                max={dateTo || undefined}
                onChange={(e) => editDate("from", e.target.value)}
              />
            </label>
            <label className="filter-date-field">
              To
              <input
                type="date"
                value={dateTo}
                min={dateFrom || undefined}
                onChange={(e) => editDate("to", e.target.value)}
              />
            </label>
          </div>
        )}
        <select
          className="select"
          value={statPeriod}
          onChange={(e) => selectPeriod(e.target.value as StatPeriod)}
        >
          {(Object.keys(PERIOD_LABELS) as StatPeriod[]).map((p) => (
            <option key={p} value={p}>
              {PERIOD_LABELS[p]}
            </option>
          ))}
        </select>
      </div>

      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">Orders</div>
          <div className="stat-value">{periodStats.orderCount}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Revenue</div>
          <div className="stat-value">{formatPaise(Math.round(periodStats.totalRevenue * 100))}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Avg order value</div>
          <div className="stat-value">{formatPaise(Math.round(periodStats.averageOrderValue * 100))}</div>
        </div>
        <div className="stat stat-highlight">
          <div className="stat-label">Discounts given</div>
          <div className="stat-value">{formatPaise(Math.round(periodStats.totalDiscountGiven * 100))}</div>
          <div className="stat-sub">
            {periodStats.totalRevenue > 0
              ? `${((periodStats.totalDiscountGiven / periodStats.totalRevenue) * 100).toFixed(1)}% of revenue`
              : "—"}
          </div>
        </div>
      </div>

      <div className="admin-grid">
        <AdminDailyChart data={dailySeries} />

        {digestEnabled && <DigestCard todayAggregates={today} />}
      </div>

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
          {(search || paymentFilter !== "All") && (
            <button
              className="btn btn-small btn-secondary"
              onClick={() => {
                setSearch("");
                setPaymentFilter("All");
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
                <th>Order ID</th>
                <th>When</th>
                <th>Table</th>
                <th>Customer</th>
                <th>Units</th>
                <th>Items ordered</th>
                <th>GST</th>
                <th>Discount</th>
                <th>Total</th>
                <th>Payment</th>
              </tr>
            </thead>
            <tbody>
              {filteredOrders.length === 0 && (
                <tr>
                  <td colSpan={10} style={{ color: "var(--muted)" }}>
                    {orders.length === 0 ? "No orders yet." : "No orders match your filters."}
                  </td>
                </tr>
              )}
              {pagedOrders.map((order) => (
                <tr key={order.id}>
                  <td title={order.id}>
                    <code>{order.id.slice(0, 8).toUpperCase()}</code>
                  </td>
                  <td>{formatDateTime(order.createdAt)}</td>
                  <td>{order.tableNumber ?? "—"}</td>
                  <td>
                    {order.customerName}
                    <small>{order.phone}</small>
                  </td>
                  <td>{order.lines.reduce((sum, line) => sum + line.quantity, 0)}</td>
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
                  <td>{formatPaise(order.gstPaise)}</td>
                  <td>{order.discountPaise > 0 ? formatPaise(order.discountPaise) : "—"}</td>
                  <td>
                    <strong>{formatPaise(order.totalPaise)}</strong>
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

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Top repeat customers</h2>
        <p className="page-sub">Every customer, grouped by phone number and ranked by visit count.</p>
        <div className="table-scroll">
          <table className="orders-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Phone</th>
                <th>Visits</th>
                <th>Last visit</th>
              </tr>
            </thead>
            <tbody>
              {repeatCustomers.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ color: "var(--muted)" }}>
                    No customers yet.
                  </td>
                </tr>
              )}
              {pagedRepeatCustomers.map((customer) => (
                <tr key={customer.phone}>
                  <td>{customer.name}</td>
                  <td>{customer.phone}</td>
                  <td>
                    <strong>{customer.visitCount}</strong>
                  </td>
                  <td>{formatDateTime(customer.lastVisitAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {repeatCustomers.length > 0 && (
          <div className="pagination-bar">
            <span>
              {repeatPageClamped * REPEAT_PAGE_SIZE + 1}–
              {Math.min((repeatPageClamped + 1) * REPEAT_PAGE_SIZE, repeatCustomers.length)} of{" "}
              {repeatCustomers.length}
            </span>
            <div className="pagination-controls">
              <button
                className="btn btn-small btn-secondary"
                onClick={() => setRepeatPage((p) => Math.max(0, p - 1))}
                disabled={repeatPageClamped === 0}
              >
                Prev
              </button>
              <span>
                Page {repeatPageClamped + 1} of {repeatPageCount}
              </span>
              <button
                className="btn btn-small btn-secondary"
                onClick={() => setRepeatPage((p) => Math.min(repeatPageCount - 1, p + 1))}
                disabled={repeatPageClamped >= repeatPageCount - 1}
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

function topSellerName(aggregates: ReturnType<typeof computeAggregates>): string {
  const entries = Object.entries(aggregates.pizzasSold);
  if (entries.length === 0) return "—";
  return entries.reduce((best, cur) => (cur[1] > best[1] ? cur : best))[0];
}

function paymentSplitLabel(aggregates: ReturnType<typeof computeAggregates>): string {
  const total = aggregates.orderCount;
  if (total === 0) return "—";
  const parts = PAYMENT_MODES.map((mode) => {
    const count = aggregates.byPaymentMode[mode]?.orders ?? 0;
    return count > 0 ? `${mode} ${Math.round((count / total) * 100)}%` : null;
  }).filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

function DigestCard({ todayAggregates }: { todayAggregates: ReturnType<typeof computeAggregates> }) {
  const [unavailable, setUnavailable] = useState(false);

  // The report is written into the Insights chat popup (see InsightsChatWidget)
  // rather than in a box here, so the manager reads it in the same place they
  // ask follow-up questions. requestDigestInChat returns false only if that
  // widget isn't mounted (the copilot is off) — then we say so.
  function openReport() {
    setUnavailable(!requestDigestInChat());
  }

  return (
    <div className="card ai-panel digest-sidebar">
      <h3>
        Today&apos;s digest <span className="ai-sparkle" aria-hidden="true">✦</span>
      </h3>
      <p className="ai-note">
        One click, one manager&apos;s report on today&apos;s trading — revenue, top sellers,
        discounts given, GST collected, payment split, and anything unusual. It opens in the
        Copilot chat so you can ask follow-ups.
      </p>
      <div className="digest-stats">
        <div className="digest-stat-row">
          <span>Top seller</span>
          <strong>{topSellerName(todayAggregates)}</strong>
        </div>
        <div className="digest-stat-row">
          <span>GST collected</span>
          <strong>{formatPaise(Math.round(todayAggregates.totalGstCollected * 100))}</strong>
        </div>
        <div className="digest-stat-row">
          <span>Payment split</span>
          <strong>{paymentSplitLabel(todayAggregates)}</strong>
        </div>
      </div>
      <button className="btn" style={{ marginTop: 10, width: "100%" }} onClick={openReport}>
        Write today&apos;s report
      </button>
      {unavailable && (
        <p className="error-text">Turn on the Insights copilot to read the report in chat.</p>
      )}
    </div>
  );
}
