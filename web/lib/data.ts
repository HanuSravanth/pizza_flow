// Data layer. One interface, two backends:
//   - Supabase (production): menu_items / orders / order_items / order_item_toppings
//   - Demo mode (no env vars): bundled menu + localStorage orders
// Pages call these functions and never know which backend is live.

import {
  computeBill,
  PROMO_DISCOUNT_TYPES,
  PROMO_PERCENT_MAX,
  PROMO_PERCENT_MIN,
  type AppliedPromo,
  type PromoDiscountType,
} from "./billing";
import { DEFAULT_MODEL, isValidModelSlug } from "./aiCatalog";
import { DEMO_MENU } from "./demoMenu";
import { rupeesToPaise, paiseToRupees } from "./format";
import {
  AI_FEATURES,
  MAX_CUSTOM_INSTRUCTIONS,
  composeSystemPrompt,
  sanitizeCustomInstructions,
  type AiFeature,
} from "./prompts";
import { getSupabase, getSupabaseAdmin, isSupabaseConfigured } from "./supabase";
import { generateUUID } from "./uuid";
import type {
  CartLine,
  CompletedOrder,
  LiveTable,
  Menu,
  MenuCategory,
  MenuItem,
  OpenOrder,
  PaymentMode,
} from "./types";
import { TABLE_COUNT } from "./types";

const DEMO_ORDERS_KEY = "pizzaflow_demo_orders";
const DEMO_TABLE_SESSIONS_KEY = "pizzaflow_demo_table_sessions";

export const isDemoMode = !isSupabaseConfigured;

/** Turn raw PostgREST errors into messages staff can act on. */
function dbError(context: string, error: { code?: string; message: string }): Error {
  // PGRST2xx = table missing from the schema cache: the Supabase project
  // exists but schema.sql / seed.sql were never run in it.
  if (error.code?.startsWith("PGRST2") || error.message.includes("schema cache")) {
    return new Error(
      `${context}: the Supabase project is connected but its database tables have not been ` +
        "created yet. Run supabase/schema.sql and then supabase/seed.sql in the Supabase " +
        "dashboard (SQL Editor > New query), then refresh this page."
    );
  }
  return new Error(`${context}: ${error.message}`);
}

// ---------------------------------------------------------------- menu

function menuFromItems(items: AdminMenuItem[]): Menu {
  const active = items.filter((i) => i.isActive);
  return {
    bases: active.filter((i) => i.category === "base"),
    pizzas: active.filter((i) => i.category === "pizza"),
    toppings: active.filter((i) => i.category === "topping"),
  };
}

export async function getMenu(): Promise<Menu> {
  if (isDemoMode) return menuFromItems(loadDemoMenuItems());

  const { data, error } = await getSupabase()
    .from("menu_items")
    .select("id, category, name, price, is_veg, allowed_base_ids, allowed_topping_ids")
    .eq("is_active", true)
    .order("category")
    .order("name");
  if (error) throw dbError("Could not load the menu", error);

  const toItem = (row: {
    id: string;
    category: string;
    name: string;
    price: number;
    is_veg: boolean;
    allowed_base_ids: string[] | null;
    allowed_topping_ids: string[] | null;
  }): MenuItem => ({
    id: row.id,
    category: row.category as MenuItem["category"],
    name: row.name,
    pricePaise: rupeesToPaise(row.price),
    isVeg: row.is_veg,
    allowedBaseIds: row.allowed_base_ids ?? [],
    allowedToppingIds: row.allowed_topping_ids ?? [],
  });

  const items = (data ?? []).map(toItem);
  const menu: Menu = {
    bases: items.filter((i) => i.category === "base"),
    pizzas: items.filter((i) => i.category === "pizza"),
    toppings: items.filter((i) => i.category === "topping"),
  };
  if (!menu.bases.length || !menu.pizzas.length || !menu.toppings.length) {
    throw new Error("The menu is incomplete — bases, pizzas and toppings must all exist.");
  }
  return menu;
}

// ------------------------------------------------------- menu management
// Full CRUD for the admin "Menu management" screen. Unlike getMenu() (active
// items only, grouped for ordering), this returns every item — active or not
// — for editing. Soft-delete only (is_active toggle): menu items are
// referenced by historical order_items, and hard-deleting one that has ever
// been ordered would violate the foreign key.

export interface AdminMenuItem {
  id: string;
  category: MenuCategory;
  name: string;
  pricePaise: number;
  isActive: boolean;
  isVeg: boolean;
  // Meaningful only for category === "pizza" — see MenuItem in ./types.
  allowedBaseIds: string[];
  allowedToppingIds: string[];
}

const DEMO_MENU_ITEMS_KEY = "pizzaflow_demo_menu_items";

function seedDemoMenuItems(): AdminMenuItem[] {
  return [...DEMO_MENU.bases, ...DEMO_MENU.pizzas, ...DEMO_MENU.toppings].map((item) => ({
    ...item,
    isActive: true,
  }));
}

/**
 * Backfill for items saved before combo tagging existed: a pizza with no
 * allowed-base/topping arrays yet gets every current base/topping (matching
 * the schema.sql/seed.sql backfill), so nothing goes dark on upgrade. Bases
 * and toppings themselves don't use these fields.
 */
function migrateDemoMenuItems(items: AdminMenuItem[]): AdminMenuItem[] {
  const allBaseIds = items.filter((i) => i.category === "base").map((i) => i.id);
  const allToppingIds = items.filter((i) => i.category === "topping").map((i) => i.id);
  let changed = false;
  const migrated = items.map((item) => {
    if (item.category !== "pizza") return { ...item, allowedBaseIds: [], allowedToppingIds: [] };
    if (item.allowedBaseIds && item.allowedToppingIds) return item;
    changed = true;
    return {
      ...item,
      allowedBaseIds: item.allowedBaseIds ?? allBaseIds,
      allowedToppingIds: item.allowedToppingIds ?? allToppingIds,
    };
  });
  if (changed) saveDemoMenuItems(migrated);
  return migrated;
}

function loadDemoMenuItems(): AdminMenuItem[] {
  if (typeof localStorage === "undefined") return seedDemoMenuItems();
  try {
    const raw = localStorage.getItem(DEMO_MENU_ITEMS_KEY);
    if (raw) return migrateDemoMenuItems(JSON.parse(raw));
  } catch {
    /* fall through to reseed */
  }
  const seeded = seedDemoMenuItems();
  localStorage.setItem(DEMO_MENU_ITEMS_KEY, JSON.stringify(seeded));
  return seeded;
}

function saveDemoMenuItems(items: AdminMenuItem[]): void {
  localStorage.setItem(DEMO_MENU_ITEMS_KEY, JSON.stringify(items));
}

function validateMenuItemInput(name: string, price: number): string | null {
  if (!name.trim()) return "Name cannot be empty.";
  if (name.trim().length > 40) return "Name must be at most 40 characters.";
  if (!Number.isFinite(price) || price <= 0) return "Price must be a positive number.";
  return null;
}

/** Dedupe and drop ids that no longer reference a real item of that category. */
function sanitizeAllowedIds(ids: string[] | undefined, validIds: string[]): string[] {
  const validSet = new Set(validIds);
  return [...new Set(ids ?? [])].filter((id) => validSet.has(id));
}

