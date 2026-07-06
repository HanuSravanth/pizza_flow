"use client";

// SliceMatic ordering page — single screen, live bill.
// Everything the Stage 2 CLI enforced is enforced here too; the AI panel is
// an optional shortcut that fills the same validated cart.

import { useEffect, useMemo, useState } from "react";
import { computeBill, unitPricePaise, DISCOUNT_THRESHOLD, DISCOUNT_RATE, getWaitlistDiscountPercent, type PromoOffer } from "@/lib/billing";
import { formatPaise } from "@/lib/format";
import {
  confirmOrder,
  finishAndPayOrder,
  getMenu,
  getOutletSettings,
  getEffectiveAiFeatures,
  getBestSellerPizzaIds,
  submitOrderFeedback,
  isDemoMode,
  DEFAULT_OUTLET,
  getDbDineInTables,
  releaseDineInTable,
  getActiveOrderForTable,
  type OutletSettings,
  type DbDineInTable,
} from "@/lib/data";
import {
  validateName,
  validatePhone,
  validateQuantity,
  validateTotalQuantity,
} from "@/lib/validation";
import type { CartLine, CompletedOrder, Menu, MenuItem, PaymentMode } from "@/lib/types";
import { PAYMENT_MODES, TABLE_COUNT } from "@/lib/types";

export default function OrderPage() {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [menuError, setMenuError] = useState("");
  const [outlet, setOutlet] = useState<OutletSettings>(DEFAULT_OUTLET);
  const [assistantEnabled, setAssistantEnabled] = useState(true);
  const [upsellEnabled, setUpsellEnabled] = useState(true);
  const [bestSellerIds, setBestSellerIds] = useState<string[]>([]);
  // The waiter sets the table and hands the tablet over; a completed order
  // returns here so the next customer starts from a fresh table selection.
  const [tableNumber, setTableNumber] = useState<number | null>(null);
  const [sessionStartedAt, setSessionStartedAt] = useState("");
  const [sessionKey, setSessionKey] = useState(0);

  const [seatedCustomerName, setSeatedCustomerName] = useState("");
  const [offerTier, setOfferTier] = useState<string | null>(null);
  const [offerIncentive, setOfferIncentive] = useState<string | null>(null);

  useEffect(() => {
    getMenu()
      .then(setMenu)
      .catch((error: Error) => setMenuError(error.message));
    getOutletSettings()
      .then(setOutlet)
      .catch(() => {});
    getEffectiveAiFeatures()
      .then((features) => {
        setAssistantEnabled(features.assistant);
        setUpsellEnabled(features.upsell);
      })
      .catch(() => {});
    getBestSellerPizzaIds()
      .then(setBestSellerIds)
      .catch(() => {});
  }, []);

  if (menuError) {
    return (
      <div className="banner banner-error">
        <strong>The menu could not be loaded.</strong> {menuError}
        <br />
        Orders cannot be taken until this is fixed — please alert the staff.
      </div>
    );
  }
  if (!menu) return <p className="page-sub">Loading the menu…</p>;

  if (tableNumber === null) {
    return (
      <TableGate
        outletName={outlet.name}
        tableCount={outlet.tableCount || TABLE_COUNT}
        onStart={(table, name, tier, incentive) => {
          setTableNumber(table);
          setSessionStartedAt(new Date().toISOString());
          setSeatedCustomerName(name || "");
          setOfferTier(tier || null);
          setOfferIncentive(incentive || null);
        }}
      />
    );
  }

  return (
    <OrderFlow
      key={sessionKey}
      menu={menu}
      outletName={outlet.name}
      assistantEnabled={assistantEnabled}
      upsellEnabled={upsellEnabled}
      bestSellerIds={bestSellerIds}
      tableNumber={tableNumber}
      sessionStartedAt={sessionStartedAt}
      seatedCustomerName={seatedCustomerName}
      offerTier={offerTier}
      offerIncentive={offerIncentive}
      onNewOrder={() => {
        setTableNumber(null);
        setSessionKey((k) => k + 1);
        setSeatedCustomerName("");
        setOfferTier(null);
        setOfferIncentive(null);
      }}
    />
  );
}

