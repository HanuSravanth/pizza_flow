// Data layer. One interface, two backends:
//   - Supabase (production): menu_items / orders / order_items / order_item_toppings
//   - Demo mode (no env vars): bundled menu + localStorage orders
// Pages call these functions and never know which backend is live.

import { computeBill } from "./billing";
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
import type { CartLine, CompletedOrder, Menu, MenuCategory, MenuItem, PaymentMode } from "./types";

const DEMO_ORDERS_KEY = "pizzaflow_demo_orders";

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
  status: "placed" | "paid";
}

/** Raw localStorage record store, including still-'placed' (unpaid) orders. */
function loadDemoOrderRecords(): DemoOrderRecord[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = JSON.parse(localStorage.getItem(DEMO_ORDERS_KEY) ?? "[]");
    // Legacy entries predate the placed/paid lifecycle — under the old
    // one-shot flow every stored order was already fully paid.
    return raw.map((o: any) => ({ status: "paid", ...o }));
  } catch {
    return [];
  }
}

function saveDemoOrderRecords(records: DemoOrderRecord[]): void {
  localStorage.setItem(DEMO_ORDERS_KEY, JSON.stringify(records));
}

export async function confirmOrder(params: {
  orderId: string | null;
  customerName: string;
  phone: string;
  tableNumber: number;
  sessionStartedAt: string;
  cart: CartLine[]; // full cart so far (confirmed + newLines) — bill totals reflect this
  newLines: CartLine[]; // just the not-yet-persisted lines to insert this call
  offerTier?: string | null;
  offerIncentive?: string | null;
  appliedPromoCode?: string | null;
}): Promise<string> {
  const bill = computeBill(params.cart, params.appliedPromoCode, params.offerTier, params.offerIncentive);

  if (isDemoMode) {
    const records = loadDemoOrderRecords();
    const existing = params.orderId ? records.find((o) => o.id === params.orderId) : undefined;
    if (existing) {
      existing.customerName = params.customerName;
      existing.phone = params.phone;
      existing.tableNumber = params.tableNumber;
      existing.lines = params.cart.map(lineToOrderLine);
      existing.subtotalPaise = bill.subtotalPaise;
      existing.discountPaise = bill.discountPaise;
      existing.gstPaise = bill.gstPaise;
      existing.totalPaise = bill.totalPaise;
      existing.offerTier = params.offerTier || null;
      existing.offerIncentive = params.offerIncentive || null;
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
      gstPaise: bill.gstPaise,
      totalPaise: bill.totalPaise,
      paymentMode: null,
      status: "placed",
      offerTier: params.offerTier || null,
      offerIncentive: params.offerIncentive || null,
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
    gst: paiseToRupees(bill.gstPaise),
    total: paiseToRupees(bill.totalPaise),
    offer_tier: params.offerTier || null,
    offer_incentive: params.offerIncentive || null,
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
  offerTier?: string | null;
  offerIncentive?: string | null;
  appliedPromoCode?: string | null;
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
          offerTier: params.offerTier,
          offerIncentive: params.offerIncentive,
          appliedPromoCode: params.appliedPromoCode,
        })
      : params.orderId;

  const bill = computeBill(params.cart, params.appliedPromoCode, params.offerTier, params.offerIncentive);

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
    gstPaise: bill.gstPaise,
    totalPaise: bill.totalPaise,
    paymentMode: params.paymentMode,
    offerTier: params.offerTier || null,
    offerIncentive: params.offerIncentive || null,
    appliedPromoCode: params.appliedPromoCode || null,
  };

  if (isDemoMode) {
    const records = loadDemoOrderRecords();
    const existing = records.find((o) => o.id === orderId);
    if (existing) {
      existing.paymentMode = params.paymentMode;
      existing.status = "paid";
      existing.subtotalPaise = bill.subtotalPaise;
      existing.discountPaise = bill.discountPaise;
      existing.gstPaise = bill.gstPaise;
      existing.totalPaise = bill.totalPaise;
      existing.offerTier = params.offerTier || null;
      existing.offerIncentive = params.offerIncentive || null;
      saveDemoOrderRecords(records);
    }
    return order;
  }

  await updateOrderFields(orderId, {
    payment_mode: params.paymentMode,
    status: "paid",
    subtotal: paiseToRupees(bill.subtotalPaise),
    discount: paiseToRupees(bill.discountPaise),
    gst: paiseToRupees(bill.gstPaise),
    total: paiseToRupees(bill.totalPaise),
    offer_tier: params.offerTier || null,
    offer_incentive: params.offerIncentive || null,
  });

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
    const payload = await response.json().catch(() => ({}) as { error?: string });
    throw new Error(payload.error || "Could not update the order.");
  }
}

