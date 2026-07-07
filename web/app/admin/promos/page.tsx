"use client";

// Festival Promo Planner. Division of labour, same as every AI feature here:
//   rules  — the occasion calendar (lib/occasions.ts), the sales facts
//            (computePromoFacts), and the discount/code/schedule the owner
//            picks are all deterministic inputs;
//   the AI — only writes the banner headline/message from those inputs, and
//            the route re-validates every featured item against the menu and
//            forces the code itself to appear verbatim.
// A code goes live purely by its start/end date-time — no publish step, no
// WhatsApp, nothing sent anywhere. It just appears on the ordering page (and
// in "see available codes" at checkout) for its scheduled window, and stops
// automatically once that window ends. Redemptions are tracked on the order
// itself, so the table below shows exactly how much revenue and discount each
// code produced — real numbers, not estimates.

import { useEffect, useMemo, useState } from "react";
import {
  computePizzaRatingSummary,
  computePromoCodeStats,
  computePromoFacts,
  type PromoCodeStats,
  type PromoFacts,
} from "@/lib/analytics";
import { PROMO_PERCENT_MAX, PROMO_PERCENT_MIN, type PromoDiscountType } from "@/lib/billing";
import {
  createPromoCode,
  deactivatePromoCode,
  getAllMenuItems,
  getEffectiveAiFeatures,
  getOrderFeedback,
  getOrders,
  getPromoCodes,
  isDemoMode,
  type AdminMenuItem,
  type PromoCode,
} from "@/lib/data";
import { upcomingOccasions, type UpcomingOccasion } from "@/lib/occasions";
import { formatDateTime, formatPaise } from "@/lib/format";

const CUSTOM_OCCASION = "__custom__";

interface DraftPromo {
  headline: string;
  message: string;
  featuredItems: string[];
  whyThisWorks: string;
}

export default function PromosPage() {
  const [orders, setOrders] = useState<Awaited<ReturnType<typeof getOrders>> | null>(null);
  const [menuItems, setMenuItems] = useState<AdminMenuItem[]>([]);
  const [ratingsSummary, setRatingsSummary] = useState<ReturnType<typeof computePizzaRatingSummary> | null>(null);
  const [featureOn, setFeatureOn] = useState(true);
  const [codes, setCodes] = useState<PromoCode[]>([]);
  const [loadError, setLoadError] = useState("");

  function reloadCodes() {
    getPromoCodes()
      .then(setCodes)
      .catch(() => {});
  }

  useEffect(() => {
    getOrders()
      .then(setOrders)
      .catch((error: Error) => setLoadError(error.message));
    getAllMenuItems()
      .then(setMenuItems)
      .catch(() => {});
    getOrderFeedback()
      .then((feedback) => setRatingsSummary(computePizzaRatingSummary(feedback)))
      .catch(() => {});
    getEffectiveAiFeatures()
      .then((features) => setFeatureOn(features.promo))
      .catch(() => {});
    reloadCodes();
  }, []);

  const activePizzas = useMemo(
    () => menuItems.filter((i) => i.category === "pizza" && i.isActive),
    [menuItems]
  );
  const facts: PromoFacts | null = useMemo(() => {
    if (!orders) return null;
    return computePromoFacts({ orders, menuPizzas: activePizzas, ratings: ratingsSummary });
  }, [orders, activePizzas, ratingsSummary]);
  const stats: PromoCodeStats[] = useMemo(
    () => (orders ? computePromoCodeStats(orders, codes) : []),
    [orders, codes]
  );

  if (loadError) return <div className="banner banner-error">Could not load orders: {loadError}</div>;

  return (
    <>
      <h1>Promos</h1>
      <p className="page-sub">
        Create a discount code around an upcoming occasion — it appears on the ordering page and
        goes live automatically for the window you set, and stops just as automatically once it ends.
      </p>
      {isDemoMode && (
        <div className="banner banner-demo">
          <strong>Demo mode:</strong> facts and codes come from this browser&apos;s storage only.
        </div>
      )}

      <FactsCard facts={facts} />

      {featureOn ? (
        facts && (
          <Composer
            facts={facts}
            pizzas={activePizzas}
            onCreated={reloadCodes}
          />
        )
      ) : (
        <div className="banner banner-demo" style={{ marginTop: 16 }}>
          The promo planner is turned off in Admin → Settings → AI. The sales facts above still
          update live; turn the feature on to write a new banner.
        </div>
      )}

      <PromoCodesTable stats={stats} onChanged={reloadCodes} />
    </>
  );
}