export async function getAllMenuItems(): Promise<AdminMenuItem[]> {
  if (isDemoMode) return loadDemoMenuItems();

  const { data, error } = await getSupabase()
    .from("menu_items")
    .select("id, category, name, price, is_active, is_veg, allowed_base_ids, allowed_topping_ids")
    .order("category")
    .order("name");
  if (error) throw dbError("Could not load menu items", error);
  return (data ?? []).map((row: any) => ({
    id: row.id,
    category: row.category,
    name: row.name,
    pricePaise: rupeesToPaise(row.price),
    isActive: row.is_active,
    isVeg: row.is_veg,
    allowedBaseIds: row.allowed_base_ids ?? [],
    allowedToppingIds: row.allowed_topping_ids ?? [],
  }));
}

/** Appends `newId` onto every pizza's allowed-base/topping array (skips rows that already have it). */
async function appendIdToAllPizzas(
  supabase: ReturnType<typeof getSupabase>,
  column: "allowed_base_ids" | "allowed_topping_ids",
  newId: string
): Promise<void> {
  const { data: pizzas } = await supabase.from("menu_items").select(`id, ${column}`).eq("category", "pizza");
  for (const row of (pizzas ?? []) as any[]) {
    const current: string[] = row[column] ?? [];
    if (current.includes(newId)) continue;
    await supabase
      .from("menu_items")
      .update({ [column]: [...current, newId] })
      .eq("id", row.id);
  }
}

export async function createMenuItem(input: {
  category: MenuCategory;
  name: string;
  priceRupees: number;
  isVeg: boolean;
  allowedBaseIds?: string[]; // pizza only
  allowedToppingIds?: string[]; // pizza only
  allowOnAllPizzas?: boolean; // base/topping only — default true
}): Promise<string | null> {
  const validationError = validateMenuItemInput(input.name, input.priceRupees);
  if (validationError) return validationError;
  const name = input.name.trim();

  if (isDemoMode) {
    const items = loadDemoMenuItems();
    if (items.some((i) => i.category === input.category && i.name.toLowerCase() === name.toLowerCase())) {
      return "An item with this name already exists in this category.";
    }

    let allowedBaseIds: string[] = [];
    let allowedToppingIds: string[] = [];
    if (input.category === "pizza") {
      const validBaseIds = items.filter((i) => i.category === "base").map((i) => i.id);
      const validToppingIds = items.filter((i) => i.category === "topping").map((i) => i.id);
      allowedBaseIds = sanitizeAllowedIds(input.allowedBaseIds, validBaseIds);
      if (allowedBaseIds.length === 0) return "Select at least one allowed base.";
      allowedToppingIds = sanitizeAllowedIds(input.allowedToppingIds, validToppingIds);
    }

    const id = generateUUID();
    items.push({
      id,
      category: input.category,
      name,
      pricePaise: rupeesToPaise(input.priceRupees),
      isActive: true,
      isVeg: input.isVeg,
      allowedBaseIds,
      allowedToppingIds,
    });

    if ((input.category === "base" || input.category === "topping") && input.allowOnAllPizzas !== false) {
      const field = input.category === "base" ? "allowedBaseIds" : "allowedToppingIds";
      for (const item of items) {
        if (item.category === "pizza" && !item[field].includes(id)) item[field].push(id);
      }
    }

    saveDemoMenuItems(items);
    return null;
  }

  const supabase = getSupabase();

  if (input.category === "pizza") {
    const [{ data: bases }, { data: toppings }] = await Promise.all([
      supabase.from("menu_items").select("id").eq("category", "base"),
      supabase.from("menu_items").select("id").eq("category", "topping"),
    ]);
    const allowedBaseIds = sanitizeAllowedIds(input.allowedBaseIds, (bases ?? []).map((b: any) => b.id));
    if (allowedBaseIds.length === 0) return "Select at least one allowed base.";
    const allowedToppingIds = sanitizeAllowedIds(input.allowedToppingIds, (toppings ?? []).map((t: any) => t.id));

    const { error } = await supabase.from("menu_items").insert({
      category: input.category,
      name,
      price: input.priceRupees,
      is_veg: input.isVeg,
      allowed_base_ids: allowedBaseIds,
      allowed_topping_ids: allowedToppingIds,
    });
    if (!error) return null;
    if (error.code === "23505") return "An item with this name already exists in this category.";
    return error.message;
  }

  const { data: inserted, error } = await supabase
    .from("menu_items")
    .insert({ category: input.category, name, price: input.priceRupees, is_veg: input.isVeg })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") return "An item with this name already exists in this category.";
    return error.message;
  }
  if (input.allowOnAllPizzas !== false && inserted) {
    const column = input.category === "base" ? "allowed_base_ids" : "allowed_topping_ids";
    await appendIdToAllPizzas(supabase, column, inserted.id);
  }
  return null;
}

export async function updateMenuItem(
  id: string,
  input: {
    name: string;
    priceRupees: number;
    isVeg: boolean;
    allowedBaseIds?: string[]; // pizza only — omit for base/topping edits
    allowedToppingIds?: string[]; // pizza only
  }
): Promise<string | null> {
  const validationError = validateMenuItemInput(input.name, input.priceRupees);
  if (validationError) return validationError;
  const name = input.name.trim();

  if (isDemoMode) {
    const items = loadDemoMenuItems();
    const item = items.find((i) => i.id === id);
    if (!item) return "Item not found.";
    if (input.allowedBaseIds !== undefined) {
      const validBaseIds = items.filter((i) => i.category === "base").map((i) => i.id);
      const allowedBaseIds = sanitizeAllowedIds(input.allowedBaseIds, validBaseIds);
      if (allowedBaseIds.length === 0) return "Select at least one allowed base.";
      item.allowedBaseIds = allowedBaseIds;
    }
    if (input.allowedToppingIds !== undefined) {
      const validToppingIds = items.filter((i) => i.category === "topping").map((i) => i.id);
      item.allowedToppingIds = sanitizeAllowedIds(input.allowedToppingIds, validToppingIds);
    }
    item.name = name;
    item.pricePaise = rupeesToPaise(input.priceRupees);
    item.isVeg = input.isVeg;
    saveDemoMenuItems(items);
    return null;
  }

  const supabase = getSupabase();
  const fields: Record<string, unknown> = { name, price: input.priceRupees, is_veg: input.isVeg };
  if (input.allowedBaseIds !== undefined) {
    const { data: bases } = await supabase.from("menu_items").select("id").eq("category", "base");
    const allowedBaseIds = sanitizeAllowedIds(input.allowedBaseIds, (bases ?? []).map((b: any) => b.id));
    if (allowedBaseIds.length === 0) return "Select at least one allowed base.";
    fields.allowed_base_ids = allowedBaseIds;
  }
  if (input.allowedToppingIds !== undefined) {
    const { data: toppings } = await supabase.from("menu_items").select("id").eq("category", "topping");
    fields.allowed_topping_ids = sanitizeAllowedIds(input.allowedToppingIds, (toppings ?? []).map((t: any) => t.id));
  }

  const { error } = await supabase.from("menu_items").update(fields).eq("id", id);
  if (!error) return null;
  if (error.code === "23505") return "An item with this name already exists in this category.";
  return error.message;
}

export async function setMenuItemActive(id: string, isActive: boolean): Promise<string | null> {
  if (isDemoMode) {
    const items = loadDemoMenuItems();
    const item = items.find((i) => i.id === id);
    if (!item) return "Item not found.";
    item.isActive = isActive;
    saveDemoMenuItems(items);
    return null;
  }
  const { error } = await getSupabase().from("menu_items").update({ is_active: isActive }).eq("id", id);
  return error ? error.message : null;
}

