"use client";

// SliceMatic ordering page — single screen, live bill.
// Everything the Stage 2 CLI enforced is enforced here too; the AI panel is
// an optional shortcut that fills the same validated cart.

import { useEffect, useMemo, useState } from "react";
import { computeBill, unitPricePaise, DISCOUNT_THRESHOLD, DISCOUNT_RATE } from "@/lib/billing";
import { formatPaise } from "@/lib/format";
import {
  createOrder,
  getMenu,
  getOutletSettings,
  isAiEnabled,
  isDemoMode,
  DEFAULT_OUTLET,
  type OutletSettings,
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
  const [aiEnabled, setAiEnabledState] = useState(true);
  // The waiter sets the table and hands the tablet over; a completed order
  // returns here so the next customer starts from a fresh table selection.
  const [tableNumber, setTableNumber] = useState<number | null>(null);
  const [sessionStartedAt, setSessionStartedAt] = useState("");
  const [sessionKey, setSessionKey] = useState(0);

  useEffect(() => {
    getMenu()
      .then(setMenu)
      .catch((error: Error) => setMenuError(error.message));
    getOutletSettings()
      .then(setOutlet)
      .catch(() => {});
    isAiEnabled()
      .then(setAiEnabledState)
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
        onStart={(table) => {
          setTableNumber(table);
          setSessionStartedAt(new Date().toISOString());
        }}
      />
    );
  }

  return (
    <OrderFlow
      key={sessionKey}
      menu={menu}
      outletName={outlet.name}
      aiEnabled={aiEnabled}
      tableNumber={tableNumber}
      sessionStartedAt={sessionStartedAt}
      onNewOrder={() => {
        setTableNumber(null);
        setSessionKey((k) => k + 1);
      }}
    />
  );
}

function TableGate({ outletName, onStart }: { outletName: string; onStart: (table: number) => void }) {
  const [table, setTable] = useState("");
  return (
    <div className="gate">
      <div className="card gate-card">
        <span className="brand-mark" style={{ fontSize: 42 }}>
          🍕
        </span>
        <h1>Welcome to {outletName}</h1>
        <p className="page-sub">Staff: select the table, then hand the tablet to the customer.</p>
        <div className="field" style={{ textAlign: "left" }}>
          <label htmlFor="table">Table number</label>
          <select
            id="table"
            className="select"
            value={table}
            onChange={(e) => setTable(e.target.value)}
          >
            <option value="">Select a table…</option>
            {Array.from({ length: TABLE_COUNT }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                Table {n}
              </option>
            ))}
          </select>
        </div>
        <button
          className="btn"
          style={{ width: "100%" }}
          disabled={!table}
          onClick={() => onStart(parseInt(table, 10))}
        >
          {table ? `Start order for Table ${table}` : "Select a table to begin"}
        </button>
      </div>
    </div>
  );
}