// -------------------------------------------------------------- sales facts

function FactsCard({ facts }: { facts: PromoFacts | null }) {
  if (!facts) return <p className="page-sub">Loading sales facts…</p>;
  const best = facts.bestSellers[0];
  const slow = facts.slowMovers[0];
  return (
    <div className="card">
      <h2>Last {facts.windowDays} days at a glance</h2>
      <p className="page-sub">
        Straight from your paid orders below — real numbers, not AI guesses. Use them to decide
        what to promote and what discount to offer.
      </p>
      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">Orders</div>
          <div className="stat-value">{facts.orderCount}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Best seller</div>
          <div className="stat-value">{best ? best.name : "—"}</div>
          <div className="stat-sub">{best ? `${best.units} sold` : "no sales in this window"}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Needs a push</div>
          <div className="stat-value">{slow ? slow.name : "—"}</div>
          <div className="stat-sub">{slow ? `${slow.units} sold` : ""}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Veg share</div>
          <div className="stat-value">{facts.vegUnitShare != null ? `${facts.vegUnitShare}%` : "—"}</div>
          <div className="stat-sub">of pizzas sold</div>
        </div>
      </div>
      <p className="page-sub" style={{ marginTop: 10, marginBottom: 0 }}>
        {facts.quietestDay && facts.busiestDay
          ? `Quietest day: ${facts.quietestDay.day} (${facts.quietestDay.orders} orders) · busiest: ${facts.busiestDay.day} (${facts.busiestDay.orders}).`
          : "Not enough orders yet to see day-of-week patterns."}{" "}
        {facts.topRatedPizza &&
          `Top rated: ${facts.topRatedPizza.name} (★ ${facts.topRatedPizza.avgRating} from ${facts.topRatedPizza.ratingCount} ratings).`}{" "}
        {facts.repeatCustomerCount > 0 && `${facts.repeatCustomerCount} repeat customers on file.`}
      </p>
    </div>
  );
}

