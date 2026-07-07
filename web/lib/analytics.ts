// Deterministic aggregates computed from the orders table.
// These are the ONLY numbers the AI ever sees: the LLM narrates them,
// it never invents them and never queries the database itself.

import { paiseToRupees } from "./format";
import type { CompletedOrder } from "./types";
import type { AdminMenuItem, OrderFeedbackRecord, PromoCode } from "./data";

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
  pizzasSoldByDayOfWeek: Record<string, Record<string, number>>; // day -> pizza name -> units
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
    pizzasSoldByDayOfWeek: {},
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

    const pizzasByDay = (agg.pizzasSoldByDayOfWeek[day] ??= {});
    for (const line of order.lines) {
      agg.pizzasSold[line.pizzaName] = (agg.pizzasSold[line.pizzaName] ?? 0) + line.quantity;
      agg.basesSold[line.baseName] = (agg.basesSold[line.baseName] ?? 0) + line.quantity;
      pizzasByDay[line.pizzaName] = (pizzasByDay[line.pizzaName] ?? 0) + line.quantity;
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

// ------------------------------------------------------------- promo planner
// Deterministic facts for the Festival Promo Planner. The rules pick what is
// worth promoting (best sellers, slow movers, veg share, quiet days); the LLM
// only writes the broadcast copy around these numbers.

export interface PromoFacts {
  generatedAt: string;
  windowDays: number;
  orderCount: number; // orders within the window
  bestSellers: { name: string; units: number; isVeg: boolean | null }[];
  slowMovers: { name: string; units: number; isVeg: boolean | null; priceRupees: number }[];
  vegUnitShare: number | null; // % of pizza units in the window that were veg
  busiestDay: { day: string; orders: number } | null;
  quietestDay: { day: string; orders: number } | null;
  topRatedPizza: { name: string; avgRating: number; ratingCount: number } | null;
  repeatCustomerCount: number; // all-time customers with 2+ paid orders
}

export function computePromoFacts(params: {
  orders: CompletedOrder[]; // all paid orders (window filtering happens here)
  menuPizzas: AdminMenuItem[]; // active pizzas — needed so zero-sale items surface
  ratings: RatingSummary | null;
  windowDays?: number;
}): PromoFacts {
  const windowDays = params.windowDays ?? 30;
  const cutoff = Date.now() - windowDays * 86_400_000;
  const recent = params.orders.filter((o) => new Date(o.createdAt).getTime() >= cutoff);

  const units = new Map<string, number>(); // pizza name -> units in window
  const byDay = new Map<string, number>();
  for (const order of recent) {
    const day = DAYS[new Date(order.createdAt).getDay()];
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
    for (const line of order.lines) {
      units.set(line.pizzaName, (units.get(line.pizzaName) ?? 0) + line.quantity);
    }
  }

  const vegByName = new Map(params.menuPizzas.map((p) => [p.name, p.isVeg]));
  const isVegOf = (name: string) => vegByName.get(name) ?? null;

  const bestSellers = [...units.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, n]) => ({ name, units: n, isVeg: isVegOf(name) }));

  const bestNames = new Set(bestSellers.map((b) => b.name));
  const slowMovers = params.menuPizzas
    .filter((p) => !bestNames.has(p.name))
    .map((p) => ({
      name: p.name,
      units: units.get(p.name) ?? 0,
      isVeg: p.isVeg,
      priceRupees: paiseToRupees(p.pricePaise),
    }))
    .sort((a, b) => a.units - b.units)
    .slice(0, 3);

  let vegUnits = 0;
  let knownUnits = 0;
  for (const [name, n] of units) {
    const veg = vegByName.get(name);
    if (veg === undefined) continue;
    knownUnits += n;
    if (veg) vegUnits += n;
  }

  const days = [...byDay.entries()].sort((a, b) => b[1] - a[1]);
  const topRated = params.ratings?.pizzas.find((p) => p.ratingCount >= 2) ?? null;

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    orderCount: recent.length,
    bestSellers,
    slowMovers,
    vegUnitShare: knownUnits > 0 ? Math.round((vegUnits / knownUnits) * 100) : null,
    busiestDay: days.length ? { day: days[0][0], orders: days[0][1] } : null,
    quietestDay: days.length > 1 ? { day: days[days.length - 1][0], orders: days[days.length - 1][1] } : null,
    topRatedPizza: topRated
      ? { name: topRated.pizzaName, avgRating: topRated.avgRating, ratingCount: topRated.ratingCount }
      : null,
    repeatCustomerCount: computeRepeatCustomers(params.orders).filter((c) => c.visitCount > 1).length,
  };
}