function TableGate({
  outletName,
  tableCount,
  onStart,
}: {
  outletName: string;
  tableCount: number;
  onStart: (table: number, name?: string | null, tier?: string | null, incentive?: string | null) => void;
}) {
  const [table, setTable] = useState("");
  const [dineInTables, setDineInTables] = useState<Record<number, DbDineInTable>>({});
  const [isConfirmedOccupant, setIsConfirmedOccupant] = useState(false);

  useEffect(() => {
    getDbDineInTables()
      .then(setDineInTables)
      .catch(() => {});
  }, []);

  useEffect(() => {
    setIsConfirmedOccupant(false);
  }, [table]);

  const handleStart = async () => {
    const tableNum = parseInt(table, 10);
    if (isNaN(tableNum)) return;
    const info = dineInTables[tableNum];
    onStart(
      tableNum,
      info?.customerName || null,
      info?.offerTier || null,
      info?.offerIncentive || null
    );
  };

  const tableNum = parseInt(table, 10);
  const info = !isNaN(tableNum) ? dineInTables[tableNum] : null;
  const isButtonDisabled = !table || (info && !isConfirmedOccupant);

  return (
    <div className="gate">
      <div className="card gate-card" style={{ maxWidth: 440, width: "100%" }}>
        <span className="brand-mark" style={{ fontSize: 42 }}>
          🍕
        </span>
        <h1>Welcome to {outletName}</h1>
        <p className="page-sub">Select your table to view the menu and start ordering.</p>
        <div className="field" style={{ textAlign: "left" }}>
          <label htmlFor="table">Table number</label>
          <select
            id="table"
            className="select"
            value={table}
            onChange={(e) => setTable(e.target.value)}
          >
            <option value="">Select a table…</option>
            {Array.from({ length: tableCount }, (_, i) => i + 1).map((n) => {
              const info = dineInTables[n];
              let label = `Table ${n}`;
              if (info) {
                const statusLabel = info.status === "reserved" ? "Reserved" : "Seated";
                label += ` (${statusLabel}: ${info.customerName})`;
              }
              return (
                <option key={n} value={n}>
                  {label}
                </option>
              );
            })}
          </select>
        </div>

        {info && (
          <div style={{
            marginTop: "16px",
            padding: "16px",
            borderRadius: "12px",
            border: "1px solid #ea580c",
            background: "rgba(234, 88, 12, 0.05)",
            textAlign: "left",
            display: "flex",
            flexDirection: "column",
            gap: "12px"
          }}>
            <h3 style={{
              fontSize: "0.95rem",
              fontWeight: "700",
              color: "#ea580c",
              display: "flex",
              alignItems: "center",
              gap: "8px",
              margin: 0
            }}>
              ⚠️ Table {table} is Occupied
            </h3>
            <p style={{ fontSize: "0.85rem", margin: 0, lineHeight: "1.4", color: "var(--text-color)" }}>
              This table currently has an active session under the name <strong>&ldquo;{info.customerName}&rdquo;</strong>.
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "4px" }}>
              <label style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "10px",
                cursor: "pointer",
                fontSize: "0.85rem",
                userSelect: "none"
              }}>
                <input
                  type="checkbox"
                  checked={isConfirmedOccupant}
                  onChange={(e) => {
                    setIsConfirmedOccupant(e.target.checked);
                  }}
                  style={{ marginTop: "3px" }}
                />
                <div>
                  <strong style={{ display: "block" }}>I am part of this group</strong>
                  <span style={{ color: "var(--muted)", fontSize: "0.75rem" }}>
                    Join this active session to add items to the shared bill.
                  </span>
                </div>
              </label>
            </div>
          </div>
        )}

        <button
          className="btn"
          style={{ width: "100%", marginTop: "16px" }}
          disabled={isButtonDisabled}
          onClick={handleStart}
        >
          {table
            ? info
              ? isConfirmedOccupant
                ? `Join Table ${table} Session`
                : `Please confirm selection for Table ${table}`
              : `Start order for Table ${table}`
            : "Select a table to begin"}
        </button>
      </div>
    </div>
  );
}