// ----------------------------------------------------------------- composer

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `<input type="datetime-local">` wants "yyyy-mm-ddThh:mm" in local time. */
function toLocalInputValue(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function suggestCode(name: string): string {
  const base = name.replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase() || "PROMO";
  const suffix = Math.floor(10 + Math.random() * 90);
  return `${base}${suffix}`.slice(0, 12);
}

function Composer({
  facts,
  pizzas,
  onCreated,
}: {
  facts: PromoFacts;
  pizzas: AdminMenuItem[];
  onCreated: () => void;
}) {
  const occasions = useMemo(() => upcomingOccasions(), []);
  const [occasionId, setOccasionId] = useState<string>(occasions[0]?.id ?? CUSTOM_OCCASION);
  const [customOccasion, setCustomOccasion] = useState("");
  const [discountType, setDiscountType] = useState<PromoDiscountType>("percent");
  const [percentValue, setPercentValue] = useState(10);
  const [featuredItemId, setFeaturedItemId] = useState(pizzas[0]?.id ?? "");
  const [code, setCode] = useState("");
  const [startsAt, setStartsAt] = useState(() => toLocalInputValue(new Date()));
  const [endsAt, setEndsAt] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return toLocalInputValue(d);
  });
  const [draft, setDraft] = useState<DraftPromo | null>(null);
  const [busy, setBusy] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const selected: UpcomingOccasion | null = occasions.find((o) => o.id === occasionId) ?? null;
  const occasionName = occasionId === CUSTOM_OCCASION ? customOccasion.trim() : (selected?.name ?? "");
  const occasionText =
    occasionId === CUSTOM_OCCASION
      ? customOccasion.trim()
      : selected
        ? `${selected.name} (${selected.dateLabel}${selected.approxDate ? ", date approximate — owner will confirm" : ""}) — ${
            selected.ongoing ? "happening now" : `starts in ${selected.startsInDays} day(s)`
          }. ${selected.angle}${selected.vegLean ? " Vegetarian-leaning occasion: feature only veg items." : ""}`
        : "";
  const featuredItem = pizzas.find((p) => p.id === featuredItemId);

  // Suggest a code whenever the occasion changes, without clobbering one the
  // admin already typed.
  useEffect(() => {
    if (occasionName) setCode((prev) => prev || suggestCode(occasionName));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [occasionId]);

  async function generate() {
    if (!occasionText) return setError("Pick or describe an occasion first.");
    const trimmedCode = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{3,12}$/.test(trimmedCode)) {
      return setError("The code must be 3-12 letters/numbers.");
    }
    if (discountType === "topping" && !featuredItem) {
      return setError("Pick which pizza the free topping applies to.");
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/ai/promo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          occasion: occasionText,
          code: trimmedCode,
          discount:
            discountType === "percent"
              ? { type: "percent", value: percentValue }
              : { type: "topping", featuredItemName: featuredItem?.name },
          menu: pizzas.map((p) => ({ name: p.name, priceRupees: p.pricePaise / 100, isVeg: p.isVeg })),
          facts,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not write the banner.");
      setDraft(payload.promo);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not write the banner — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!draft) return;
    const trimmedCode = code.trim().toUpperCase();
    setPublishing(true);
    setError("");
    setNotice("");
    const message = await createPromoCode({
      code: trimmedCode,
      headline: draft.headline || occasionName || "This week at SliceMatic",
      message: draft.message,
      discountType,
      discountValue: discountType === "percent" ? percentValue : 0,
      featuredItemId: discountType === "topping" ? featuredItemId : null,
      startsAt,
      endsAt,
    });
    setPublishing(false);
    if (message) {
      setError(message);
      return;
    }
    setNotice(`Live — customers can enter ${trimmedCode} at checkout for this window.`);
    setDraft(null);
    setCode("");
    onCreated();
  }

  const canGenerate =
    Boolean(occasionText) &&
    /^[A-Z0-9]{3,12}$/.test(code.trim().toUpperCase()) &&
    (discountType !== "topping" || Boolean(featuredItem));

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2>Create a promo code</h2>

      <p className="page-sub" style={{ fontWeight: 600, marginBottom: 6 }}>
        1. Pick the occasion
      </p>
      <div className="chip-row">
        {occasions.map((o) => (
          <button
            key={o.id}
            className={`chip ${occasionId === o.id ? "selected" : ""}`}
            onClick={() => setOccasionId(o.id)}
            title={o.angle}
          >
            {o.name} · {o.ongoing ? "now" : `in ${o.startsInDays}d`}
            {o.approxDate ? " ~" : ""}
          </button>
        ))}
        <button
          className={`chip ${occasionId === CUSTOM_OCCASION ? "selected" : ""}`}
          onClick={() => setOccasionId(CUSTOM_OCCASION)}
        >
          Custom…
        </button>
      </div>
      {occasionId === CUSTOM_OCCASION ? (
        <input
          type="text"
          style={{ marginTop: 10, maxWidth: 480 }}
          placeholder="e.g. Local cricket final this Sunday evening"
          value={customOccasion}
          maxLength={200}
          onChange={(e) => setCustomOccasion(e.target.value)}
        />
      ) : (
        selected && (
          <p className="page-sub" style={{ marginTop: 8 }}>
            {selected.dateLabel}
            {selected.approxDate && " (approximate — confirm the exact date)"} · {selected.angle}
            {selected.vegLean && " · Veg-leaning: only veg items will be featured."}
          </p>
        )
      )}

      <p className="page-sub" style={{ fontWeight: 600, margin: "16px 0 6px" }}>
        2. Set the discount
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <select
          className="select"
          style={{ maxWidth: 260, width: "auto", flex: "1 1 220px" }}
          value={discountType}
          onChange={(e) => setDiscountType(e.target.value as PromoDiscountType)}
        >
          <option value="percent">Percent off the whole order</option>
          <option value="topping">Free topping of choice on one pizza</option>
        </select>
        {discountType === "percent" ? (
          <>
            <input
              type="number"
              style={{ maxWidth: 80 }}
              min={PROMO_PERCENT_MIN}
              max={PROMO_PERCENT_MAX}
              value={percentValue}
              onChange={(e) =>
                setPercentValue(Math.min(PROMO_PERCENT_MAX, Math.max(PROMO_PERCENT_MIN, Number(e.target.value) || 0)))
              }
            />
            <span className="page-sub" style={{ margin: 0, whiteSpace: "nowrap" }}>
              % off ({PROMO_PERCENT_MIN}-{PROMO_PERCENT_MAX})
            </span>
          </>
        ) : (
          <select
            className="select"
            style={{ maxWidth: 260, width: "auto", flex: "1 1 220px" }}
            value={featuredItemId}
            onChange={(e) => setFeaturedItemId(e.target.value)}
          >
            <option value="">Choose a pizza…</option>
            {pizzas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <p className="page-sub" style={{ marginTop: 8, fontSize: 12.5 }}>
        This is the only discount the banner will describe — the checkout applies it automatically
        whenever the code below is entered and its window is open.
      </p>

      <p className="page-sub" style={{ fontWeight: 600, margin: "16px 0 6px" }}>
        3. Code and schedule
      </p>
      <div className="promo-schedule">
        <div className="field">
          <label htmlFor="promo-code-input">Promo code</label>
          <input
            id="promo-code-input"
            type="text"
            style={{ textTransform: "uppercase" }}
            value={code}
            maxLength={12}
            placeholder="e.g. HOLI10"
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12))}
          />
        </div>
        <div className="field">
          <label htmlFor="promo-starts">Starts</label>
          <input
            id="promo-starts"
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="promo-ends">Ends</label>
          <input
            id="promo-ends"
            type="datetime-local"
            value={endsAt}
            min={startsAt}
            onChange={(e) => setEndsAt(e.target.value)}
          />
        </div>
      </div>

      <button className="btn" style={{ marginTop: 16 }} onClick={generate} disabled={busy || !canGenerate}>
        {busy ? "Writing…" : draft ? "Write it again" : "Write the banner"}{" "}
        <span className="ai-sparkle" aria-hidden="true">✦</span>
      </button>

      {error && <p className="error-text" style={{ marginTop: 10 }}>{error}</p>}

      {draft && (
        <div style={{ marginTop: 18 }}>
          <p className="page-sub" style={{ fontWeight: 600, marginBottom: 6 }}>
            4. Review and publish
          </p>
          <div className="promo-preview">
            {draft.headline && <strong>🎉 {draft.headline}</strong>}
            <div className="promo-text">{draft.message}</div>
          </div>
          {draft.whyThisWorks && (
            <p className="page-sub" style={{ marginTop: 8, maxWidth: 520 }}>
              <strong>Why this works:</strong> {draft.whyThisWorks}
              {draft.featuredItems.length > 0 && <> · Featured: {draft.featuredItems.join(", ")}</>}
            </p>
          )}
          {notice && <p className="banner banner-ok" style={{ marginTop: 10 }}>{notice}</p>}
          <button className="btn btn-small btn-secondary" style={{ marginTop: 10 }} onClick={publish} disabled={publishing}>
            {publishing ? "Publishing…" : "Publish this code"}
          </button>
        </div>
      )}
      {!draft && notice && <p className="banner banner-ok" style={{ marginTop: 14 }}>{notice}</p>}
    </div>
  );
}