// ---------------------------------------------------------- feedback analyst
// Feedback entries prepared for the LLM, each with a stable index. The model
// must cite these indexes per theme; the UI recounts and quotes the cited
// entries deterministically, so every number shown is computed here — never
// by the model.

export interface FeedbackEntryForAi {
  index: number;
  when: string; // ISO date (yyyy-mm-dd)
  dayOfWeek: string;
  hour: string; // "18:00"
  overall: number | null;
  pizzaRatings: Record<string, number>;
  tags: string[];
  comment: string | null;
}

export interface FeedbackTheme {
  title: string;
  sentiment: "negative" | "positive" | "mixed";
  entryIndexes: number[];
  rootCause: string;
  suggestedAction: string;
}

export interface FeedbackAnalysis {
  themes: FeedbackTheme[];
  note: string;
}

export function buildFeedbackDataset(feedback: OrderFeedbackRecord[], limit = 100): FeedbackEntryForAi[] {
  return feedback.slice(0, limit).map((entry, index) => {
    const when = new Date(entry.createdAt);
    return {
      index,
      when: entry.createdAt.slice(0, 10),
      dayOfWeek: DAYS[when.getDay()],
      hour: `${String(when.getHours()).padStart(2, "0")}:00`,
      overall: entry.overallRating,
      pizzaRatings: entry.pizzaRatings,
      tags: entry.quickTags,
      comment: entry.comments,
    };
  });
}

// ------------------------------------------------------- promo code history
// How each promo code actually performed: every number here comes straight
// from paid orders that redeemed the code (matched by the snapshot stored on
// the order, not a live join) — nothing is estimated.

export interface PromoCodeStats {
  id: string;
  code: string;
  headline: string;
  startsAt: string;
  endsAt: string;
  status: "scheduled" | "active" | "expired";
  redemptions: number;
  revenuePaise: number; // total paid on orders that redeemed this code
  discountPaise: number; // total promo discount given under this code
}

export function computePromoCodeStats(orders: CompletedOrder[], codes: PromoCode[]): PromoCodeStats[] {
  const now = Date.now();
  const byCode = new Map<string, { redemptions: number; revenuePaise: number; discountPaise: number }>();
  for (const order of orders) {
    if (!order.promoCode) continue;
    const entry = byCode.get(order.promoCode) ?? { redemptions: 0, revenuePaise: 0, discountPaise: 0 };
    entry.redemptions += 1;
    entry.revenuePaise += order.totalPaise;
    entry.discountPaise += order.promoDiscountPaise;
    byCode.set(order.promoCode, entry);
  }

  return codes
    .map((c) => {
      const stats = byCode.get(c.code) ?? { redemptions: 0, revenuePaise: 0, discountPaise: 0 };
      const start = new Date(c.startsAt).getTime();
      const end = new Date(c.endsAt).getTime();
      const status: PromoCodeStats["status"] = now < start ? "scheduled" : now > end ? "expired" : "active";
      return {
        id: c.id,
        code: c.code,
        headline: c.headline,
        startsAt: c.startsAt,
        endsAt: c.endsAt,
        status,
        ...stats,
      };
    })
    .sort((a, b) => (a.startsAt < b.startsAt ? 1 : -1));
}