// ---------------------------------------------------------------- orders
// Lifecycle: "Confirm and order" persists the cart — the first call creates
// the order (status 'placed', payment_mode null); later calls just insert
// the newly-added lines onto the same order and refresh the running bill
// totals. "Finish and pay" (finishAndPayOrder) makes sure everything is
// confirmed, then sets payment_mode and status 'paid'. Kitchen delivery
// itself is out of scope — this only tracks confirmed vs. paid.

function lineToOrderLine(line: CartLine): CompletedOrder["lines"][number] {
  const unitPricePaise =
    line.base.pricePaise + line.pizza.pricePaise + line.toppings.reduce((s, t) => s + t.pricePaise, 0);
  return {
    baseName: line.base.name,
    pizzaName: line.pizza.name,
    toppingNames: line.toppings.map((t) => t.name),
    quantity: line.quantity,
    unitPricePaise,
    lineTotalPaise: unitPricePaise * line.quantity,
  };
}

interface DemoOrderRecord extends Omit<CompletedOrder, "paymentMode"> {
  paymentMode: PaymentMode | null;
  status: "placed" | "paid" | "cancelled";
}

/** Raw localStorage record store, including still-'placed' (unpaid) orders. */
function loadDemoOrderRecords(): DemoOrderRecord[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = JSON.parse(localStorage.getItem(DEMO_ORDERS_KEY) ?? "[]");
    // Legacy entries predate the placed/paid lifecycle (and promo codes) —
    // under the old one-shot flow every stored order was already fully paid,
    // and no order had a promo applied before the feature existed.
    return raw.map((o: any) => ({ status: "paid", promoCode: null, promoDiscountPaise: 0, ...o }));
  } catch {
    return [];
  }
}

function saveDemoOrderRecords(records: DemoOrderRecord[]): void {
  localStorage.setItem(DEMO_ORDERS_KEY, JSON.stringify(records));
}

/**
 * Thrown by confirmOrder/finishAndPayOrder when the order they're about to
 * mutate is no longer 'placed' — i.e. admin "Close table" cancelled it out
 * from under an in-progress customer session. The ordering page catches this
 * specifically to show a full-screen "contact the waiter" notice instead of
 * a normal retryable error.
 */
export class TableClosedError extends Error {
  readonly closed = true as const;
}

const TABLE_CLOSED_MESSAGE = "This table was closed by staff — please contact the waiter and start a new order.";

export async function confirmOrder(params: {
  orderId: string | null;
  customerName: string;
  phone: string;
  tableNumber: number;
  sessionStartedAt: string;
  cart: CartLine[]; // full cart so far (confirmed + newLines) — bill totals reflect this
  newLines: CartLine[]; // just the not-yet-persisted lines to insert this call
  promo?: AppliedPromo | null; // redeemed promo code, if any
}): Promise<string> {
  const bill = computeBill(params.cart, params.promo);

  if (isDemoMode) {
    const records = loadDemoOrderRecords();
    const existing = params.orderId ? records.find((o) => o.id === params.orderId) : undefined;
    if (existing && existing.status !== "placed") throw new TableClosedError(TABLE_CLOSED_MESSAGE);
    if (existing) {
      existing.customerName = params.customerName;
      existing.phone = params.phone;
      existing.tableNumber = params.tableNumber;
      existing.lines = params.cart.map(lineToOrderLine);
      existing.subtotalPaise = bill.subtotalPaise;
      existing.discountPaise = bill.discountPaise;
      existing.promoDiscountPaise = bill.promoDiscountPaise;
      existing.promoCode = bill.promoCode;
      existing.gstPaise = bill.gstPaise;
      existing.totalPaise = bill.totalPaise;
      saveDemoOrderRecords(records);
      return existing.id;
    }
    const id = generateUUID();
    records.unshift({
      id,
      createdAt: new Date().toISOString(),
      sessionStartedAt: params.sessionStartedAt,
      customerName: params.customerName,
      phone: params.phone,
      tableNumber: params.tableNumber,
      lines: params.cart.map(lineToOrderLine),
      subtotalPaise: bill.subtotalPaise,
      discountPaise: bill.discountPaise,
      promoDiscountPaise: bill.promoDiscountPaise,
      promoCode: bill.promoCode,
      gstPaise: bill.gstPaise,
      totalPaise: bill.totalPaise,
      paymentMode: null,
      status: "placed",
    });
    saveDemoOrderRecords(records);
    return id;
  }

  const supabase = getSupabase();
  const billFields = {
    customer_name: params.customerName,
    phone: params.phone,
    table_number: params.tableNumber,
    subtotal: paiseToRupees(bill.subtotalPaise),
    discount: paiseToRupees(bill.discountPaise),
    promo_code: bill.promoCode,
    promo_discount: paiseToRupees(bill.promoDiscountPaise),
    gst: paiseToRupees(bill.gstPaise),
    total: paiseToRupees(bill.totalPaise),
  };

  if (!params.orderId) {
    const id = generateUUID();
    // RLS note: the anon role may INSERT orders but never SELECT them, so
    // this call must not use `.select()` (RETURNING would be checked against
    // the SELECT policy and rejected). The id is generated client-side instead.
    const { error: orderError } = await supabase
      .from("orders")
      .insert({ id, session_started_at: params.sessionStartedAt, status: "placed", ...billFields });
    if (orderError) throw dbError("Could not confirm the order", orderError);
    await insertOrderLines(supabase, id, params.newLines);
    return id;
  }

  await updateOrderFields(params.orderId, billFields);
  await insertOrderLines(supabase, params.orderId, params.newLines);
  return params.orderId;
}

async function insertOrderLines(
  supabase: ReturnType<typeof getSupabase>,
  orderId: string,
  lines: CartLine[]
): Promise<void> {
  if (!lines.length) return;
  const itemRows = lines.map((line) => ({
    id: generateUUID(),
    order_id: orderId,
    base_id: line.base.id,
    pizza_id: line.pizza.id,
    base_name: line.base.name,
    pizza_name: line.pizza.name,
    quantity: line.quantity,
    unit_price: paiseToRupees(
      line.base.pricePaise + line.pizza.pricePaise + line.toppings.reduce((s, t) => s + t.pricePaise, 0)
    ),
  }));
  const { error: itemError } = await supabase.from("order_items").insert(itemRows);
  if (itemError) throw dbError("Could not save an order line", itemError);

  const toppingRows = lines.flatMap((line, index) =>
    line.toppings.map((t) => ({
      order_item_id: itemRows[index].id,
      topping_id: t.id,
      topping_name: t.name,
      price: paiseToRupees(t.pricePaise),
    }))
  );
  if (toppingRows.length) {
    const { error: topError } = await supabase.from("order_item_toppings").insert(toppingRows);
    if (topError) throw dbError("Could not save toppings", topError);
  }
}