export interface ActiveOrderRecord {
  id: string;
  createdAt: string;
  sessionStartedAt: string;
  customerName: string;
  phone: string;
  tableNumber: number | null;
  totalPaise: number;
}

export async function getActiveOrders(): Promise<ActiveOrderRecord[]> {
  if (isDemoMode) {
    return loadDemoOrderRecords()
      .filter((o) => o.status === "placed")
      .map((o) => ({
        id: o.id,
        createdAt: o.createdAt,
        sessionStartedAt: o.sessionStartedAt,
        customerName: o.customerName,
        phone: o.phone,
        tableNumber: o.tableNumber,
        totalPaise: o.totalPaise,
      }));
  }

  const { data, error } = await getSupabase()
    .from("orders")
    .select("id, created_at, session_started_at, customer_name, phone, table_number, total")
    .eq("status", "placed")
    .order("created_at", { ascending: false });

  if (error) return [];

  return (data ?? []).map((row: any) => ({
    id: row.id,
    createdAt: row.created_at,
    sessionStartedAt: row.session_started_at,
    customerName: row.customer_name,
    phone: row.phone,
    tableNumber: row.table_number,
    totalPaise: rupeesToPaise(row.total),
  }));
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
       subtotal, discount, gst, total, payment_mode,
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
    gstPaise: rupeesToPaise(row.gst),
    totalPaise: rupeesToPaise(row.total),
    paymentMode: row.payment_mode,
  }));
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

// ---------------------------------------------------------------- settings

export interface OutletSettings {
  name: string;
  location: string;
  phone: string;
  tableCount: number;
}

export const DEFAULT_OUTLET: OutletSettings = {
  name: "SliceMatic",
  location: "New Ashok Nagar, Delhi",
  phone: "",
  tableCount: 15,
};

const DEMO_SETTINGS_KEY = "pizzaflow_demo_settings";

export async function getOutletSettings(): Promise<OutletSettings> {
  if (isDemoMode) {
    try {
      const parsed = JSON.parse(localStorage.getItem(DEMO_SETTINGS_KEY) ?? "{}");
      return {
        ...DEFAULT_OUTLET,
        ...parsed,
        tableCount: parsed.tableCount ? Number(parsed.tableCount) : DEFAULT_OUTLET.tableCount,
      };
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
    tableCount: map.outlet_table_count ? parseInt(map.outlet_table_count, 10) : DEFAULT_OUTLET.tableCount,
  };
}

export async function saveOutletSettings(settings: OutletSettings): Promise<string | null> {
  const name = settings.name.trim();
  const location = settings.location.trim();
  const phone = settings.phone.trim();
  const tableCount = settings.tableCount || 15;
  if (!name) return "The outlet name cannot be empty.";
  if (name.length > 40) return "The outlet name must be at most 40 characters.";
  if (location.length > 200) return "The address must be at most 200 characters.";
  if (phone.length > 20) return "The phone number must be at most 20 characters.";
  if (tableCount < 1 || tableCount > 50) return "The table count must be between 1 and 50.";

  if (isDemoMode) {
    localStorage.setItem(DEMO_SETTINGS_KEY, JSON.stringify({ name, location, phone, tableCount }));
    return null;
  }
  const { error } = await getSupabase()
    .from("settings")
    .upsert([
      { key: "outlet_name", value: name },
      { key: "outlet_location", value: location },
      { key: "outlet_phone", value: phone },
      { key: "outlet_table_count", value: String(tableCount) },
    ]);
  return error ? error.message : null;
}

// ------------------------------------------------------------- AI kill switch
// A single toggle that turns off all four AI features at once — the answer
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
  try {
    const { data } = await getSupabase().auth.getSession();
    return Boolean(data.session);
  } catch (err) {
    console.error("Error in getAdminSession:", err);
    return false;
  }
}