function OrderFlow({
  menu,
  outletName,
  aiEnabled,
  tableNumber,
  sessionStartedAt,
  onNewOrder,
}: {
  menu: Menu;
  outletName: string;
  aiEnabled: boolean;
  tableNumber: number;
  sessionStartedAt: string;
  onNewOrder: () => void;
}) {
  // customer
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [nameError, setNameError] = useState("");
  const [phoneError, setPhoneError] = useState("");
  // builder
  const [baseId, setBaseId] = useState("");
  const [pizzaId, setPizzaId] = useState("");
  const [toppingIds, setToppingIds] = useState<string[]>([]);
  const [builderError, setBuilderError] = useState("");
  // cart + payment
  const [cart, setCart] = useState<CartLine[]>([]);
  const [paymentMode, setPaymentMode] = useState<PaymentMode | null>(null);
  const [placeError, setPlaceError] = useState("");
  const [placing, setPlacing] = useState(false);
  const [receipt, setReceipt] = useState<CompletedOrder | null>(null);

  const bill = useMemo(() => computeBill(cart), [cart]);

  const selectedBase = menu.bases.find((b) => b.id === baseId);
  const selectedPizza = menu.pizzas.find((p) => p.id === pizzaId);
  const selectedToppings = menu.toppings.filter((t) => toppingIds.includes(t.id));

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
    const totalResult = validateTotalQuantity(bill.totalQuantity + 1);
    if (!totalResult.ok) return setBuilderError(totalResult.error);

    const toppings = toppingIds
      .map((id) => menu.toppings.find((t) => t.id === id))
      .filter((t): t is MenuItem => Boolean(t));
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

  async function placeOrder() {
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
      const order = await createOrder({
        customerName: nameResult.value,
        phone: phoneResult.value,
        tableNumber,
        lines: cart,
        paymentMode,
        sessionStartedAt,
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
      {isDemoMode && (
        <div className="banner banner-demo">
          <strong>Demo mode:</strong> Supabase keys are not configured — the menu is bundled and
          orders are stored in this browser only.
        </div>
      )}

      <div className="order-grid">
        <div>
          {aiEnabled && <AiAssistant menu={menu} cart={cart} onApply={applyAssistantDraft} />}

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
            <div className="icard-grid">
              {menu.pizzas.map((item) => (
                <button
                  key={item.id}
                  className={`icard ${pizzaId === item.id ? "selected" : ""}`}
                  onClick={() => setPizzaId(item.id)}
                >
                  <span className="icard-name">{item.name}</span>
                  <span className="icard-price">{formatPaise(item.pricePaise)}</span>
                </button>
              ))}
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
                  {menu.bases.map((item) => (
                    <button
                      key={item.id}
                      className={`icard ${baseId === item.id ? "selected" : ""}`}
                      onClick={() => setBaseId(item.id)}
                    >
                      <span className="icard-name">{item.name}</span>
                      <span className="icard-price">+ {formatPaise(item.pricePaise)}</span>
                    </button>
                  ))}
                </div>

                <p className="step-label">
                  <span className="step-no">2</span> Add toppings <small>optional</small>
                </p>
                <div className="chip-row">
                  {menu.toppings.map((item) => (
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
                    ? `Add to cart — ${formatPaise(previewLinePaise)} (adjust quantity in the cart)`
                    : "Pick a base to continue"}
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="bill-panel">
          <div className="card">
            <h2>Your order</h2>
            {cart.length === 0 && <p className="page-sub">The cart is empty.</p>}
            {cart.map((line, index) => (
              <div className="cart-line" key={index}>
                <div className="names">
                  <strong>{line.pizza.name}</strong>
                  <small>
                    {line.base.name}
                    {line.toppings.length > 0 && ` · ${line.toppings.map((t) => t.name).join(", ")}`}
                  </small>
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
                </div>
                <div>{formatPaise(unitPricePaise(line) * line.quantity)}</div>
              </div>
            ))}

            {cart.length > 0 && (
              <>
                {aiEnabled && (
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
                        Bulk discount ({DISCOUNT_RATE * 100}% for {DISCOUNT_THRESHOLD} or more)
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
                <button className="btn" style={{ width: "100%", marginTop: 8 }} onClick={placeOrder} disabled={placing}>
                  {placing ? "Saving order…" : `Confirm & pay ${formatPaise(bill.totalPaise)}`}
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

      // Re-validate everything the model proposed against the real menu (and cart).
      const lines: CartLine[] = [];
      for (const draft of payload.lines ?? []) {
        const base = menu.bases.find((b) => b.id === draft.baseId);
        const pizza = menu.pizzas.find((p) => p.id === draft.pizzaId);
        const qtyResult = validateQuantity(draft.quantity);
        if (!base || !pizza || !qtyResult.ok) continue; // drop anything invalid
        const toppings = (draft.toppingIds ?? [])
          .map((id: string) => menu.toppings.find((t) => t.id === id))
          .filter((t: MenuItem | undefined): t is MenuItem => Boolean(t));
        lines.push({ base, pizza, toppings, quantity: qtyResult.value });
      }

      const cartUpdates: CartUpdate[] = [];
      for (const update of payload.cartUpdates ?? []) {
        const cartIndex = update?.cartIndex;
        if (typeof cartIndex !== "number" || cartIndex < 0 || cartIndex >= cart.length) continue;
        const addToppingIds = ((update.addToppingIds ?? []) as string[]).filter((id) =>
          menu.toppings.some((t) => t.id === id)
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

  useEffect(() => {
    let cancelled = false;
    setSuggestion(null);
    setDismissed(false);
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
            toppings: menu.toppings,
          }),
        });
        if (!response.ok || cancelled) return;
        const payload = await response.json();
        const topping = menu.toppings.find((t) => t.id === payload.toppingId);
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
        {order.discountPaise > 0 && (
          <p>
            Bulk discount (10%){" "}
            <span style={{ float: "right" }}>-{formatPaise(order.discountPaise)}</span>
          </p>
        )}
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
      <button className="btn" style={{ width: "100%", marginTop: 16 }} onClick={onNew}>
        New order
      </button>
    </div>
  );
}