export async function finishAndPayOrder(params: {
  orderId: string | null;
  customerName: string;
  phone: string;
  tableNumber: number;
  sessionStartedAt: string;
  cart: CartLine[];
  newLines: CartLine[]; // any still-unconfirmed lines — confirmed here if present
  paymentMode: PaymentMode;
  promo?: AppliedPromo | null;
}): Promise<CompletedOrder> {
  const orderId =
    !params.orderId || params.newLines.length > 0
      ? await confirmOrder({
          orderId: params.orderId,
          customerName: params.customerName,
          phone: params.phone,
          tableNumber: params.tableNumber,
          sessionStartedAt: params.sessionStartedAt,
          cart: params.cart,
          newLines: params.newLines,
          promo: params.promo,
        })
      : params.orderId;

  const bill = computeBill(params.cart, params.promo);
  const order: CompletedOrder = {
    id: orderId,
    createdAt: new Date().toISOString(),
    sessionStartedAt: params.sessionStartedAt,
    customerName: params.customerName,
    phone: params.phone,
    tableNumber: params.tableNumber,
    lines: params.cart.map(lineToOrderLine),
    subtotalPaise: bill.subtotalPaise,
    discountPaise: bill.discountPaise,
    promoDiscountPaise: bill.promoDiscountPaise,
    promoCode: bill.promoCode,
    gstPaise: bill.gstPaise,
    totalPaise: bill.totalPaise,
    paymentMode: params.paymentMode,
  };

  if (isDemoMode) {
    const records = loadDemoOrderRecords();
    const existing = records.find((o) => o.id === orderId);
    if (existing && existing.status !== "placed") throw new TableClosedError(TABLE_CLOSED_MESSAGE);
    if (existing) {
      existing.paymentMode = params.paymentMode;
      existing.status = "paid";
      existing.subtotalPaise = bill.subtotalPaise;
      existing.discountPaise = bill.discountPaise;
      existing.promoDiscountPaise = bill.promoDiscountPaise;
      existing.promoCode = bill.promoCode;
      existing.gstPaise = bill.gstPaise;
      existing.totalPaise = bill.totalPaise;
      saveDemoOrderRecords(records);
    }
    await closeTableSession(params.tableNumber);
    return order;
  }

  await updateOrderFields(orderId, {
    payment_mode: params.paymentMode,
    status: "paid",
    subtotal: paiseToRupees(bill.subtotalPaise),
    discount: paiseToRupees(bill.discountPaise),
    promo_code: bill.promoCode,
    promo_discount: paiseToRupees(bill.promoDiscountPaise),
    gst: paiseToRupees(bill.gstPaise),
    total: paiseToRupees(bill.totalPaise),
  });
  await closeTableSession(params.tableNumber);

  return order;
}

/**
 * Updates to `orders` (running bill totals on each confirm, then
 * payment_mode/status on finish) go through this server route with the
 * service-role key rather than the anon client directly: the anon-role RLS
 * "update while placed" policy — despite a correct policy definition and
 * grants — was not reliably applying in this project's Supabase instance, so
 * the writes silently matched zero rows. Routing through the server sidesteps
 * that entirely. (Inserts are unaffected and stay on the anon client above.)
 */
async function updateOrderFields(orderId: string, fields: Record<string, unknown>): Promise<void> {
  const response = await fetch("/api/orders/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId, fields }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}) as { error?: string; closed?: boolean });
    const message = payload.error || "Could not update the order.";
    if (payload.closed) throw new TableClosedError(message);
    throw new Error(message);
  }
}

/** Paid orders only — a placed-but-abandoned cart is not a completed sale. */
export async function getOrders(): Promise<CompletedOrder[]> {
  if (isDemoMode) {
    return loadDemoOrderRecords()
      .filter((o): o is DemoOrderRecord & { paymentMode: PaymentMode } => o.status === "paid")
      .map(({ status, ...order }) => order);
  }

  const { data, error } = await getSupabase()
    .from("orders")
    .select(
      `id, created_at, session_started_at, customer_name, phone, table_number,
       subtotal, discount, promo_code, promo_discount, gst, total, payment_mode,
       order_items ( base_name, pizza_name, quantity, unit_price,
         order_item_toppings ( topping_name ) )`
    )
    .eq("status", "paid")
    .order("created_at", { ascending: false });
  if (error) throw dbError("Could not load orders", error);

  return (data ?? []).map((row: any): CompletedOrder => ({
    id: row.id,
    createdAt: row.created_at,
    sessionStartedAt: row.session_started_at,
    customerName: row.customer_name,
    phone: row.phone,
    tableNumber: row.table_number ?? null,
    lines: (row.order_items ?? []).map((item: any) => ({
      baseName: item.base_name,
      pizzaName: item.pizza_name,
      toppingNames: (item.order_item_toppings ?? []).map((t: any) => t.topping_name),
      quantity: item.quantity,
      unitPricePaise: rupeesToPaise(item.unit_price),
      lineTotalPaise: rupeesToPaise(item.unit_price) * item.quantity,
    })),
    subtotalPaise: rupeesToPaise(row.subtotal),
    discountPaise: rupeesToPaise(row.discount),
    promoDiscountPaise: rupeesToPaise(row.promo_discount ?? 0),
    promoCode: row.promo_code ?? null,
    gstPaise: rupeesToPaise(row.gst),
    totalPaise: rupeesToPaise(row.total),
    paymentMode: row.payment_mode,
  }));
}

// ------------------------------------------------------- table sessions
// Seating record, separate from `orders`: a table becomes occupied the
// moment staff pick it at the gate (openTableSession), before any order
// exists, and frees automatically when the order is paid (closeTableSession,
// wired into finishAndPayOrder above) or manually via admin "Close table"
// (closeTableAsAdmin) for an abandoned seat.

interface DemoTableSession {
  id: string;
  tableNumber: number;
  status: "open" | "closed";
  startedAt: string;
  closedAt: string | null;
}

function loadDemoTableSessions(): DemoTableSession[] {
  if (typeof localStorage === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(DEMO_TABLE_SESSIONS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveDemoTableSessions(sessions: DemoTableSession[]): void {
  localStorage.setItem(DEMO_TABLE_SESSIONS_KEY, JSON.stringify(sessions));
}

/** Table numbers currently seated — read by the customer gate to disable them. */
export async function getOccupiedTables(): Promise<number[]> {
  if (isDemoMode) {
    return loadDemoTableSessions()
      .filter((s) => s.status === "open")
      .map((s) => s.tableNumber);
  }
  // Anon reads this via the owner-privileged `occupied_tables` view (like
  // best_seller_pizzas) since anon has no SELECT policy on table_sessions.
  const { data, error } = await getSupabase().from("occupied_tables").select("table_number");
  if (error || !data) return []; // never blocks seating — worst case a race, still caught below
  return data.map((row: { table_number: number }) => row.table_number);
}

/** Seats a table at the gate. `occupied: true` means someone else got there first. */
export async function openTableSession(tableNumber: number): Promise<{ ok: boolean; occupied: boolean }> {
  if (isDemoMode) {
    const sessions = loadDemoTableSessions();
    if (sessions.some((s) => s.tableNumber === tableNumber && s.status === "open")) {
      return { ok: false, occupied: true };
    }
    sessions.push({
      id: generateUUID(),
      tableNumber,
      status: "open",
      startedAt: new Date().toISOString(),
      closedAt: null,
    });
    saveDemoTableSessions(sessions);
    return { ok: true, occupied: false };
  }

  // Routed through a service-role server route rather than the anon client
  // directly — see /api/tables and the same reasoning on updateOrderFields.
  const response = await fetch("/api/tables", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "open", tableNumber }),
  });
  if (!response.ok) return { ok: false, occupied: false };
  const payload = await response.json();
  return { ok: !payload.occupied, occupied: Boolean(payload.occupied) };
}

/** Frees a table's seating session on payment. Best-effort — never blocks checkout. */
async function closeTableSession(tableNumber: number): Promise<void> {
  if (isDemoMode) {
    const sessions = loadDemoTableSessions();
    const session = sessions.find((s) => s.tableNumber === tableNumber && s.status === "open");
    if (session) {
      session.status = "closed";
      session.closedAt = new Date().toISOString();
      saveDemoTableSessions(sessions);
    }
    return;
  }
  try {
    await fetch("/api/tables", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "close", tableNumber }),
    });
  } catch {
    // A stuck-open session can still be freed later via admin "Close table".
  }
}