// ------------------------------------------------------- codes & history

function PromoCodesTable({ stats, onChanged }: { stats: PromoCodeStats[]; onChanged: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function deactivate(id: string) {
    setBusyId(id);
    setError("");
    const message = await deactivatePromoCode(id);
    setBusyId(null);
    if (message) {
      setError(message);
      return;
    }
    onChanged();
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2>Promo codes</h2>
      <p className="page-sub">
        Every code you&apos;ve created — live, scheduled or ended — with the revenue it brought in
        and the discount it actually gave, computed from paid orders that redeemed it.
      </p>
      {error && <p className="error-text">{error}</p>}
      <div className="table-scroll">
        <table className="orders-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Headline</th>
              <th>Window</th>
              <th>Status</th>
              <th>Redemptions</th>
              <th>Revenue</th>
              <th>Discount given</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {stats.length === 0 && (
              <tr>
                <td colSpan={8} style={{ color: "var(--muted)" }}>
                  No promo codes yet — create one above.
                </td>
              </tr>
            )}
            {stats.map((s) => (
              <tr key={s.id}>
                <td>
                  <code>{s.code}</code>
                </td>
                <td>{s.headline}</td>
                <td>
                  {formatDateTime(s.startsAt)} – {formatDateTime(s.endsAt)}
                </td>
                <td>
                  <span className={`promo-status promo-status-${s.status}`}>{s.status}</span>
                </td>
                <td>{s.redemptions}</td>
                <td>{formatPaise(s.revenuePaise)}</td>
                <td>{formatPaise(s.discountPaise)}</td>
                <td>
                  {s.status !== "expired" && (
                    <button
                      className="btn btn-small btn-secondary"
                      onClick={() => deactivate(s.id)}
                      disabled={busyId === s.id}
                    >
                      {busyId === s.id ? "…" : s.status === "scheduled" ? "Cancel" : "End now"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
