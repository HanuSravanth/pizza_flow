// Billing — the same business rules as Stage 2, generalised to a multi-line cart:
//   unit price = base + pizza + toppings
//   subtotal   = sum of (unit price x quantity) across lines
//   discount   = 10% of subtotal when TOTAL pizzas in the order >= 5
//   GST        = 18% of the post-discount amount
// All arithmetic is on integer paise; rounding is half-up, like the Python Decimal version.

import type { Bill, CartLine } from "./types";

export const DISCOUNT_THRESHOLD = 5; // pizzas — change here to move the threshold
export const DISCOUNT_RATE = 0.1; // 10% bulk discount
export const GST_RATE = 0.18; // 18% GST on the post-discount amount

const roundHalfUp = (value: number): number => Math.floor(value + 0.5);

export function unitPricePaise(line: Pick<CartLine, "base" | "pizza" | "toppings">): number {
  return (
    line.base.pricePaise +
    line.pizza.pricePaise +
    line.toppings.reduce((sum, t) => sum + t.pricePaise, 0)
  );
}

export function lineTotalPaise(line: CartLine): number {
  return unitPricePaise(line) * line.quantity;
}

export interface PromoOffer {
  id: string;
  code: string;
  discountType: "percentage" | "flat";
  value: number; // e.g. 20 for 20%, 50 for Rs. 50 flat
  description: string;
  minCartValue: number; // in Rupees
}

const DEFAULT_PROMO_OFFERS: PromoOffer[] = [
  { id: "promo_1", code: "PIZZA20", discountType: "percentage", value: 20, description: "20% off on orders above ₹400", minCartValue: 400 },
  { id: "promo_2", code: "FESTIVE50", discountType: "flat", value: 50, description: "Flat ₹50 off on orders above ₹300", minCartValue: 300 },
  { id: "promo_3", code: "FREEBREAD", discountType: "flat", value: 0, description: "Get a free fresh garlic bread on any order", minCartValue: 0 },
];

export function getWaitlistDiscountPercent(offerTier: string | null, offerIncentive: string | null): number {
  if (!offerTier && !offerIncentive) return 0;

  const incentiveStr = offerIncentive || "";
  const match = incentiveStr.match(/(\d+)\s*%\s*OFF/i);
  if (match) {
    return parseInt(match[1], 10);
  }

  const tierStr = (offerTier || "").toLowerCase();
  if (tierStr.includes("vip") || tierStr.includes("elite")) return 25;
  if (tierStr.includes("gold") || tierStr.includes("premium")) return 15;

  return 0;
}

export function computeBill(
  lines: CartLine[],
  promoCode?: string | null,
  offerTier?: string | null,
  offerIncentive?: string | null
): Bill & {
  appliedPromoName?: string;
  promoDiscountPaise?: number;
  bulkDiscountPaise?: number;
  loyaltyDiscountPaise?: number;
  discountType?: "bulk" | "promo" | "loyalty";
} {
  const subtotalPaise = lines.reduce((sum, line) => sum + lineTotalPaise(line), 0);
  const totalQuantity = lines.reduce((sum, line) => sum + line.quantity, 0);

  const bulkDiscountPaise =
    totalQuantity >= DISCOUNT_THRESHOLD ? roundHalfUp(subtotalPaise * DISCOUNT_RATE) : 0;

  let promoDiscountPaise = 0;
  let appliedPromoName = "";

  if (promoCode) {
    let offers: PromoOffer[] = DEFAULT_PROMO_OFFERS;
    if (typeof localStorage !== "undefined") {
      try {
        const stored = localStorage.getItem("pizzaflow_promo_offers");
        if (stored) offers = JSON.parse(stored);
      } catch {}
    }
    const found = offers.find((o) => o.code.toUpperCase() === promoCode.toUpperCase());
    if (found) {
      const subtotalRupees = subtotalPaise / 100;
      if (subtotalRupees >= found.minCartValue) {
        if (found.discountType === "percentage") {
          promoDiscountPaise = roundHalfUp(subtotalPaise * (found.value / 100));
        } else if (found.discountType === "flat") {
          promoDiscountPaise = Math.min(subtotalPaise, found.value * 100);
        }
        appliedPromoName = found.code;
      }
    }
  }

  let loyaltyDiscountPaise = 0;
  const loyaltyPercent = getWaitlistDiscountPercent(offerTier, offerIncentive);
  if (loyaltyPercent > 0) {
    loyaltyDiscountPaise = roundHalfUp(subtotalPaise * (loyaltyPercent / 100));
  }

  // Choose the best discount for the customer!
  const discountPaise = Math.max(bulkDiscountPaise, promoDiscountPaise, loyaltyDiscountPaise);

  let discountType: "bulk" | "promo" | "loyalty" = "bulk";
  if (discountPaise === loyaltyDiscountPaise && loyaltyDiscountPaise > 0) {
    discountType = "loyalty";
  } else if (discountPaise === promoDiscountPaise && promoDiscountPaise > 0) {
    discountType = "promo";
  }

  const taxablePaise = subtotalPaise - discountPaise;
  const gstPaise = roundHalfUp(taxablePaise * GST_RATE);
  const totalPaise = taxablePaise + gstPaise;

  return {
    subtotalPaise,
    discountPaise,
    taxablePaise,
    gstPaise,
    totalPaise,
    totalQuantity,
    appliedPromoName,
    promoDiscountPaise,
    bulkDiscountPaise,
    loyaltyDiscountPaise,
    discountType,
  };
}