/** Admin live-tables grid: every table, seated or not, with its running order. */
export async function getLiveTables(): Promise<LiveTable[]> {
  const tableNumbers = Array.from({ length: TABLE_COUNT }, (_, i) => i + 1);

  if (isDemoMode) {
    const openSessions = loadDemoTableSessions().filter((s) => s.status === "open");
    const placedOrders = loadDemoOrderRecords().filter((o) => o.status === "placed");
    return tableNumbers.map((tableNumber) => {
      const session = openSessions.find((s) => s.tableNumber === tableNumber);
      const order = placedOrders.find((o) => o.tableNumber === tableNumber);
      return {
        tableNumber,
        occupied: Boolean(session),
        seatedAt: session?.startedAt ?? null,
        order: order
          ? { id: order.id, customerName: order.customerName, phone: order.phone, lines: order.lines, totalPaise: order.totalPaise }
          : null,
      };
    });
  }

  const supabase = getSupabase();
  const [{ data: sessions, error: sessionsError }, { data: orders, error: ordersError }] = await Promise.all([
    supabase.from("table_sessions").select("table_number, started_at").eq("status", "open"),
    supabase
      .from("orders")
      .select(
        `id, table_number, customer_name, phone, total,
         order_items ( base_name, pizza_name, quantity, unit_price,
           order_item_toppings ( topping_name ) )`
      )
      .eq("status", "placed"),
  ]);
  if (sessionsError) throw dbError("Could not load table sessions", sessionsError);
  if (ordersError) throw dbError("Could not load open orders", ordersError);

  return tableNumbers.map((tableNumber) => {
    const session = (sessions ?? []).find((s: any) => s.table_number === tableNumber);
    const order = (orders ?? []).find((o: any) => o.table_number === tableNumber);
    const openOrder: OpenOrder | null = order
      ? {
          id: order.id,
          customerName: order.customer_name,
          phone: order.phone,
          lines: (order.order_items ?? []).map((item: any) => ({
            baseName: item.base_name,
            pizzaName: item.pizza_name,
            toppingNames: (item.order_item_toppings ?? []).map((t: any) => t.topping_name),
            quantity: item.quantity,
            unitPricePaise: rupeesToPaise(item.unit_price),
            lineTotalPaise: rupeesToPaise(item.unit_price) * item.quantity,
          })),
          totalPaise: rupeesToPaise(order.total),
        }
      : null;
    return {
      tableNumber,
      occupied: Boolean(session),
      seatedAt: session?.started_at ?? null,
      order: openOrder,
    };
  });
}

/** Admin "Close table": frees an abandoned seat and cancels its unpaid order, if any. */
export async function closeTableAsAdmin(tableNumber: number): Promise<string | null> {
  if (isDemoMode) {
    const sessions = loadDemoTableSessions();
    const session = sessions.find((s) => s.tableNumber === tableNumber && s.status === "open");
    if (session) {
      session.status = "closed";
      session.closedAt = new Date().toISOString();
      saveDemoTableSessions(sessions);
    }
    const orders = loadDemoOrderRecords();
    const order = orders.find((o) => o.tableNumber === tableNumber && o.status === "placed");
    if (order) {
      order.status = "cancelled";
      saveDemoOrderRecords(orders);
    }
    return null;
  }

  const supabase = getSupabase();
  const { error: sessionError } = await supabase
    .from("table_sessions")
    .update({ status: "closed", closed_at: new Date().toISOString() })
    .eq("table_number", tableNumber)
    .eq("status", "open");
  if (sessionError) return sessionError.message;

  const { error: orderError } = await supabase
    .from("orders")
    .update({ status: "cancelled" })
    .eq("table_number", tableNumber)
    .eq("status", "placed");
  return orderError ? orderError.message : null;
}

// ------------------------------------------------------------- feedback
// Post-payment ratings/feedback captured on the bill page: a star rating per
// pizza (keyed by name — order ids are generated client-side and never read
// back, so names are what the bill page already has), an overall rating,
// tap-only quick tags, and an optional free-text comment.

const DEMO_FEEDBACK_KEY = "pizzaflow_demo_feedback";

export interface OrderFeedbackInput {
  orderId: string;
  overallRating: number | null;
  pizzaRatings: Record<string, number>;
  quickTags: string[];
  comments: string;
}

export async function submitOrderFeedback(input: OrderFeedbackInput): Promise<string | null> {
  const comments = input.comments.trim();
  if (comments.length > 1000) return "Feedback must be at most 1000 characters.";

  if (isDemoMode) {
    if (typeof localStorage !== "undefined") {
      const existing = JSON.parse(localStorage.getItem(DEMO_FEEDBACK_KEY) ?? "[]");
      existing.push({ ...input, comments, createdAt: new Date().toISOString() });
      localStorage.setItem(DEMO_FEEDBACK_KEY, JSON.stringify(existing));
    }
    return null;
  }

  const { error } = await getSupabase().from("order_feedback").insert({
    order_id: input.orderId,
    overall_rating: input.overallRating,
    pizza_ratings: input.pizzaRatings,
    quick_tags: input.quickTags,
    comments: comments || null,
  });
  return error ? dbError("Could not save your feedback", error).message : null;
}

export interface OrderFeedbackRecord {
  id: string;
  orderId: string;
  createdAt: string;
  overallRating: number | null;
  pizzaRatings: Record<string, number>;
  quickTags: string[];
  comments: string | null;
}

/** Admin-only: every feedback submission, for the Ratings page. */
export async function getOrderFeedback(): Promise<OrderFeedbackRecord[]> {
  if (isDemoMode) {
    if (typeof localStorage === "undefined") return [];
    try {
      const raw = JSON.parse(localStorage.getItem(DEMO_FEEDBACK_KEY) ?? "[]");
      return raw.map((entry: any) => ({
        id: entry.orderId,
        orderId: entry.orderId,
        createdAt: entry.createdAt,
        overallRating: entry.overallRating ?? null,
        pizzaRatings: entry.pizzaRatings ?? {},
        quickTags: entry.quickTags ?? [],
        comments: entry.comments || null,
      }));
    } catch {
      return [];
    }
  }

  const { data, error } = await getSupabase()
    .from("order_feedback")
    .select("id, order_id, created_at, overall_rating, pizza_ratings, quick_tags, comments")
    .order("created_at", { ascending: false });
  if (error) throw dbError("Could not load feedback", error);

  return (data ?? []).map((row: any): OrderFeedbackRecord => ({
    id: row.id,
    orderId: row.order_id,
    createdAt: row.created_at,
    overallRating: row.overall_rating,
    pizzaRatings: row.pizza_ratings ?? {},
    quickTags: row.quick_tags ?? [],
    comments: row.comments,
  }));
}

const BEST_SELLER_COUNT = 2;

/** Ids of the top-selling pizzas of all time, for the "Best seller" tag on the menu. */
export async function getBestSellerPizzaIds(): Promise<string[]> {
  if (isDemoMode) {
    const counts = new Map<string, number>();
    for (const order of loadDemoOrderRecords().filter((o) => o.status === "paid")) {
      for (const line of order.lines) {
        counts.set(line.pizzaName, (counts.get(line.pizzaName) ?? 0) + line.quantity);
      }
    }
    const idsByName = new Map(
      loadDemoMenuItems()
        .filter((i) => i.category === "pizza")
        .map((i) => [i.name, i.id])
    );
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, BEST_SELLER_COUNT)
      .map(([name]) => idsByName.get(name))
      .filter((id): id is string => Boolean(id));
  }

  const { data, error } = await getSupabase()
    .from("best_seller_pizzas")
    .select("pizza_id")
    .order("total_quantity", { ascending: false })
    .limit(BEST_SELLER_COUNT);
  if (error || !data) return []; // never blocks ordering — the tag just won't show
  return data.map((row: { pizza_id: string }) => row.pizza_id);
}