// ------------------------------------------------------------- Seating & Waitlist

export interface DbWaitlistEntry {
  id: string;
  customerName: string;
  phone: string;
  groupSize: number;
  joinedAt: string;
  timeOffsetMinutes: number;
}

export interface DbDineInTable {
  tableNumber: number;
  capacity: number;
  status: "vacant" | "occupied" | "reserved";
  customerName?: string | null;
  groupSize?: number | null;
  seatedAt?: string | null;
}

const DEMO_WAITLIST_KEY = "pizzaflow_admin_waitlist";
const DEMO_MANUAL_TABLES_KEY = "pizzaflow_admin_manual_tables";

export async function getDbWaitlist(): Promise<DbWaitlistEntry[]> {
  if (isDemoMode) {
    if (typeof localStorage === "undefined") return [];
    try {
      const raw = localStorage.getItem(DEMO_WAITLIST_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  const { data, error } = await getSupabase()
    .from("waitlist")
    .select("id, customer_name, phone, group_size, joined_at, time_offset_minutes")
    .eq("status", "waiting")
    .order("joined_at", { ascending: true });

  if (error || !data) return [];

  return data.map((row: any) => ({
    id: row.id,
    customerName: row.customer_name,
    phone: row.phone,
    groupSize: row.group_size,
    joinedAt: row.joined_at,
    timeOffsetMinutes: row.time_offset_minutes,
  }));
}

export async function addDbWaitlistEntry(entry: DbWaitlistEntry): Promise<string | null> {
  if (isDemoMode) {
    if (typeof localStorage === "undefined") return null;
    try {
      const current = await getDbWaitlist();
      const updated = [...current, entry];
      localStorage.setItem(DEMO_WAITLIST_KEY, JSON.stringify(updated));
    } catch (err: any) {
      return err.message;
    }
    return null;
  }

  const { error } = await getSupabase()
    .from("waitlist")
    .insert({
      id: entry.id,
      customer_name: entry.customerName,
      phone: entry.phone,
      group_size: entry.groupSize,
      joined_at: entry.joinedAt,
      time_offset_minutes: entry.timeOffsetMinutes,
      status: "waiting",
    });

  return error ? error.message : null;
}

export async function updateWaitlistTimeOffset(id: string, timeOffsetMinutes: number): Promise<string | null> {
  if (isDemoMode) {
    if (typeof localStorage === "undefined") return null;
    try {
      const current = await getDbWaitlist();
      const updated = current.map((entry) =>
        entry.id === id ? { ...entry, timeOffsetMinutes } : entry
      );
      localStorage.setItem(DEMO_WAITLIST_KEY, JSON.stringify(updated));
    } catch (err: any) {
      return err.message;
    }
    return null;
  }

  const { error } = await getSupabase()
    .from("waitlist")
    .update({ time_offset_minutes: timeOffsetMinutes })
    .eq("id", id);

  return error ? error.message : null;
}

export async function removeWaitlistEntry(
  id: string,
  status: "seated" | "cancelled",
  seatedTableNumber?: number | null,
  seatedAt?: string | null
): Promise<string | null> {
  if (isDemoMode) {
    if (typeof localStorage === "undefined") return null;
    try {
      const current = await getDbWaitlist();
      const updated = current.filter((entry) => entry.id !== id);
      localStorage.setItem(DEMO_WAITLIST_KEY, JSON.stringify(updated));
    } catch (err: any) {
      return err.message;
    }
    return null;
  }

  const { error } = await getSupabase()
    .from("waitlist")
    .update({
      status,
      seated_table_number: seatedTableNumber ?? null,
      seated_at: seatedAt ?? null,
    })
    .eq("id", id);

  return error ? error.message : null;
}

export interface DbDineInTable {
  customerName: string;
  groupSize: number;
  seatedAt: string | null;
  status: "occupied" | "reserved";
  offerTier?: string | null;
  offerIncentive?: string | null;
}

export async function getDbDineInTables(): Promise<Record<number, DbDineInTable>> {
  if (isDemoMode) {
    if (typeof localStorage === "undefined") return {};
    try {
      const raw = localStorage.getItem(DEMO_MANUAL_TABLES_KEY);
      const record: Record<number, DbDineInTable> = raw ? JSON.parse(raw) : {};

      const activeOrders = loadDemoOrderRecords().filter((o) => o.status === "placed");
      for (const o of activeOrders) {
        if (o.tableNumber !== null) {
          record[o.tableNumber] = {
            customerName: o.customerName,
            groupSize: record[o.tableNumber]?.groupSize || 2,
            seatedAt: o.sessionStartedAt || o.createdAt,
            status: "occupied",
            offerTier: record[o.tableNumber]?.offerTier || null,
            offerIncentive: record[o.tableNumber]?.offerIncentive || null,
          };
        }
      }
      return record;
    } catch {
      return {};
    }
  }

  const { data, error } = await getSupabase()
    .from("dine_in_tables")
    .select("table_number, capacity, status, customer_name, group_size, seated_at, offer_tier, offer_incentive")
    .in("status", ["occupied", "reserved"])
    .order("table_number");

  if (error || !data) return {};

  const record: Record<number, DbDineInTable> = {};
  for (const row of data) {
    if (row.customer_name) {
      record[row.table_number] = {
        customerName: row.customer_name,
        groupSize: row.group_size || 2,
        seatedAt: row.seated_at,
        status: (row.status === "reserved" ? "reserved" : "occupied") as "occupied" | "reserved",
        offerTier: row.offer_tier,
        offerIncentive: row.offer_incentive,
      };
    }
  }

  try {
    const { data: orderData, error: orderError } = await getSupabase()
      .from("orders")
      .select("created_at, session_started_at, customer_name, table_number, offer_tier, offer_incentive")
      .eq("status", "placed")
      .not("table_number", "is", null);

    if (!orderError && orderData) {
      for (const row of orderData) {
        if (row.table_number) {
          record[row.table_number] = {
            customerName: row.customer_name,
            groupSize: record[row.table_number]?.groupSize || 2,
            seatedAt: row.session_started_at || row.created_at,
            status: "occupied",
            offerTier: row.offer_tier || record[row.table_number]?.offerTier || null,
            offerIncentive: row.offer_incentive || record[row.table_number]?.offerIncentive || null,
          };
        }
      }
    }
  } catch (err) {
    console.error("Error fetching active orders in getDbDineInTables:", err);
  }

  return record;
}

export async function seatDineInTable(
  tableNumber: number,
  customerName: string,
  groupSize: number,
  status: "occupied" | "reserved" = "occupied",
  offerTier?: string | null,
  offerIncentive?: string | null
): Promise<string | null> {
  if (isDemoMode) {
    if (typeof localStorage === "undefined") return null;
    try {
      const raw = localStorage.getItem(DEMO_MANUAL_TABLES_KEY);
      const current: Record<number, DbDineInTable> = raw ? JSON.parse(raw) : {};
      current[tableNumber] = {
        customerName,
        groupSize,
        seatedAt: status === "occupied" ? new Date().toISOString() : null,
        status,
        offerTier: offerTier || null,
        offerIncentive: offerIncentive || null,
      };
      localStorage.setItem(DEMO_MANUAL_TABLES_KEY, JSON.stringify(current));
    } catch (err: any) {
      return err.message;
    }
    return null;
  }

  const { error } = await getSupabase()
    .from("dine_in_tables")
    .upsert({
      table_number: tableNumber,
      capacity: 4,
      status,
      customer_name: customerName,
      group_size: groupSize,
      seated_at: status === "occupied" ? new Date().toISOString() : null,
      offer_tier: offerTier || null,
      offer_incentive: offerIncentive || null,
    });

  return error ? error.message : null;
}

export async function releaseDineInTable(tableNumber: number): Promise<string | null> {
  if (isDemoMode) {
    if (typeof localStorage === "undefined") return null;
    try {
      const raw = localStorage.getItem(DEMO_MANUAL_TABLES_KEY);
      const current: Record<number, DbDineInTable> = raw ? JSON.parse(raw) : {};
      delete current[tableNumber];
      localStorage.setItem(DEMO_MANUAL_TABLES_KEY, JSON.stringify(current));

      const orders = loadDemoOrderRecords();
      orders.forEach((o) => {
        if (o.tableNumber === tableNumber && o.status === "placed") {
          o.status = "paid";
          if (!o.paymentMode) {
            o.paymentMode = "Cash";
          }
        }
      });
      saveDemoOrderRecords(orders);
    } catch (err: any) {
      return err.message;
    }
    return null;
  }

  const { error } = await getSupabase()
    .from("dine_in_tables")
    .update({
      status: "vacant",
      customer_name: null,
      group_size: null,
      seated_at: null,
      offer_tier: null,
      offer_incentive: null,
    })
    .eq("table_number", tableNumber);

  if (error) return error.message;

  const { error: orderError } = await getSupabase()
    .from("orders")
    .update({
      status: "paid",
      payment_mode: "Cash",
    })
    .eq("table_number", tableNumber)
    .eq("status", "placed");

  return orderError ? orderError.message : null;
}

export interface DbActiveOrderLine {
  baseId?: string;
  pizzaId?: string;
  toppingIds?: string[];
  baseName?: string;
  pizzaName?: string;
  toppingNames?: string[];
  quantity: number;
}

export interface DbActiveOrder {
  id: string;
  customerName: string;
  phone: string;
  tableNumber: number;
  sessionStartedAt: string;
  lines: DbActiveOrderLine[];
  offerTier: string | null;
  offerIncentive: string | null;
}

export async function getActiveOrderForTable(tableNumber: number): Promise<DbActiveOrder | null> {
  if (isDemoMode) {
    const o = loadDemoOrderRecords().find((x) => x.tableNumber === tableNumber && x.status === "placed");
    if (!o) return null;
    return {
      id: o.id,
      customerName: o.customerName,
      phone: o.phone,
      tableNumber: o.tableNumber,
      sessionStartedAt: o.sessionStartedAt,
      lines: o.lines.map((line: any) => ({
        baseName: line.baseName || line.base_name || "",
        pizzaName: line.pizzaName || line.pizza_name || "",
        toppingNames: line.toppingNames || line.topping_names || [],
        quantity: line.quantity,
      })),
      offerTier: o.offerTier || null,
      offerIncentive: o.offerIncentive || null,
    };
  }

  const { data, error } = await getSupabase()
    .from("orders")
    .select(
      `id, session_started_at, customer_name, phone, table_number, offer_tier, offer_incentive,
       order_items ( id, base_id, pizza_id, quantity,
         order_item_toppings ( topping_id ) )`
    )
    .eq("table_number", tableNumber)
    .eq("status", "placed")
    .maybeSingle();

  if (error || !data) return null;

  return {
    id: data.id,
    customerName: data.customer_name,
    phone: data.phone,
    tableNumber: data.table_number,
    sessionStartedAt: data.session_started_at,
    lines: (data.order_items ?? []).map((item: any) => ({
      baseId: item.base_id || "",
      pizzaId: item.pizza_id || "",
      toppingIds: (item.order_item_toppings ?? [])
        .map((t: any) => t.topping_id)
        .filter(Boolean),
      quantity: item.quantity,
    })),
    offerTier: data.offer_tier || null,
    offerIncentive: data.offer_incentive || null,
  };
}