function OrderFlow({
  menu,
  outletName,
  assistantEnabled,
  upsellEnabled,
  bestSellerIds,
  tableNumber,
  sessionStartedAt,
  seatedCustomerName,
  offerTier,
  offerIncentive,
  onNewOrder,
}: {
  menu: Menu;
  outletName: string;
  assistantEnabled: boolean;
  upsellEnabled: boolean;
  bestSellerIds: string[];
  tableNumber: number;
  sessionStartedAt: string;
  seatedCustomerName: string;
  offerTier: string | null;
  offerIncentive: string | null;
  onNewOrder: () => void;
}) {
  // customer
  const [name, setName] = useState(seatedCustomerName || "");
  const [phone, setPhone] = useState("");
  const [nameError, setNameError] = useState("");
  const [phoneError, setPhoneError] = useState("");
  // builder
  const [baseId, setBaseId] = useState("");
  const [pizzaId, setPizzaId] = useState("");
  const [toppingIds, setToppingIds] = useState<string[]>([]);
  const [builderError, setBuilderError] = useState("");
  const [vegFilter, setVegFilter] = useState<"all" | "veg" | "nonveg">("all");
  const visiblePizzas = menu.pizzas.filter(
    (item) => vegFilter === "all" || (vegFilter === "veg" ? item.isVeg : !item.isVeg)
  );
  // cart + payment
  const [cart, setCart] = useState<CartLine[]>([]);
  const [paymentMode, setPaymentMode] = useState<PaymentMode | null>(null);
  const [placeError, setPlaceError] = useState("");
  const [placing, setPlacing] = useState(false);
  const [receipt, setReceipt] = useState<CompletedOrder | null>(null);
  // confirm-and-order: cart lines below confirmedCount are already saved to
  // the database (and, in a real kitchen, already being made) — frozen from
  // further edits. Lines from confirmedCount onward are still local-only.
  const [orderId, setOrderId] = useState<string | null>(null);
  const [confirmedCount, setConfirmedCount] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState("");

  const [appliedPromo, setAppliedPromo] = useState<PromoOffer | null>(null);
  const [promoOffers, setPromoOffers] = useState<PromoOffer[]>([]);
  const [promoCodeInput, setPromoCodeInput] = useState("");
  const [promoError, setPromoError] = useState("");
  const [promoSuccess, setPromoSuccess] = useState("");

  useEffect(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("pizzaflow_promo_offers");
      if (stored) {
        try {
          setPromoOffers(JSON.parse(stored));
        } catch {}
      }
    }
  }, []);

  // Load active order on mount (to support multi-device/joining active session)
  useEffect(() => {
    getActiveOrderForTable(tableNumber)
      .then((activeOrder) => {
        if (activeOrder) {
          setOrderId(activeOrder.id);
          if (activeOrder.customerName) setName(activeOrder.customerName);
          if (activeOrder.phone) setPhone(activeOrder.phone);
          
          // Reconstruct the cart
          const reconstructed: CartLine[] = [];
          for (const line of activeOrder.lines) {
            let base = menu.bases.find((b) => b.id === line.baseId);
            if (!base && line.baseName) {
              base = menu.bases.find((b) => b.name === line.baseName);
            }
            let pizza = menu.pizzas.find((p) => p.id === line.pizzaId);
            if (!pizza && line.pizzaName) {
              pizza = menu.pizzas.find((p) => p.name === line.pizzaName);
            }
            if (base && pizza) {
              const toppings: MenuItem[] = [];
              if (line.toppingIds && line.toppingIds.length) {
                for (const tid of line.toppingIds) {
                  const t = menu.toppings.find((x) => x.id === tid);
                  if (t) toppings.push(t);
                }
              } else if (line.toppingNames && line.toppingNames.length) {
                for (const tname of line.toppingNames) {
                  const t = menu.toppings.find((x) => x.name === tname);
                  if (t) toppings.push(t);
                }
              }
              reconstructed.push({
                base,
                pizza,
                toppings,
                quantity: line.quantity,
              });
            }
          }
          if (reconstructed.length > 0) {
            setCart(reconstructed);
            setConfirmedCount(reconstructed.length);
          }
        }
      })
      .catch(() => {});
  }, [tableNumber, menu]);

  const bill = useMemo(() => computeBill(cart, appliedPromo?.code || null, offerTier, offerIncentive), [cart, appliedPromo, offerTier, offerIncentive]);
  const pendingLines = cart.slice(confirmedCount);

  const selectedBase = menu.bases.find((b) => b.id === baseId);
  const selectedPizza = menu.pizzas.find((p) => p.id === pizzaId);
  const selectedToppings = menu.toppings.filter((t) => toppingIds.includes(t.id));
  // A pizza's allowed lists are authoritative: an id NOT in the list is not
  // orderable with it. Only active items reach `menu`, so filtering against
  // it also drops any allowed base/topping the admin has since deactivated.
  const allowedBases = selectedPizza
    ? menu.bases.filter((b) => selectedPizza.allowedBaseIds.includes(b.id))
    : [];
  const allowedToppings = selectedPizza
    ? menu.toppings.filter((t) => selectedPizza.allowedToppingIds.includes(t.id))
    : [];

  function selectPizza(pizza: MenuItem) {
    setPizzaId(pizza.id);
    // Drop any base/topping selection that doesn't carry over to the new pizza.
    setBaseId((prev) => (pizza.allowedBaseIds.includes(prev) ? prev : ""));
    setToppingIds((prev) => prev.filter((id) => pizza.allowedToppingIds.includes(id)));
  }

  // Live price preview for the "Add to cart" button. Quantity always starts
  // at 1 here — the cart's − n + steppers own quantity from then on.
  const previewLinePaise =
    selectedBase && selectedPizza
      ? selectedBase.pricePaise +
        selectedPizza.pricePaise +
        selectedToppings.reduce((s, t) => s + t.pricePaise, 0)
      : 0;

  function addToCart() {
    setBuilderError("");
    const base = menu.bases.find((b) => b.id === baseId);
    const pizza = menu.pizzas.find((p) => p.id === pizzaId);
    if (!base) return setBuilderError("Please choose a base.");
    if (!pizza) return setBuilderError("Please choose a pizza.");
    if (!pizza.allowedBaseIds.includes(base.id)) {
      return setBuilderError(`${base.name} is not available for ${pizza.name}.`);
    }
    const totalResult = validateTotalQuantity(bill.totalQuantity + 1);
    if (!totalResult.ok) return setBuilderError(totalResult.error);

    const toppings = toppingIds
      .map((id) => menu.toppings.find((t) => t.id === id))
      .filter((t): t is MenuItem => t !== undefined && pizza.allowedToppingIds.includes(t.id));
    setCart((prev) => [...prev, { base, pizza, toppings, quantity: 1 }]);
    // Reset the builder so the next pizza starts fresh.
    setPizzaId("");
    setBaseId("");
    setToppingIds([]);
  }

  function applyAssistantDraft(lines: CartLine[], cartUpdates: CartUpdate[]) {
    const extra = lines.reduce((s, l) => s + l.quantity, 0);
    if (extra > 0) {
      const totalResult = validateTotalQuantity(bill.totalQuantity + extra);
      if (!totalResult.ok) {
        setBuilderError(totalResult.error);
        return false;
      }
    }
    setCart((prev) => {
      const next = [...prev];
      for (const update of cartUpdates) {
        const line = next[update.cartIndex];
        if (!line) continue;
        let toppings = line.toppings;
        if (update.addToppingIds.length) {
          const existingIds = new Set(toppings.map((t) => t.id));
          const toAdd = update.addToppingIds
            .map((id) => menu.toppings.find((t) => t.id === id))
            .filter((t): t is MenuItem => t !== undefined && !existingIds.has(t.id));
          toppings = [...toppings, ...toAdd];
        }
        if (update.removeToppingIds.length) {
          const removeSet = new Set(update.removeToppingIds);
          toppings = toppings.filter((t) => !removeSet.has(t.id));
        }
        next[update.cartIndex] = { ...line, toppings };
      }
      return [...next, ...lines];
    });
    return true;
  }

  function changeQty(index: number, delta: number) {
    const line = cart[index];
    if (!line) return;
    const nextQty = line.quantity + delta;
    if (nextQty < 1) return;
    if (delta > 0) {
      const totalResult = validateTotalQuantity(bill.totalQuantity + delta);
      if (!totalResult.ok) {
        setPlaceError(totalResult.error);
        return;
      }
    }
    setPlaceError("");
    setCart((prev) => prev.map((l, i) => (i === index ? { ...l, quantity: nextQty } : l)));
  }

  async function confirmOrderClick() {
    setConfirmError("");
    const nameResult = validateName(name);
    setNameError(nameResult.ok ? "" : nameResult.error);
    const phoneResult = validatePhone(phone);
    setPhoneError(phoneResult.ok ? "" : phoneResult.error);
    if (!nameResult.ok || !phoneResult.ok) {
      setConfirmError(
        "We need a valid name and phone number before confirming — please complete the Customer details section."
      );
      return;
    }
    if (pendingLines.length === 0) return;

    setConfirming(true);
    try {
      const id = await confirmOrder({
        orderId,
        customerName: nameResult.value,
        phone: phoneResult.value,
        tableNumber,
        sessionStartedAt,
        cart,
        newLines: pendingLines,
        offerTier,
        offerIncentive,
        appliedPromoCode: appliedPromo?.code || null,
      });
      setOrderId(id);
      setConfirmedCount(cart.length);
    } catch (error) {
      setConfirmError(error instanceof Error ? error.message : "The order could not be confirmed — please retry.");
    } finally {
      setConfirming(false);
    }
  }

  async function finishAndPay() {
    setPlaceError("");
    const nameResult = validateName(name);
    setNameError(nameResult.ok ? "" : nameResult.error);
    const phoneResult = validatePhone(phone);
    setPhoneError(phoneResult.ok ? "" : phoneResult.error);
    if (!nameResult.ok || !phoneResult.ok) {
      setPlaceError(
        "We need a valid name and phone number before payment — please complete the Customer details section."
      );
      return;
    }
    if (!cart.length) return setPlaceError("The cart is empty — add at least one pizza.");
    const totalResult = validateTotalQuantity(bill.totalQuantity);
    if (!totalResult.ok) return setPlaceError(totalResult.error);
    if (!paymentMode) return setPlaceError("Please choose a payment mode: Cash, Card or UPI.");

    setPlacing(true);
    try {
      const order = await finishAndPayOrder({
        orderId,
        customerName: nameResult.value,
        phone: phoneResult.value,
        tableNumber,
        sessionStartedAt,
        cart,
        newLines: cart.slice(confirmedCount),
        paymentMode,
        offerTier,
        offerIncentive,
        appliedPromoCode: appliedPromo?.code || null,
      });
      setReceipt(order);
    } catch (error) {
      setPlaceError(error instanceof Error ? error.message : "The order could not be saved — please retry.");
    } finally {
      setPlacing(false);
    }
  }

  if (receipt) return <Receipt order={receipt} outletName={outletName} onNew={onNewOrder} />;

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1>Place an order</h1>
        <span className="table-badge">Table {tableNumber}</span>
      </div>
      <p className="page-sub">
        Pick from the menu or just tell the assistant what you feel like eating.
      </p>

      {offerTier && offerIncentive && (
        <div className="banner banner-ok" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", margin: "16px 0", padding: "12px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontSize: "1.4rem" }}>🎁</span>
            <div>
              <strong style={{ display: "block" }}>Waitlist Loyalty Reward Activated!</strong>
              <span style={{ fontSize: "0.85rem", opacity: 0.9 }}>
                You have been seated with the <strong>{offerTier} Tier</strong> waitlist offer: <em>{offerIncentive}</em>. Your reward is tracked and will be applied to this session!
              </span>
            </div>
          </div>
          <span className="badge" style={{ background: "rgba(22, 163, 74, 0.15)", color: "#16a34a", padding: "4px 8px", borderRadius: "4px", fontSize: "0.75rem", fontWeight: "700", textTransform: "uppercase", whiteSpace: "nowrap" }}>
            Active Offer
          </span>
        </div>
      )}

      {isDemoMode && (
        <div className="banner banner-demo">
          <strong>Demo mode:</strong> Supabase keys are not configured — the menu is bundled and
          orders are stored in this browser only.
        </div>
      )}

      <div className="order-grid">
        <div>
          {assistantEnabled && <AiAssistant menu={menu} cart={cart} onApply={applyAssistantDraft} />}

          <div className="card" style={{ marginTop: 16 }}>
            <h2>Customer details</h2>
            <div className="field">
              <label htmlFor="name">Name</label>
              <input
                id="name"
                type="text"
                placeholder="e.g. Ananya Iyer"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => {
                  const r = validateName(name);
                  setNameError(name && !r.ok ? r.error : "");
                }}
              />
              {nameError && <p className="error-text">{nameError}</p>}
            </div>
            <div className="field">
              <label htmlFor="phone">Phone (10-digit mobile)</label>
              <input
                id="phone"
                type="tel"
                placeholder="e.g. 9876543210"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                onBlur={() => {
                  const r = validatePhone(phone);
                  setPhoneError(phone && !r.ok ? r.error : "");
                }}
              />
              {phoneError && <p className="error-text">{phoneError}</p>}
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h2>Choose your pizza</h2>
            <div className="veg-filter">
              {(["all", "veg", "nonveg"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`veg-filter-btn ${vegFilter === f ? "selected" : ""}`}
                  onClick={() => {
                    setVegFilter(f);
                    const stillVisible =
                      f === "all" || !selectedPizza || (f === "veg" ? selectedPizza.isVeg : !selectedPizza.isVeg);
                    if (!stillVisible) {
                      setPizzaId("");
                      setBaseId("");
                      setToppingIds([]);
                    }
                  }}
                >
                  {f !== "all" && <span className={`veg-dot ${f === "nonveg" ? "nonveg" : ""}`} />}
                  {f === "all" ? "All" : f === "veg" ? "Veg" : "Non-veg"}
                </button>
              ))}
            </div>
            <div className="icard-grid">
              {visiblePizzas.map((item) => {
                // A pizza with no currently-active allowed base can never be
                // completed — grey it out rather than let it dead-end the flow.
                const orderable = menu.bases.some((b) => item.allowedBaseIds.includes(b.id));
                return (
                  <button
                    key={item.id}
                    className={`icard ${pizzaId === item.id ? "selected" : ""}`}
                    onClick={() => orderable && selectPizza(item)}
                    disabled={!orderable}
                    style={!orderable ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
                  >
                    <span className="veg-tag icard-veg-tag">
                      <span className={`veg-dot ${item.isVeg ? "" : "nonveg"}`} aria-hidden="true" />
                    </span>
                    {bestSellerIds.includes(item.id) && (
                      <span className="best-seller-tag">★ Best seller</span>
                    )}
                    <span className="icard-name">{item.name}</span>
                    <span className="icard-price">
                      {orderable ? formatPaise(item.pricePaise) : "Currently unavailable"}
                    </span>
                  </button>
                );
              })}
              {visiblePizzas.length === 0 && (
                <p className="page-sub" style={{ gridColumn: "1 / -1" }}>
                  No pizzas match this filter.
                </p>
              )}
            </div>

            {selectedPizza && (
              <div className="customize">
                <h3>
                  Customise your <em>{selectedPizza.name}</em>
                </h3>

                <p className="step-label">
                  <span className="step-no">1</span> Pick a base <small>required</small>
                </p>
                <div className="icard-grid compact">
                  {allowedBases.map((item) => (
                    <button
                      key={item.id}
                      className={`icard ${baseId === item.id ? "selected" : ""}`}
                      onClick={() => setBaseId(item.id)}
                    >
                      <span className="icard-name">{item.name}</span>
                      <span className="icard-price">+ {formatPaise(item.pricePaise)}</span>
                    </button>
                  ))}
                  {allowedBases.length === 0 && (
                    <p className="page-sub" style={{ gridColumn: "1 / -1" }}>
                      No base is currently available for this pizza.
                    </p>
                  )}
                </div>

                <p className="step-label">
                  <span className="step-no">2</span> Add toppings <small>optional</small>
                </p>
                <div className="chip-row">
                  {allowedToppings.map((item) => (
                    <button
                      key={item.id}
                      className={`chip ${toppingIds.includes(item.id) ? "selected" : ""}`}
                      onClick={() =>
                        setToppingIds((prev) =>
                          prev.includes(item.id)
                            ? prev.filter((t) => t !== item.id)
                            : [...prev, item.id]
                        )
                      }
                    >
                      {toppingIds.includes(item.id) ? "✓ " : "+ "}
                      {item.name} · {formatPaise(item.pricePaise)}
                    </button>
                  ))}
                </div>

                {builderError && <p className="error-text">{builderError}</p>}
                <button
                  className="btn"
                  style={{ marginTop: 12, width: "100%" }}
                  onClick={addToCart}
                  disabled={!selectedBase}
                >
                  {selectedBase
                    ? `Add to cart — ${formatPaise(previewLinePaise)}`
                    : "Pick a base to continue"}
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="bill-panel">
          {/* Promo code card */}
          <div className="card" style={{ marginBottom: "16px" }}>
            <h2 style={{ display: "flex", alignItems: "center", gap: "8px", margin: 0, fontSize: "1.1rem" }}>
              🏷️ Promotional Offers
            </h2>
            <p className="page-sub" style={{ margin: "4px 0 12px 0", fontSize: "0.85rem" }}>
              Select or enter a coupon code to apply discounts to your order.
            </p>
            
            {/* Promo Code Input Box */}
            <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
              <input
                type="text"
                placeholder="PROMO CODE"
                className="input"
                style={{ flex: 1, textTransform: "uppercase", fontSize: "0.85rem" }}
                value={promoCodeInput}
                onChange={(e) => {
                  setPromoCodeInput(e.target.value.toUpperCase());
                  setPromoError("");
                  setPromoSuccess("");
                }}
              />
              <button
                className="btn btn-secondary"
                style={{ padding: "6px 12px", fontSize: "0.85rem" }}
                onClick={() => {
                  const code = promoCodeInput.trim().toUpperCase();
                  if (!code) return;
                  const found = promoOffers.find((o) => o.code === code);
                  if (found) {
                    setAppliedPromo(found);
                    setPromoSuccess(`Coupon "${code}" applied!`);
                    setPromoError("");
                  } else {
                    setPromoError(`Invalid code: "${code}"`);
                    setPromoSuccess("");
                  }
                }}
              >
                Apply
              </button>
            </div>

            {promoError && <p style={{ color: "#dc2626", fontSize: "0.8rem", margin: "4px 0" }}>⚠️ {promoError}</p>}
            {promoSuccess && <p style={{ color: "#16a34a", fontSize: "0.8rem", margin: "4px 0" }}>✓ {promoSuccess}</p>}

            {appliedPromo && (
              <div style={{
                background: "rgba(22, 163, 74, 0.08)",
                border: "1px solid #16a34a",
                borderRadius: "8px",
                padding: "8px 12px",
                marginBottom: "12px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center"
              }}>
                <div>
                  <strong style={{ color: "#16a34a", fontSize: "0.85rem" }}>Active Coupon: {appliedPromo.code}</strong>
                  <p style={{ margin: 0, fontSize: "0.75rem", opacity: 0.9 }}>{appliedPromo.description}</p>
                </div>
                <button
                  onClick={() => {
                    setAppliedPromo(null);
                    setPromoCodeInput("");
                    setPromoSuccess("");
                  }}
                  style={{ color: "#dc2626", background: "none", border: "none", cursor: "pointer", fontSize: "0.8rem", fontWeight: "600" }}
                >
                  Clear
                </button>
              </div>
            )}

            {/* List of active available coupons */}
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <span style={{ fontSize: "0.7rem", fontWeight: "bold", textTransform: "uppercase", color: "var(--text-muted)" }}>
                Available Coupons
              </span>
              {promoOffers.length === 0 ? (
                <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", margin: 0 }}>No active promotional offers right now.</p>
              ) : (
                promoOffers.map((offer) => {
                  const isApplied = appliedPromo?.id === offer.id;
                  const isEligible = (bill.subtotalPaise / 100) >= offer.minCartValue;
                  return (
                    <div
                      key={offer.id}
                      onClick={() => {
                        setAppliedPromo(offer);
                        setPromoCodeInput(offer.code);
                        setPromoSuccess(`Coupon "${offer.code}" applied!`);
                        setPromoError("");
                      }}
                      style={{
                        padding: "8px 10px",
                        borderRadius: "8px",
                        border: isApplied
                          ? "1px solid #16a34a"
                          : "1px solid var(--border-color)",
                        background: isApplied
                          ? "rgba(22, 163, 74, 0.03)"
                          : "rgba(0, 0, 0, 0.02)",
                        cursor: "pointer",
                        transition: "all 0.2s ease-in-out",
                        display: "flex",
                        flexDirection: "column",
                        gap: "2px"
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{
                          fontWeight: "bold",
                          fontSize: "0.8rem",
                          color: isApplied ? "#16a34a" : "var(--accent)"
                        }}>
                          {offer.code}
                        </span>
                        {isApplied && (
                          <span style={{ fontSize: "0.75rem", color: "#16a34a", fontWeight: "bold" }}>Applied</span>
                        )}
                        {!isApplied && !isEligible && (
                          <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>Min ₹{offer.minCartValue}</span>
                        )}
                      </div>
                      <p style={{ margin: 0, fontSize: "0.75rem", color: "var(--text-color)", opacity: 0.85 }}>
                        {offer.description}
                      </p>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="card">
            <h2>Your order</h2>
            {cart.length === 0 ? (
              <p className="page-sub">The cart is empty.</p>
            ) : (
              <p className="page-sub" style={{ marginBottom: 12 }}>
                Add pizzas, confirm and order whenever you like, then finish and pay when you're done.
              </p>
            )}
            {cart.map((line, index) => {
              const confirmed = index < confirmedCount;
              return (
                <div className="cart-line" key={index}>
                  <div className="names">
                    <strong>{line.pizza.name}</strong>
                    <small>
                      {line.base.name}
                      {line.toppings.length > 0 && ` · ${line.toppings.map((t) => t.name).join(", ")}`}
                    </small>
                    {confirmed ? (
                      <span className="line-confirmed-tag">✓ Confirmed · Qty {line.quantity}</span>
                    ) : (
                      <div className="qty-stepper">
                        <button
                          aria-label={`One less ${line.pizza.name}`}
                          disabled={line.quantity <= 1}
                          onClick={() => changeQty(index, -1)}
                        >
                          −
                        </button>
                        <span>{line.quantity}</span>
                        <button
                          aria-label={`One more ${line.pizza.name}`}
                          onClick={() => changeQty(index, 1)}
                        >
                          +
                        </button>
                        <button
                          className="cart-remove"
                          onClick={() => setCart((prev) => prev.filter((_, i) => i !== index))}
                        >
                          remove
                        </button>
                      </div>
                    )}
                  </div>
                  <div>{formatPaise(unitPricePaise(line) * line.quantity)}</div>
                </div>
              );
            })}

            {cart.length > 0 && (
              <>
                {upsellEnabled && (
                  <UpsellSuggestion
                    menu={menu}
                    cart={cart}
                    onAccept={(topping) =>
                      setCart((prev) => {
                        const next = [...prev];
                        const last = next[next.length - 1];
                        if (last.toppings.some((t) => t.id === topping.id)) return prev;
                        next[next.length - 1] = { ...last, toppings: [...last.toppings, topping] };
                        return next;
                      })
                    }
                  />
                )}
                <div className="bill-rows" style={{ marginTop: 12 }}>
                  <div className="bill-row">
                    <span>Subtotal ({bill.totalQuantity} pizzas)</span>
                    <span>{formatPaise(bill.subtotalPaise)}</span>
                  </div>
                  {bill.discountPaise > 0 ? (
                    <div className="bill-row discount">
                      <span>
                        {bill.discountType === "loyalty"
                          ? `Loyalty Offer: ${offerTier} (${getWaitlistDiscountPercent(offerTier, offerIncentive)}% OFF)`
                          : bill.discountType === "promo"
                          ? `Coupon Discount (${bill.appliedPromoName})`
                          : `Bulk discount (${DISCOUNT_RATE * 100}% for ${DISCOUNT_THRESHOLD} or more)`}
                      </span>
                      <span>-{formatPaise(bill.discountPaise)}</span>
                    </div>
                  ) : (
                    <div className="bill-row muted">
                      <span>
                        Add {DISCOUNT_THRESHOLD - bill.totalQuantity} more pizza
                        {DISCOUNT_THRESHOLD - bill.totalQuantity === 1 ? "" : "s"} for 10% off
                      </span>
                      <span />
                    </div>
                  )}
                  <div className="bill-row">
                    <span>GST (18%)</span>
                    <span>{formatPaise(bill.gstPaise)}</span>
                  </div>
                  <div className="bill-row total">
                    <span>Total payable</span>
                    <span>{formatPaise(bill.totalPaise)}</span>
                  </div>
                </div>

                {confirmError && <p className="error-text">{confirmError}</p>}
                <button
                  className="btn btn-secondary"
                  style={{ width: "100%", marginTop: 12 }}
                  onClick={confirmOrderClick}
                  disabled={confirming || pendingLines.length === 0}
                >
                  {confirming
                    ? "Confirming…"
                    : pendingLines.length > 0
                      ? `Confirm and order (${pendingLines.length} new item${pendingLines.length > 1 ? "s" : ""})`
                      : "All items confirmed"}
                </button>

                <h3 style={{ marginTop: 14 }}>Payment</h3>
                <div className="pay-modes">
                  {PAYMENT_MODES.map((mode) => (
                    <button
                      key={mode}
                      className={`pay-mode ${paymentMode === mode ? "selected" : ""}`}
                      onClick={() => setPaymentMode(mode)}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
                {placeError && <p className="error-text">{placeError}</p>}
                <button className="btn" style={{ width: "100%", marginTop: 8 }} onClick={finishAndPay} disabled={placing}>
                  {placing ? "Saving order…" : `Finish & pay ${formatPaise(bill.totalPaise)}`}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

interface CartUpdate {
  cartIndex: number;
  addToppingIds: string[];
  removeToppingIds: string[];
}

function AiAssistant({
  menu,
  cart,
  onApply,
}: {
  menu: Menu;
  cart: CartLine[];
  onApply: (lines: CartLine[], cartUpdates: CartUpdate[]) => boolean;
}) {
  const [message, setMessage] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function ask() {
    const text = message.trim();
    if (!text || busy) return;
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/ai/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          menu,
          cart: cart.map((l) => ({
            baseId: l.base.id,
            pizzaId: l.pizza.id,
            toppingIds: l.toppings.map((t) => t.id),
            quantity: l.quantity,
          })),
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setNote(payload.error ?? "The assistant is unavailable — please use the menu below.");
        return;
      }

      // Re-validate everything the model proposed against the real menu (and cart),
      // including that the pizza's own allowed-base/topping lists are respected —
      // an id not in that list is dropped just like an unknown id would be.
      const lines: CartLine[] = [];
      for (const draft of payload.lines ?? []) {
        const base = menu.bases.find((b) => b.id === draft.baseId);
        const pizza = menu.pizzas.find((p) => p.id === draft.pizzaId);
        const qtyResult = validateQuantity(draft.quantity);
        if (!base || !pizza || !qtyResult.ok) continue; // drop anything invalid
        if (!pizza.allowedBaseIds.includes(base.id)) continue; // drop disallowed base/pizza combo
        const toppings = (draft.toppingIds ?? [])
          .map((id: string) => menu.toppings.find((t) => t.id === id))
          .filter((t: MenuItem | undefined): t is MenuItem => t !== undefined && pizza.allowedToppingIds.includes(t.id));
        lines.push({ base, pizza, toppings, quantity: qtyResult.value });
      }

      const cartUpdates: CartUpdate[] = [];
      for (const update of payload.cartUpdates ?? []) {
        const cartIndex = update?.cartIndex;
        if (typeof cartIndex !== "number" || cartIndex < 0 || cartIndex >= cart.length) continue;
        const targetPizza = cart[cartIndex].pizza;
        const addToppingIds = ((update.addToppingIds ?? []) as string[]).filter(
          (id) => menu.toppings.some((t) => t.id === id) && targetPizza.allowedToppingIds.includes(id)
        );
        const removeToppingIds = ((update.removeToppingIds ?? []) as string[]).filter((id) =>
          menu.toppings.some((t) => t.id === id)
        );
        if (addToppingIds.length || removeToppingIds.length) {
          cartUpdates.push({ cartIndex, addToppingIds, removeToppingIds });
        }
      }

      if (lines.length === 0 && cartUpdates.length === 0) {
        setNote(payload.note || "I couldn't match that to the menu — please try the menu below.");
      } else if (onApply(lines, cartUpdates)) {
        const parts: string[] = [];
        if (lines.length) parts.push(`added ${lines.length} item${lines.length > 1 ? "s" : ""}`);
        if (cartUpdates.length)
          parts.push(`updated ${cartUpdates.length} item${cartUpdates.length > 1 ? "s" : ""} already in your cart`);
        setNote(
          (payload.note ? payload.note + " " : "") +
            (parts.length ? `${parts.join(" and ")} — review it on the right.` : "")
        );
        setMessage("");
      }
    } catch {
      setNote("The assistant is unavailable right now — please order using the menu below.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card ai-panel">
      <h3>
        Tell us what you feel like <span className="ai-sparkle" aria-hidden="true">✦</span>
      </h3>
      <div className="ai-input-row">
        <input
          type="text"
          placeholder='e.g. "two spicy paneer pizzas on thin crust and one BBQ chicken"'
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask()}
          disabled={busy}
        />
        <button className="btn btn-small" onClick={ask} disabled={busy || !message.trim()}>
          {busy ? <span className="spinner">…</span> : "Draft my order"}
        </button>
      </div>
      {note && <p className="ai-note">{note}</p>}
    </div>
  );
}

function UpsellSuggestion({
  menu,
  cart,
  onAccept,
}: {
  menu: Menu;
  cart: CartLine[];
  onAccept: (topping: MenuItem) => void;
}) {
  const [suggestion, setSuggestion] = useState<{ topping: MenuItem; reason: string } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const cartKey = cart.map((l) => `${l.pizza.id}:${l.quantity}`).join("|");
  // The suggestion is applied to the last cart line, so it can only ever
  // offer toppings that pizza actually allows and doesn't already have.
  const lastLine = cart[cart.length - 1];
  const candidateToppings = lastLine
    ? menu.toppings.filter(
        (t) => lastLine.pizza.allowedToppingIds.includes(t.id) && !lastLine.toppings.some((existing) => existing.id === t.id)
      )
    : [];

  useEffect(() => {
    let cancelled = false;
    setSuggestion(null);
    setDismissed(false);
    if (!lastLine || candidateToppings.length === 0) return;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch("/api/ai/upsell", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cart: cart.map((l) => ({
              pizzaName: l.pizza.name,
              baseName: l.base.name,
              toppingNames: l.toppings.map((t) => t.name),
              quantity: l.quantity,
            })),
            toppings: candidateToppings,
          }),
        });
        if (!response.ok || cancelled) return;
        const payload = await response.json();
        // Re-check against the same candidate list sent, not the full menu.
        const topping = candidateToppings.find((t) => t.id === payload.toppingId);
        if (topping && payload.reason && !cancelled) {
          setSuggestion({ topping, reason: payload.reason });
        }
      } catch {
        /* no suggestion — never an error state for the customer */
      }
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartKey]);

  if (!suggestion || dismissed) return null;
  return (
    <div className="card ai-panel upsell-card">
      <div>
        <span className="ai-sparkle" aria-hidden="true">✦</span>{" "}
        <strong>
          Add {suggestion.topping.name} for {formatPaise(suggestion.topping.pricePaise)}?
        </strong>
        <br />
        <small>{suggestion.reason}</small>
      </div>
      <div style={{ display: "flex", gap: 6, flexDirection: "column" }}>
        <button
          className="btn btn-small"
          onClick={() => {
            onAccept(suggestion.topping);
            setDismissed(true);
          }}
        >
          Add it
        </button>
        <button className="btn btn-small btn-secondary" onClick={() => setDismissed(true)}>
          No thanks
        </button>
      </div>
    </div>
  );
}

function Receipt({
  order,
  outletName,
  onNew,
}: {
  order: CompletedOrder;
  outletName: string;
  onNew: () => void;
}) {
  return (
    <div style={{ maxWidth: 520, margin: "0 auto" }}>
      <div className="banner banner-ok">
        <strong>Payment confirmed via {order.paymentMode}.</strong> Thank you, {order.customerName}!
        Your order is with the kitchen.
      </div>
      <div className="card receipt">
        <h2 style={{ textAlign: "center" }}>{outletName.toUpperCase()} — TAX INVOICE</h2>
        <p style={{ textAlign: "center", color: "var(--muted)" }}>
          {new Date(order.createdAt).toLocaleString("en-IN")}
        </p>
        <hr />
        <p>
          Customer: {order.customerName}
          <br />
          Phone: {order.phone}
          {order.tableNumber != null && (
            <>
              <br />
              Table: {order.tableNumber}
            </>
          )}
        </p>
        <hr />
        {order.lines.map((line, index) => (
          <p key={index}>
            {line.quantity}× {line.pizzaName} ({line.baseName}
            {line.toppingNames.length > 0 && `, ${line.toppingNames.join(", ")}`})
            <span style={{ float: "right" }}>{formatPaise(line.lineTotalPaise)}</span>
          </p>
        ))}
        <hr />
        <p>
          Subtotal <span style={{ float: "right" }}>{formatPaise(order.subtotalPaise)}</span>
        </p>
        {order.discountPaise > 0 && (() => {
          const totalQuantity = order.lines.reduce((sum, l) => sum + l.quantity, 0);
          const bulkDiscount = totalQuantity >= DISCOUNT_THRESHOLD ? Math.round(order.subtotalPaise * DISCOUNT_RATE) : 0;
          const loyaltyPercent = getWaitlistDiscountPercent(order.offerTier || null, order.offerIncentive || null);
          const loyaltyDiscount = loyaltyPercent > 0 ? Math.round(order.subtotalPaise * (loyaltyPercent / 100)) : 0;
          
          let label = "Discount";
          if (order.discountPaise === loyaltyDiscount && loyaltyDiscount > 0) {
            label = `Loyalty Offer: ${order.offerTier} (${loyaltyPercent}% OFF)`;
          } else if (order.discountPaise === bulkDiscount && bulkDiscount > 0) {
            label = `Bulk discount (${DISCOUNT_RATE * 100}% for ${DISCOUNT_THRESHOLD} or more)`;
          } else if (order.appliedPromoCode) {
            label = `Promo Discount (${order.appliedPromoCode})`;
          } else {
            if (loyaltyDiscount > 0) {
              label = `Loyalty Offer: ${order.offerTier} (${loyaltyPercent}% OFF)`;
            } else if (order.appliedPromoCode) {
              label = `Promo Discount (${order.appliedPromoCode})`;
            } else {
              label = `Bulk discount (${DISCOUNT_RATE * 100}%)`;
            }
          }
          return (
            <p>
              {label}{" "}
              <span style={{ float: "right" }}>-{formatPaise(order.discountPaise)}</span>
            </p>
          );
        })()}
        <p>
          GST (18%) <span style={{ float: "right" }}>{formatPaise(order.gstPaise)}</span>
        </p>
        <hr />
        <p style={{ fontWeight: 800, fontSize: 16 }}>
          TOTAL PAID <span style={{ float: "right" }}>{formatPaise(order.totalPaise)}</span>
        </p>
        <hr />
        <p style={{ textAlign: "center" }}>Order ID: {order.id.slice(0, 8).toUpperCase()}</p>
      </div>

      <OrderFeedbackForm order={order} />

      <button className="btn" style={{ width: "100%", marginTop: 16 }} onClick={onNew}>
        New order
      </button>
    </div>
  );
}

const QUICK_FEEDBACK_TAGS = [
  "😋 Delicious",
  "🔥 Fresh & hot",
  "⚡ Quick service",
  "🙂 Friendly staff",
  "💰 Good value",
  "😕 Needs improvement",
];

function StarRating({
  value,
  onChange,
  label,
  size = 22,
}: {
  value: number;
  onChange: (n: number) => void;
  label: string;
  size?: number;
}) {
  return (
    <div className="star-rating" role="radiogroup" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className="star-btn"
          aria-label={`${n} star${n > 1 ? "s" : ""} for ${label}`}
          aria-pressed={n <= value}
          onClick={() => onChange(n === value ? 0 : n)}
          style={{ fontSize: size }}
        >
          <span className={n <= value ? "star-filled" : "star-empty"}>{n <= value ? "★" : "☆"}</span>
        </button>
      ))}
    </div>
  );
}

function OrderFeedbackForm({ order }: { order: CompletedOrder }) {
  const pizzaNames = useMemo(() => Array.from(new Set(order.lines.map((l) => l.pizzaName))), [order.lines]);
  const [pizzaRatings, setPizzaRatings] = useState<Record<string, number>>({});
  const [overallRating, setOverallRating] = useState(0);
  const [quickTags, setQuickTags] = useState<string[]>([]);
  const [comments, setComments] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "done" | "error">("idle");
  const [error, setError] = useState("");

  function toggleTag(tag: string) {
    setQuickTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  }

  async function submit() {
    setStatus("saving");
    setError("");
    const message = await submitOrderFeedback({
      orderId: order.id,
      overallRating: overallRating || null,
      pizzaRatings,
      quickTags,
      comments,
    });
    if (message) {
      setError(message);
      setStatus("error");
      return;
    }
    setStatus("done");
  }

  if (status === "done") {
    return (
      <div className="card" style={{ marginTop: 16, textAlign: "center" }}>
        <strong>Thanks for the feedback, {order.customerName}!</strong>
        <p className="page-sub" style={{ marginBottom: 0 }}>
          It helps the kitchen get a little better every day.
        </p>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2>Rate your order</h2>

      {pizzaNames.map((name) => (
        <div className="feedback-row" key={name}>
          <span>{name}</span>
          <StarRating
            label={name}
            value={pizzaRatings[name] ?? 0}
            onChange={(n) => setPizzaRatings((prev) => ({ ...prev, [name]: n }))}
          />
        </div>
      ))}

      <div className="feedback-row feedback-row-overall">
        <strong>Overall experience</strong>
        <StarRating label="overall experience" value={overallRating} onChange={setOverallRating} size={26} />
      </div>

      <p className="step-label" style={{ marginTop: 16 }}>
        Quick feedback <small>tap any that apply</small>
      </p>
      <div className="chip-row">
        {QUICK_FEEDBACK_TAGS.map((tag) => (
          <button
            key={tag}
            type="button"
            className={`chip ${quickTags.includes(tag) ? "selected" : ""}`}
            onClick={() => toggleTag(tag)}
          >
            {tag}
          </button>
        ))}
      </div>

      <div className="field" style={{ marginTop: 14 }}>
        <label htmlFor="feedback-comments">Anything else you&apos;d like to tell us? (optional)</label>
        <textarea
          id="feedback-comments"
          rows={3}
          placeholder="Tell us more…"
          value={comments}
          onChange={(e) => setComments(e.target.value)}
        />
      </div>

      {error && <p className="error-text">{error}</p>}
      <button className="btn" style={{ width: "100%", marginTop: 8 }} onClick={submit} disabled={status === "saving"}>
        {status === "saving" ? "Sending…" : "Send feedback"}
      </button>
    </div>
  );
}