// ------------------------------------------------------------ promo codes
// Admin → Promos creates a code the customer types in at checkout (or picks
// from "see available codes"). A code is live purely by date math — no
// separate publish/unpublish step and no cron job: it simply stops being
// offered once `endsAt` passes. Rows are never deleted once their window has
// started, so redemption history (revenue vs. discount given per code) stays
// queryable long after a promo has ended.

export interface PromoCode {
  id: string;
  code: string;
  headline: string; // shown on the ordering-page banner
  message: string; // shown on the banner and in the "available codes" list
  discountType: PromoDiscountType;
  discountValue: number; // percent (1-50); unused for "topping"
  featuredItemId: string | null; // pizza id the "topping" discount targets
  startsAt: string; // ISO
  endsAt: string; // ISO
  createdAt: string;
}

const DEMO_PROMO_CODES_KEY = "pizzaflow_demo_promo_codes";

function loadDemoPromoCodes(): PromoCode[] {
  if (typeof localStorage === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(DEMO_PROMO_CODES_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveDemoPromoCodes(codes: PromoCode[]): void {
  localStorage.setItem(DEMO_PROMO_CODES_KEY, JSON.stringify(codes));
}

/** Every promo code ever created, newest first — feeds both the live/scheduled list and the history table. */
export async function getPromoCodes(): Promise<PromoCode[]> {
  if (isDemoMode) {
    return [...loadDemoPromoCodes()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
  const { data, error } = await getSupabase()
    .from("promo_codes")
    .select(
      "id, code, headline, message, discount_type, discount_value, featured_item_id, starts_at, ends_at, created_at"
    )
    .order("created_at", { ascending: false });
  if (error) return []; // never blocks ordering — codes just won't show
  return (data ?? []).map(
    (row: any): PromoCode => ({
      id: row.id,
      code: row.code,
      headline: row.headline,
      message: row.message,
      discountType: row.discount_type,
      discountValue: Number(row.discount_value),
      featuredItemId: row.featured_item_id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      createdAt: row.created_at,
    })
  );
}

/** Codes whose window includes right now — what the ordering page may offer and redeem. */
export async function getActivePromoCodes(): Promise<PromoCode[]> {
  const now = Date.now();
  return (await getPromoCodes()).filter(
    (c) => new Date(c.startsAt).getTime() <= now && new Date(c.endsAt).getTime() >= now
  );
}

export interface PromoCodeInput {
  code: string;
  headline: string;
  message: string;
  discountType: PromoDiscountType;
  discountValue: number;
  featuredItemId: string | null;
  startsAt: string; // anything `new Date()` accepts, e.g. a datetime-local value
  endsAt: string;
}

function validatePromoCodeInput(code: string, headline: string, message: string, input: PromoCodeInput): string | null {
  if (!/^[A-Z0-9]{3,12}$/.test(code)) return "The code must be 3-12 letters/numbers (A-Z, 0-9) only.";
  if (!headline) return "The banner needs a headline.";
  if (headline.length > 80) return "The headline must be at most 80 characters.";
  if (!message) return "The banner needs a message.";
  if (message.length > 600) return "The message must be at most 600 characters.";
  if (!(PROMO_DISCOUNT_TYPES as readonly string[]).includes(input.discountType)) return "Invalid discount type.";
  if (input.discountType === "percent") {
    if (!(input.discountValue >= PROMO_PERCENT_MIN && input.discountValue <= PROMO_PERCENT_MAX)) {
      return `Percent off must be between ${PROMO_PERCENT_MIN} and ${PROMO_PERCENT_MAX}.`;
    }
  } else if (!input.featuredItemId) {
    return "Pick which pizza the free topping applies to.";
  }
  const start = new Date(input.startsAt).getTime();
  const end = new Date(input.endsAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "Pick a valid start and end date/time.";
  if (end <= start) return "The end date/time must be after the start.";
  return null;
}

export async function createPromoCode(input: PromoCodeInput): Promise<string | null> {
  const code = input.code.trim().toUpperCase();
  const headline = input.headline.trim();
  const message = input.message.trim();
  const validationError = validatePromoCodeInput(code, headline, message, input);
  if (validationError) return validationError;

  const discountValue = input.discountType === "percent" ? input.discountValue : 0;
  const featuredItemId = input.discountType === "topping" ? input.featuredItemId : null;
  const startsAt = new Date(input.startsAt).toISOString();
  const endsAt = new Date(input.endsAt).toISOString();

  if (isDemoMode) {
    const codes = loadDemoPromoCodes();
    if (codes.some((c) => c.code === code)) return "That code is already in use — pick another.";
    codes.push({
      id: generateUUID(),
      code,
      headline,
      message,
      discountType: input.discountType,
      discountValue,
      featuredItemId,
      startsAt,
      endsAt,
      createdAt: new Date().toISOString(),
    });
    saveDemoPromoCodes(codes);
    return null;
  }

  const { error } = await getSupabase().from("promo_codes").insert({
    code,
    headline,
    message,
    discount_type: input.discountType,
    discount_value: discountValue,
    featured_item_id: featuredItemId,
    starts_at: startsAt,
    ends_at: endsAt,
  });
  if (!error) return null;
  if (error.code === "23505") return "That code is already in use — pick another.";
  return error.message;
}

/**
 * Ends a code's window right now instead of deleting it, so redemption history
 * survives. A code that hasn't started yet has no history to preserve, so it is
 * removed outright (an `ends_at` before `starts_at` would violate the schema's
 * own CHECK constraint).
 */
export async function deactivatePromoCode(id: string): Promise<string | null> {
  const now = new Date();
  const codes = await getPromoCodes();
  const code = codes.find((c) => c.id === id);
  if (!code) return "Promo code not found.";
  const notYetStarted = new Date(code.startsAt) > now;

  if (isDemoMode) {
    if (notYetStarted) {
      saveDemoPromoCodes(loadDemoPromoCodes().filter((c) => c.id !== id));
    } else if (new Date(code.endsAt) > now) {
      const all = loadDemoPromoCodes();
      const target = all.find((c) => c.id === id);
      if (target) target.endsAt = now.toISOString();
      saveDemoPromoCodes(all);
    }
    return null;
  }

  if (notYetStarted) {
    const { error } = await getSupabase().from("promo_codes").delete().eq("id", id);
    return error ? error.message : null;
  }
  if (new Date(code.endsAt) > now) {
    const { error } = await getSupabase()
      .from("promo_codes")
      .update({ ends_at: now.toISOString() })
      .eq("id", id);
    return error ? error.message : null;
  }
  return null; // already expired — nothing to do
}

// ---------------------------------------------------------------- settings

export interface OutletSettings {
  name: string;
  location: string;
  phone: string;
}

export const DEFAULT_OUTLET: OutletSettings = {
  name: "SliceMatic",
  location: "New Ashok Nagar, Delhi",
  phone: "",
};

const DEMO_SETTINGS_KEY = "pizzaflow_demo_settings";

export async function getOutletSettings(): Promise<OutletSettings> {
  if (isDemoMode) {
    try {
      return { ...DEFAULT_OUTLET, ...JSON.parse(localStorage.getItem(DEMO_SETTINGS_KEY) ?? "{}") };
    } catch {
      return DEFAULT_OUTLET;
    }
  }
  // Branding must never take the ordering page down: fall back to defaults.
  const { data, error } = await getSupabase().from("settings").select("key, value");
  if (error || !data) return DEFAULT_OUTLET;
  const map = Object.fromEntries(data.map((row: { key: string; value: string }) => [row.key, row.value]));
  return {
    name: map.outlet_name?.trim() || DEFAULT_OUTLET.name,
    location: map.outlet_location?.trim() || DEFAULT_OUTLET.location,
    phone: map.outlet_phone?.trim() || DEFAULT_OUTLET.phone,
  };
}

export async function saveOutletSettings(settings: OutletSettings): Promise<string | null> {
  const name = settings.name.trim();
  const location = settings.location.trim();
  const phone = settings.phone.trim();
  if (!name) return "The outlet name cannot be empty.";
  if (name.length > 40) return "The outlet name must be at most 40 characters.";
  if (location.length > 200) return "The address must be at most 200 characters.";
  if (phone.length > 20) return "The phone number must be at most 20 characters.";

  if (isDemoMode) {
    localStorage.setItem(DEMO_SETTINGS_KEY, JSON.stringify({ name, location, phone }));
    return null;
  }
  const { error } = await getSupabase()
    .from("settings")
    .upsert([
      { key: "outlet_name", value: name },
      { key: "outlet_location", value: location },
      { key: "outlet_phone", value: phone },
    ]);
  return error ? error.message : null;
}

// ------------------------------------------------------------- AI kill switch
// A single toggle that turns off every AI feature at once — the answer
// to "what if this misbehaves, or you just want it off for a while". It is
// enforced in TWO places: the UI hides the AI panels (this module, read by
// the pages), and every /api/ai/* route re-checks it server-side before
// calling OpenRouter, so it cannot be bypassed by calling the API directly.

const DEMO_AI_ENABLED_KEY = "pizzaflow_demo_ai_enabled";

export async function isAiEnabled(): Promise<boolean> {
  if (isDemoMode) {
    // API routes run server-side even in demo mode and have no localStorage;
    // default to enabled there. The browser-side toggle still hides the UI.
    if (typeof localStorage === "undefined") return true;
    return localStorage.getItem(DEMO_AI_ENABLED_KEY) !== "false";
  }
  const { data, error } = await getSupabase()
    .from("settings")
    .select("value")
    .eq("key", "ai_enabled")
    .maybeSingle();
  if (error || !data) return true; // absent row = enabled (default-on)
  return data.value !== "false";
}

export async function setAiEnabled(enabled: boolean): Promise<string | null> {
  if (isDemoMode) {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(DEMO_AI_ENABLED_KEY, String(enabled));
    }
    return null;
  }
  const { error } = await getSupabase()
    .from("settings")
    .upsert({ key: "ai_enabled", value: String(enabled) });
  return error ? error.message : null;
}

// --------------------------------------------------- per-feature AI controls
// Three finer-grained AI settings layered on top of the master kill switch,
// all stored as key/value rows in the same `settings` table (demo mode keeps
// them in localStorage):
//   * ai_feature_<name>  — a per-feature on/off flag (default on)
//   * ai_model           — the OpenRouter model id (default: env / DEFAULT_MODEL)
//   * ai_custom_<name>   — optional owner "custom instructions" for a feature.
//                          NOT the full prompt: the base prompts stay hidden in
//                          lib/prompts.ts and this text is folded into them,
//                          fenced and lower-priority, at request time.
// Everything is enforced server-side in the /api/ai/* routes, never trusted
// from the client. A feature is live only when the master switch AND its own
// flag are on.

const DEMO_AI_FEATURES_KEY = "pizzaflow_demo_ai_features";
const DEMO_AI_MODEL_KEY = "pizzaflow_demo_ai_model";
const DEMO_AI_CUSTOM_KEY = "pizzaflow_demo_ai_custom";

const featureFlagKey = (feature: AiFeature) => `ai_feature_${feature}`;
const customKey = (feature: AiFeature) => `ai_custom_${feature}`;

/** Read several settings rows at once, keyed by their `key`. */
async function getSettingsMap(keys: string[]): Promise<Record<string, string>> {
  const { data, error } = await getSupabase().from("settings").select("key, value").in("key", keys);
  if (error || !data) return {};
  return Object.fromEntries(data.map((row: { key: string; value: string }) => [row.key, row.value]));
}

function allFeaturesEnabled(): Record<AiFeature, boolean> {
  return Object.fromEntries(AI_FEATURES.map((f) => [f, true])) as Record<AiFeature, boolean>;
}

export async function getAiFeatureFlags(): Promise<Record<AiFeature, boolean>> {
  const flags = allFeaturesEnabled();
  if (isDemoMode) {
    if (typeof localStorage === "undefined") return flags;
    try {
      const raw = localStorage.getItem(DEMO_AI_FEATURES_KEY);
      if (raw) return { ...flags, ...JSON.parse(raw) };
    } catch {
      /* fall through to defaults */
    }
    return flags;
  }
  const map = await getSettingsMap(AI_FEATURES.map(featureFlagKey));
  for (const feature of AI_FEATURES) {
    const value = map[featureFlagKey(feature)];
    if (value !== undefined) flags[feature] = value !== "false";
  }
  return flags;
}

export async function setAiFeatureFlag(feature: AiFeature, enabled: boolean): Promise<string | null> {
  if (isDemoMode) {
    if (typeof localStorage !== "undefined") {
      const flags = await getAiFeatureFlags();
      flags[feature] = enabled;
      localStorage.setItem(DEMO_AI_FEATURES_KEY, JSON.stringify(flags));
    }
    return null;
  }
  const { error } = await getSupabase()
    .from("settings")
    .upsert({ key: featureFlagKey(feature), value: String(enabled) });
  return error ? error.message : null;
}

/** Server-side gate for the routes: master switch AND the feature's own flag. */
export async function isAiFeatureEnabled(feature: AiFeature): Promise<boolean> {
  if (!(await isAiEnabled())) return false;
  return (await getAiFeatureFlags())[feature];
}

/**
 * Each feature's *effective* state (master switch AND its own flag), for
 * client UIs that decide whether to render a panel. The master switch off
 * forces every feature off.
 */
export async function getEffectiveAiFeatures(): Promise<Record<AiFeature, boolean>> {
  const [master, flags] = await Promise.all([isAiEnabled(), getAiFeatureFlags()]);
  if (!master) return Object.fromEntries(AI_FEATURES.map((f) => [f, false])) as Record<AiFeature, boolean>;
  return flags;
}

export async function getAiModel(): Promise<string> {
  // OPENROUTER_MODEL is a server-only env var (undefined in the browser, where
  // it simply resolves to DEFAULT_MODEL for display).
  const envDefault = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  if (isDemoMode) {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem(DEMO_AI_MODEL_KEY) || envDefault;
    }
    return envDefault;
  }
  const map = await getSettingsMap(["ai_model"]);
  return map.ai_model?.trim() || envDefault;
}

export async function setAiModel(model: string): Promise<string | null> {
  const slug = model.trim();
  if (!isValidModelSlug(slug)) {
    return 'Enter a valid OpenRouter model id, e.g. "openai/gpt-4o-mini".';
  }
  if (isDemoMode) {
    if (typeof localStorage !== "undefined") localStorage.setItem(DEMO_AI_MODEL_KEY, slug);
    return null;
  }
  const { error } = await getSupabase().from("settings").upsert({ key: "ai_model", value: slug });
  return error ? error.message : null;
}

/**
 * Every feature's saved custom instructions (absent key = none). This is the
 * short owner-supplied text only — never the base prompt, which is never
 * stored and never leaves the server-side prompts module.
 */
export async function getAiCustomInstructions(): Promise<Partial<Record<AiFeature, string>>> {
  if (isDemoMode) {
    if (typeof localStorage === "undefined") return {};
    try {
      return JSON.parse(localStorage.getItem(DEMO_AI_CUSTOM_KEY) ?? "{}");
    } catch {
      return {};
    }
  }
  const map = await getSettingsMap(AI_FEATURES.map(customKey));
  const custom: Partial<Record<AiFeature, string>> = {};
  for (const feature of AI_FEATURES) {
    const value = map[customKey(feature)];
    if (value != null && value !== "") custom[feature] = value;
  }
  return custom;
}

/**
 * The system prompt a route should actually use: the hidden base for the
 * feature with the owner's sanitised custom instructions folded in (fenced and
 * lower-priority). Data placeholders are left for the route to substitute.
 */
export async function getAiPrompt(feature: AiFeature): Promise<string> {
  const custom = (await getAiCustomInstructions())[feature];
  return composeSystemPrompt(feature, custom);
}

/**
 * Save the owner's custom instructions for a feature. The text is a *tweak*
 * layered onto the hidden base prompt — validated only for length, then
 * sanitised (fence/control-char stripping) before storage and again when
 * composed at request time.
 */
export async function setAiCustomInstructions(feature: AiFeature, text: string): Promise<string | null> {
  const notes = sanitizeCustomInstructions(text);
  if (!notes) return "Enter some instructions, or use Clear to remove them.";
  if (text.trim().length > MAX_CUSTOM_INSTRUCTIONS) {
    return `Keep custom instructions to at most ${MAX_CUSTOM_INSTRUCTIONS} characters.`;
  }
  if (isDemoMode) {
    if (typeof localStorage !== "undefined") {
      const all = await getAiCustomInstructions();
      all[feature] = notes;
      localStorage.setItem(DEMO_AI_CUSTOM_KEY, JSON.stringify(all));
    }
    return null;
  }
  const { error } = await getSupabase()
    .from("settings")
    .upsert({ key: customKey(feature), value: notes });
  return error ? error.message : null;
}

/** Clear the owner's custom instructions so the feature uses the base prompt as-is. */
export async function clearAiCustomInstructions(feature: AiFeature): Promise<string | null> {
  if (isDemoMode) {
    if (typeof localStorage !== "undefined") {
      const all = await getAiCustomInstructions();
      delete all[feature];
      localStorage.setItem(DEMO_AI_CUSTOM_KEY, JSON.stringify(all));
    }
    return null;
  }
  const { error } = await getSupabase().from("settings").delete().eq("key", customKey(feature));
  return error ? error.message : null;
}

// ------------------------------------------------------- OpenRouter API key
// The admin can set the OpenRouter API key from the UI instead of a Vercel env
// var. It is stored in a `secret_`-prefixed settings row that RLS hides from
// anon clients (see supabase/schema.sql), so it is NEVER returned by the public
// REST API. The customer-facing AI routes read it server-side with the
// service-role client, which bypasses RLS. If no key is stored (or the service
// role isn't configured yet), everything falls back to OPENROUTER_API_KEY.

const SECRET_OPENROUTER_KEY = "secret_openrouter_api_key";
const DEMO_AI_KEY_KEY = "pizzaflow_demo_openrouter_key";

/** Show only the last four characters — enough to confirm which key is saved. */
function maskKey(key: string): string {
  return key.length <= 4 ? "••••" : `••••••••${key.slice(-4)}`;
}

/** For the admin UI: the masked stored key, or null if none is saved. */
export async function getStoredOpenRouterKeyMasked(): Promise<string | null> {
  if (isDemoMode) {
    if (typeof localStorage === "undefined") return null;
    const key = localStorage.getItem(DEMO_AI_KEY_KEY);
    return key ? maskKey(key) : null;
  }
  // The signed-in admin is authenticated, so RLS lets this read the secret row.
  const { data } = await getSupabase()
    .from("settings")
    .select("value")
    .eq("key", SECRET_OPENROUTER_KEY)
    .maybeSingle();
  return data?.value ? maskKey(data.value) : null;
}

export async function setOpenRouterKey(key: string): Promise<string | null> {
  const trimmed = key.trim();
  if (trimmed.length < 20) return "That does not look like a valid OpenRouter API key.";
  if (trimmed.length > 200) return "The API key is too long.";
  if (isDemoMode) {
    if (typeof localStorage !== "undefined") localStorage.setItem(DEMO_AI_KEY_KEY, trimmed);
    return null;
  }
  const { error } = await getSupabase()
    .from("settings")
    .upsert({ key: SECRET_OPENROUTER_KEY, value: trimmed });
  return error ? error.message : null;
}

/** Remove the stored key so the routes fall back to OPENROUTER_API_KEY. */
export async function clearOpenRouterKey(): Promise<string | null> {
  if (isDemoMode) {
    if (typeof localStorage !== "undefined") localStorage.removeItem(DEMO_AI_KEY_KEY);
    return null;
  }
  const { error } = await getSupabase().from("settings").delete().eq("key", SECRET_OPENROUTER_KEY);
  return error ? error.message : null;
}

/**
 * Server-side only (AI routes): the OpenRouter key to use — the admin's stored
 * key if present, otherwise OPENROUTER_API_KEY. Reading the secret row needs the
 * service-role client (anon RLS hides it); without it we fall back to env.
 */
export async function getOpenRouterApiKey(): Promise<string | null> {
  const envKey = process.env.OPENROUTER_API_KEY ?? null;
  if (isDemoMode) return envKey;
  const admin = getSupabaseAdmin();
  if (admin) {
    const { data } = await admin
      .from("settings")
      .select("value")
      .eq("key", SECRET_OPENROUTER_KEY)
      .maybeSingle();
    if (data?.value) return data.value;
  }
  return envKey;
}

// ---------------------------------------------------------------- account

export async function adminChangePassword(newPassword: string): Promise<string | null> {
  if (isDemoMode) return "Account settings require a configured Supabase project.";
  if (newPassword.length < 8) return "Password must be at least 8 characters.";
  const { error } = await getSupabase().auth.updateUser({ password: newPassword });
  return error ? error.message : null;
}

export async function getAdminEmail(): Promise<string | null> {
  if (isDemoMode) return null;
  const { data } = await getSupabase().auth.getUser();
  return data.user?.email ?? null;
}

// ---------------------------------------------------------------- admin auth

// Supabase Auth is email-based; admins may also sign in with just the
// username part ("rajan" -> "rajan@slicematic.in").
const ADMIN_EMAIL_DOMAIN = "slicematic.in";

export async function adminSignIn(identifier: string, password: string): Promise<string | null> {
  if (isDemoMode) return null; // demo mode: dashboard is open, with a banner
  const trimmed = identifier.trim();
  const email = trimmed.includes("@") ? trimmed : `${trimmed}@${ADMIN_EMAIL_DOMAIN}`;
  const { error } = await getSupabase().auth.signInWithPassword({ email, password });
  return error ? error.message : null;
}

export async function adminSignOut(): Promise<void> {
  if (!isDemoMode) await getSupabase().auth.signOut();
}

export async function getAdminSession(): Promise<boolean> {
  if (isDemoMode) return true;
  const { data } = await getSupabase().auth.getSession();
  return Boolean(data.session);
}
