// Deterministic aggregates computed from the orders table.
// These are the ONLY numbers the AI ever sees: the LLM narrates them,
// it never invents them and never queries the database itself.

import { paiseToRupees } from "./format";
import type { CompletedOrder } from "./types";
import type { OrderFeedbackRecord } from "./data";

export interface OrderAggregates {
  generatedAt: string;
  orderCount: number;
  totalRevenue: number; // rupees, for LLM readability
  totalDiscountGiven: number;
  totalGstCollected: number;
  averageOrderValue: number;
  byPaymentMode: Record<string, { orders: number; revenue: number }>;
  pizzasSold: Record<string, number>; // pizza name -> units
  basesSold: Record<string, number>;
  toppingsSold: Record<string, number>;
  byDayOfWeek: Record<string, { orders: number; revenue: number }>;
  byTable: Record<string, { orders: number; revenue: number }>; // "Table 5"
  byHour: Record<string, number>; // "18:00" -> order count
  byDate: Record<string, { orders: number; revenue: number }>; // "2025-07-05"
  discountedOrderCount: number;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function computeAggregates(orders: CompletedOrder[]): OrderAggregates {
  const agg: OrderAggregates = {
    generatedAt: new Date().toISOString(),
    orderCount: orders.length,
    totalRevenue: 0,
    totalDiscountGiven: 0,
    totalGstCollected: 0,
    averageOrderValue: 0,
    byPaymentMode: {},
    pizzasSold: {},
    basesSold: {},
    toppingsSold: {},
    byDayOfWeek: {},
    byTable: {},
    byHour: {},
    byDate: {},
    discountedOrderCount: 0,
  };

  for (const order of orders) {
    const revenue = paiseToRupees(order.totalPaise);
    agg.totalRevenue += revenue;
    agg.totalDiscountGiven += paiseToRupees(order.discountPaise);
    agg.totalGstCollected += paiseToRupees(order.gstPaise);
    if (order.discountPaise > 0) agg.discountedOrderCount += 1;

    const mode = (agg.byPaymentMode[order.paymentMode] ??= { orders: 0, revenue: 0 });
    mode.orders += 1;
    mode.revenue += revenue;

    const when = new Date(order.createdAt);
    const day = DAYS[when.getDay()];
    const dayAgg = (agg.byDayOfWeek[day] ??= { orders: 0, revenue: 0 });
    dayAgg.orders += 1;
    dayAgg.revenue += revenue;

    const tableKey = order.tableNumber != null ? `Table ${order.tableNumber}` : "No table recorded";
    const tableAgg = (agg.byTable[tableKey] ??= { orders: 0, revenue: 0 });
    tableAgg.orders += 1;
    tableAgg.revenue += revenue;

    const hour = `${String(when.getHours()).padStart(2, "0")}:00`;
    agg.byHour[hour] = (agg.byHour[hour] ?? 0) + 1;

    const date = when.toISOString().slice(0, 10);
    const dateAgg = (agg.byDate[date] ??= { orders: 0, revenue: 0 });
    dateAgg.orders += 1;
    dateAgg.revenue += revenue;

    for (const line of order.lines) {
      agg.pizzasSold[line.pizzaName] = (agg.pizzasSold[line.pizzaName] ?? 0) + line.quantity;
      agg.basesSold[line.baseName] = (agg.basesSold[line.baseName] ?? 0) + line.quantity;
      for (const topping of line.toppingNames) {
        agg.toppingsSold[topping] = (agg.toppingsSold[topping] ?? 0) + line.quantity;
      }
    }
  }

  agg.averageOrderValue = agg.orderCount ? round2(agg.totalRevenue / agg.orderCount) : 0;
  agg.totalRevenue = round2(agg.totalRevenue);
  agg.totalDiscountGiven = round2(agg.totalDiscountGiven);
  agg.totalGstCollected = round2(agg.totalGstCollected);
  return agg;
}

export function todaysOrders(orders: CompletedOrder[]): CompletedOrder[] {
  const today = new Date().toDateString();
  return orders.filter((o) => new Date(o.createdAt).toDateString() === today);
}

export interface PizzaRatingSummary {
  pizzaName: string;
  avgRating: number; // rounded to 1 decimal
  ratingCount: number;
}

export interface RatingSummary {
  pizzas: PizzaRatingSummary[]; // sorted best-rated first, then most-rated
  overallAvgRating: number | null;
  overallRatingCount: number;
  feedbackCount: number; // total feedback submissions, rated or not
}

/** Per-pizza and overall star-rating aggregates for the admin Ratings page. */
export function computePizzaRatingSummary(feedback: OrderFeedbackRecord[]): RatingSummary {
  const sums = new Map<string, number>();
  const counts = new Map<string, number>();
  let overallSum = 0;
  let overallCount = 0;

  for (const entry of feedback) {
    for (const [pizzaName, rating] of Object.entries(entry.pizzaRatings)) {
      sums.set(pizzaName, (sums.get(pizzaName) ?? 0) + rating);
      counts.set(pizzaName, (counts.get(pizzaName) ?? 0) + 1);
    }
    if (entry.overallRating) {
      overallSum += entry.overallRating;
      overallCount += 1;
    }
  }

  const pizzas = [...counts.keys()]
    .map((pizzaName) => ({
      pizzaName,
      avgRating: Math.round((sums.get(pizzaName)! / counts.get(pizzaName)!) * 10) / 10,
      ratingCount: counts.get(pizzaName)!,
    }))
    .sort((a, b) => b.avgRating - a.avgRating || b.ratingCount - a.ratingCount);

  return {
    pizzas,
    overallAvgRating: overallCount > 0 ? Math.round((overallSum / overallCount) * 10) / 10 : null,
    overallRatingCount: overallCount,
    feedbackCount: feedback.length,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface RepeatCustomer {
  phone: string;
  name: string; // most recent name on file for this phone
  visitCount: number;
  lastVisitAt: string; // ISO
}

/**
 * Customers ranked by how many paid orders they've placed, keyed by phone
 * number (names can vary in casing/spelling across visits, phone doesn't).
 * Sorted by visit count, most first; ties broken by most recent visit.
 */
export function computeRepeatCustomers(orders: CompletedOrder[]): RepeatCustomer[] {
  const byPhone = new Map<string, { name: string; visitCount: number; lastVisitAt: string }>();
  for (const order of orders) {
    const entry = byPhone.get(order.phone);
    if (!entry) {
      byPhone.set(order.phone, { name: order.customerName, visitCount: 1, lastVisitAt: order.createdAt });
      continue;
    }
    entry.visitCount += 1;
    if (order.createdAt > entry.lastVisitAt) {
      entry.lastVisitAt = order.createdAt;
      entry.name = order.customerName;
    }
  }
  return [...byPhone.entries()]
    .map(([phone, v]) => ({ phone, ...v }))
    .sort((a, b) => b.visitCount - a.visitCount || (a.lastVisitAt < b.lastVisitAt ? 1 : -1));
}
