// Shared domain types. Money is ALWAYS integer paise in application code
// (₹517.00 = 51700) so no float arithmetic can ever corrupt a bill.
// The database stores rupees as NUMERIC(10,2); conversion happens at the edge.

export type MenuCategory = "base" | "pizza" | "topping";

export interface MenuItem {
  id: string; // uuid in Supabase, code (e.g. "B1") in demo mode
  category: MenuCategory;
  name: string;
  pricePaise: number;
  isVeg: boolean;
  // Meaningful only when category === "pizza": the base/topping ids this
  // pizza may be ordered with. An id NOT in this list is not allowed — there
  // is no "untagged means anything goes" fallback. Empty (never null once
  // loaded) for base/topping rows.
  allowedBaseIds: string[];
  allowedToppingIds: string[];
}

export interface Menu {
  bases: MenuItem[];
  pizzas: MenuItem[];
  toppings: MenuItem[];
}

// One pizza configuration in the cart: base + pizza + 0..n toppings, x quantity.
export interface CartLine {
  base: MenuItem;
  pizza: MenuItem;
  toppings: MenuItem[];
  quantity: number;
}

export type PaymentMode = "Cash" | "Card" | "UPI";
export const PAYMENT_MODES: PaymentMode[] = ["Cash", "Card", "UPI"];

// Dine-in tables at the outlet. The waiter picks one before handing the
// tablet to the customer; the customer cannot change it.
export const TABLE_COUNT = 15;

export interface Bill {
  subtotalPaise: number;
  discountPaise: number; // 0 when total quantity < 5
  taxablePaise: number; // subtotal - discount
  gstPaise: number; // 18% of taxable
  totalPaise: number;
  totalQuantity: number;
}

export interface CompletedOrder {
  id: string;
  createdAt: string; // ISO
  sessionStartedAt: string; // ISO
  customerName: string;
  phone: string;
  tableNumber: number | null; // null on records predating table tracking
  lines: {
    baseName: string;
    pizzaName: string;
    toppingNames: string[];
    quantity: number;
    unitPricePaise: number;
    lineTotalPaise: number;
  }[];
  subtotalPaise: number;
  discountPaise: number;
  gstPaise: number;
  totalPaise: number;
  paymentMode: PaymentMode;
  offerTier?: string | null;
  offerIncentive?: string | null;
  appliedPromoCode?: string | null;
}
