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
export const TABLE_COUNT = 12;

export interface Bill {
  subtotalPaise: number;
  discountPaise: number; // bulkDiscountPaise + promoDiscountPaise
  bulkDiscountPaise: number; // 0 when total quantity < 5
  promoDiscountPaise: number; // 0 unless a promo code is applied
  promoCode: string | null;
  taxablePaise: number; // subtotal - discount
  gstPaise: number; // 18% of taxable
  totalPaise: number;
  totalQuantity: number;
}

// A still-open (unpaid) order, for the admin live-tables view — same line
// shape as CompletedOrder but no paymentMode yet.
export interface OpenOrder {
  id: string;
  customerName: string;
  phone: string;
  lines: {
    baseName: string;
    pizzaName: string;
    toppingNames: string[];
    quantity: number;
    unitPricePaise: number;
    lineTotalPaise: number;
  }[];
  totalPaise: number;
}

// One row of the admin live-tables grid.
export interface LiveTable {
  tableNumber: number;
  occupied: boolean;
  seatedAt: string | null; // ISO; null when not occupied
  order: OpenOrder | null; // the table's running placed order, if any
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
  promoDiscountPaise: number; // portion of discountPaise attributable to a promo code (0 if none)
  promoCode: string | null;
  gstPaise: number;
  totalPaise: number;
  paymentMode: PaymentMode;
}
