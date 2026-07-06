"use client";

import { useEffect, useState } from "react";

interface WaitlistOffer {
  id: string;
  tier: string;
  minMinutes: number;
  incentive: string;
  colorClass: string;
}

interface PromoOffer {
  id: string;
  code: string;
  discountType: "percentage" | "flat";
  value: number; // e.g. 20 for 20%, 50 for Rs. 50 flat
  description: string;
  minCartValue: number; // in Rupees
}

const DEFAULT_WAITLIST_OFFERS: WaitlistOffer[] = [
  { id: "bronze", tier: "Bronze", minMinutes: 0, incentive: "Complimentary Soft Drink on Seating 🥤", colorClass: "badge-bronze" },
  { id: "silver", tier: "Silver", minMinutes: 10, incentive: "Free Fresh Garlic Bread 🫓", colorClass: "badge-silver" },
  { id: "silver-plus", tier: "Silver Plus", minMinutes: 20, incentive: "Free Fresh Garlic Bread & Cheese Dip 🫓", colorClass: "badge-silver-plus" },
  { id: "gold", tier: "Gold Premium", minMinutes: 30, incentive: "15% OFF Bill + Free Welcome Drink 🥤", colorClass: "badge-gold" },
  { id: "vip", tier: "VIP Elite", minMinutes: 45, incentive: "25% OFF Bill + Free Toppings & Starter 👑", colorClass: "badge-vip" },
];

const DEFAULT_PROMO_OFFERS: PromoOffer[] = [
  { id: "promo_1", code: "PIZZA20", discountType: "percentage", value: 20, description: "20% off on orders above ₹400", minCartValue: 400 },
  { id: "promo_2", code: "FESTIVE50", discountType: "flat", value: 50, description: "Flat ₹50 off on orders above ₹300", minCartValue: 300 },
  { id: "promo_3", code: "FREEBREAD", discountType: "flat", value: 0, description: "Get a free fresh garlic bread on any order", minCartValue: 0 },
];

const BADGE_CLASSES = [
  { label: "Bronze (Warm Orange)", value: "badge-bronze" },
  { label: "Silver (Slate Gray)", value: "badge-silver" },
  { label: "Silver Plus (Steel Blue)", value: "badge-silver-plus" },
  { label: "Gold Premium (Rich Amber)", value: "badge-gold" },
  { label: "VIP Elite (Royal Gold & Gold Amber)", value: "badge-vip" },
];

export default function OffersSettingsPage() {
  const [waitlistOffers, setWaitlistOffers] = useState<WaitlistOffer[]>([]);
  const [promoOffers, setPromoOffers] = useState<PromoOffer[]>([]);

  // Selected tab: "waitlist" | "promo"
  const [activeTab, setActiveTab] = useState<"waitlist" | "promo">("waitlist");

  // Notifications
  const [notification, setNotification] = useState<{ message: string; type: "success" | "error" } | null>(null);

  // Form states for Waitlist Tiers
  const [editingWaitlistId, setEditingWaitlistId] = useState<string | null>(null);
  const [waitlistForm, setWaitlistForm] = useState<Omit<WaitlistOffer, "id">>({
    tier: "",
    minMinutes: 0,
    incentive: "",
    colorClass: "badge-bronze",
  });
  const [isAddingWaitlist, setIsAddingWaitlist] = useState(false);

  // Form states for Promo Offers
  const [editingPromoId, setEditingPromoId] = useState<string | null>(null);
  const [promoForm, setPromoForm] = useState<Omit<PromoOffer, "id">>({
    code: "",
    discountType: "percentage",
    value: 0,
    description: "",
    minCartValue: 0,
  });
  const [isAddingPromo, setIsAddingPromo] = useState(false);

  // Initialize and load from local storage
  useEffect(() => {
    if (typeof window !== "undefined") {
      const storedWaitlist = localStorage.getItem("pizzaflow_waitlist_offers");
      if (storedWaitlist) {
        try {
          setWaitlistOffers(JSON.parse(storedWaitlist));
        } catch {
          setWaitlistOffers(DEFAULT_WAITLIST_OFFERS);
        }
      } else {
        setWaitlistOffers(DEFAULT_WAITLIST_OFFERS);
        localStorage.setItem("pizzaflow_waitlist_offers", JSON.stringify(DEFAULT_WAITLIST_OFFERS));
      }

      const storedPromo = localStorage.getItem("pizzaflow_promo_offers");
      if (storedPromo) {
        try {
          setPromoOffers(JSON.parse(storedPromo));
        } catch {
          setPromoOffers(DEFAULT_PROMO_OFFERS);
        }
      } else {
        setPromoOffers(DEFAULT_PROMO_OFFERS);
        localStorage.setItem("pizzaflow_promo_offers", JSON.stringify(DEFAULT_PROMO_OFFERS));
      }
    }
  }, []);

  const triggerNotification = (message: string, type: "success" | "error" = "success") => {
    setNotification({ message, type });
    setTimeout(() => {
      setNotification(null);
    }, 4000);
  };

  // ----- WAITLIST OFFERS ACTIONS -----
  const saveWaitlistOffers = (newOffers: WaitlistOffer[]) => {
    const sorted = [...newOffers].sort((a, b) => a.minMinutes - b.minMinutes);
    setWaitlistOffers(sorted);
    localStorage.setItem("pizzaflow_waitlist_offers", JSON.stringify(sorted));
    triggerNotification("Waitlist tiers updated successfully!");
  };

  const handleEditWaitlist = (offer: WaitlistOffer) => {
    setEditingWaitlistId(offer.id);
    setIsAddingWaitlist(false);
    setWaitlistForm({
      tier: offer.tier,
      minMinutes: offer.minMinutes,
      incentive: offer.incentive,
      colorClass: offer.colorClass,
    });
  };

  const handleDeleteWaitlist = (id: string) => {
    if (window.confirm("Are you sure you want to delete this waitlist offer tier?")) {
      const filtered = waitlistOffers.filter((o) => o.id !== id);
      saveWaitlistOffers(filtered);
    }
  };

  const handleSaveWaitlistForm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!waitlistForm.tier.trim() || !waitlistForm.incentive.trim()) {
      triggerNotification("Please fill in all fields.", "error");
      return;
    }

    if (editingWaitlistId) {
      const updated = waitlistOffers.map((o) =>
        o.id === editingWaitlistId ? { ...o, ...waitlistForm } : o
      );
      saveWaitlistOffers(updated);
      setEditingWaitlistId(null);
    } else {
      const newOffer: WaitlistOffer = {
        id: "wait_tier_" + Math.random().toString(36).slice(2, 9),
        ...waitlistForm,
      };
      saveWaitlistOffers([...waitlistOffers, newOffer]);
      setIsAddingWaitlist(false);
    }

    // Reset form
    setWaitlistForm({
      tier: "",
      minMinutes: 0,
      incentive: "",
      colorClass: "badge-bronze",
    });
  };

  const handleCancelWaitlist = () => {
    setEditingWaitlistId(null);
    setIsAddingWaitlist(false);
    setWaitlistForm({
      tier: "",
      minMinutes: 0,
      incentive: "",
      colorClass: "badge-bronze",
    });
  };

  // ----- PROMO OFFERS ACTIONS -----
  const savePromoOffers = (newOffers: PromoOffer[]) => {
    setPromoOffers(newOffers);
    localStorage.setItem("pizzaflow_promo_offers", JSON.stringify(newOffers));
    triggerNotification("Promotional offers saved successfully!");
  };

  const handleEditPromo = (offer: PromoOffer) => {
    setEditingPromoId(offer.id);
    setIsAddingPromo(false);
    setPromoForm({
      code: offer.code,
      discountType: offer.discountType,
      value: offer.value,
      description: offer.description,
      minCartValue: offer.minCartValue,
    });
  };

  const handleDeletePromo = (id: string) => {
    if (window.confirm("Are you sure you want to delete this promotional offer?")) {
      const filtered = promoOffers.filter((o) => o.id !== id);
      savePromoOffers(filtered);
    }
  };

  const handleSavePromoForm = (e: React.FormEvent) => {
    e.preventDefault();
    const formattedCode = promoForm.code.trim().toUpperCase();
    if (!formattedCode || !promoForm.description.trim()) {
      triggerNotification("Please fill in the promo code and description.", "error");
      return;
    }

    const cleanedForm = { ...promoForm, code: formattedCode };

    if (editingPromoId) {
      const updated = promoOffers.map((o) =>
        o.id === editingPromoId ? { ...o, ...cleanedForm } : o
      );
      savePromoOffers(updated);
      setEditingPromoId(null);
    } else {
      const newOffer: PromoOffer = {
        id: "promo_" + Math.random().toString(36).slice(2, 9),
        ...cleanedForm,
      };
      savePromoOffers([...promoOffers, newOffer]);
      setIsAddingPromo(false);
    }

    // Reset form
    setPromoForm({
      code: "",
      discountType: "percentage",
      value: 0,
      description: "",
      minCartValue: 0,
    });
  };

  const handleCancelPromo = () => {
    setEditingPromoId(null);
    setIsAddingPromo(false);
    setPromoForm({
      code: "",
      discountType: "percentage",
      value: 0,
      description: "",
      minCartValue: 0,
    });
  };

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
        <div>
          <h1>Offer settings</h1>
          <p className="page-sub">Manage promotional discounts and live waitlist customer loyalty tiers.</p>
        </div>
      </div>

      {notification && (
        <div
          className={`banner ${notification.type === "error" ? "banner-error" : "banner-demo"}`}
          style={{ marginBottom: "20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}
        >
          <span>{notification.message}</span>
          <button style={{ background: "transparent", border: "none", cursor: "pointer", fontWeight: "bold" }} onClick={() => setNotification(null)}>✕</button>
        </div>
      )}

      {/* Tabs */}
      <div className="tab-container" style={{ display: "flex", gap: "12px", borderBottom: "1px solid var(--border)", marginBottom: "24px", paddingBottom: "1px" }}>
        <button
          className={`tab-btn ${activeTab === "waitlist" ? "active" : ""}`}
          onClick={() => {
            setActiveTab("waitlist");
            handleCancelWaitlist();
            handleCancelPromo();
          }}
          style={{
            background: "transparent",
            border: "none",
            borderBottom: activeTab === "waitlist" ? "2px solid var(--accent)" : "2px solid transparent",
            padding: "8px 16px",
            fontSize: "0.95rem",
            fontWeight: "600",
            cursor: "pointer",
            color: activeTab === "waitlist" ? "var(--accent)" : "var(--text-muted)",
            transition: "all 0.2s ease"
          }}
        >
          ⏱️ Waitlist Customer Tiers
        </button>
        <button
          className={`tab-btn ${activeTab === "promo" ? "active" : ""}`}
          onClick={() => {
            setActiveTab("promo");
            handleCancelWaitlist();
            handleCancelPromo();
          }}
          style={{
            background: "transparent",
            border: "none",
            borderBottom: activeTab === "promo" ? "2px solid var(--accent)" : "2px solid transparent",
            padding: "8px 16px",
            fontSize: "0.95rem",
            fontWeight: "600",
            cursor: "pointer",
            color: activeTab === "promo" ? "var(--accent)" : "var(--text-muted)",
            transition: "all 0.2s ease"
          }}
        >
          🏷️ Promotional Coupons
        </button>
      </div>

      {/* Tab 1: Waitlist Offers */}
      {activeTab === "waitlist" && (
        <div className="offers-grid">
          <div className="offers-list-panel">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <h2 style={{ fontSize: "1.2rem", fontWeight: "600", margin: 0 }}>Loyalty Tiers based on Wait Time</h2>
              {!isAddingWaitlist && !editingWaitlistId && (
                <button className="btn btn-small" onClick={() => setIsAddingWaitlist(true)}>
                  ＋ Create New Tier
                </button>
              )}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {waitlistOffers.map((offer) => (
                <div
                  key={offer.id}
                  className="offer-card"
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: "10px",
                    padding: "16px",
                    background: "var(--bg-card)",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "16px",
                    transition: "all 0.2s ease"
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px", flexGrow: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span className={`offer-badge ${offer.colorClass}`} style={{ fontSize: "0.75rem", padding: "3px 8px", borderRadius: "4px", fontWeight: "700", textTransform: "uppercase" }}>
                        {offer.tier} Tier
                      </span>
                      <span style={{ fontSize: "0.85rem", fontWeight: "600", color: "var(--text-muted)" }}>
                        ⏱️ ≥ {offer.minMinutes} mins wait
                      </span>
                    </div>
                    <div style={{ fontSize: "0.95rem", fontWeight: "500", color: "var(--text-color)" }}>
                      🎁 {offer.incentive}
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
                    <button
                      className="btn btn-small btn-secondary"
                      onClick={() => handleEditWaitlist(offer)}
                    >
                      ✏️ Edit
                    </button>
                    <button
                      className="btn btn-small"
                      style={{ background: "rgba(220, 38, 38, 0.08)", color: "#dc2626", border: "1px solid rgba(220, 38, 38, 0.2)" }}
                      onClick={() => handleDeleteWaitlist(offer.id)}
                    >
                      🗑️ Delete
                    </button>
                  </div>
                </div>
              ))}
              {waitlistOffers.length === 0 && (
                <p style={{ color: "var(--muted)", fontStyle: "italic", textAlign: "center", padding: "24px 0" }}>
                  No waitlist tiers configured. Click &apos;Create New Tier&apos; to start.
                </p>
              )}
            </div>
          </div>

          {/* Form Side Drawer/Card */}
          {(isAddingWaitlist || editingWaitlistId) && (
            <div className="card form-drawer" style={{ marginTop: "24px", border: "1px solid var(--accent)", padding: "20px" }}>
              <h3 style={{ margin: "0 0 16px 0", fontSize: "1.1rem", fontWeight: "600" }}>
                {editingWaitlistId ? `✏️ Edit Tier: ${waitlistForm.tier}` : "＋ Create New Loyalty Tier"}
              </h3>

              <form onSubmit={handleSaveWaitlistForm} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                <div className="field">
                  <label htmlFor="tier-name">Tier Name</label>
                  <input
                    id="tier-name"
                    type="text"
                    placeholder="e.g. Bronze, Gold Premium, VIP Elite"
                    value={waitlistForm.tier}
                    onChange={(e) => setWaitlistForm({ ...waitlistForm, tier: e.target.value })}
                  />
                </div>

                <div className="field">
                  <label htmlFor="min-minutes">Minimum Wait Time (Minutes)</label>
                  <input
                    id="min-minutes"
                    type="number"
                    min={0}
                    max={180}
                    value={waitlistForm.minMinutes}
                    onChange={(e) => setWaitlistForm({ ...waitlistForm, minMinutes: parseInt(e.target.value, 10) || 0 })}
                  />
                  <small style={{ color: "var(--muted)", marginTop: "4px" }}>
                    The customer must wait at least this long to activate this offer.
                  </small>
                </div>

                <div className="field">
                  <label htmlFor="incentive-text">Incentive / Compensation Offer</label>
                  <input
                    id="incentive-text"
                    type="text"
                    placeholder="e.g. 15% OFF Bill + Free Welcome Drink 🥤"
                    value={waitlistForm.incentive}
                    onChange={(e) => setWaitlistForm({ ...waitlistForm, incentive: e.target.value })}
                  />
                </div>

                <div className="field">
                  <label htmlFor="badge-class">Visual Badge Style</label>
                  <select
                    id="badge-class"
                    className="select"
                    value={waitlistForm.colorClass}
                    onChange={(e) => setWaitlistForm({ ...waitlistForm, colorClass: e.target.value })}
                  >
                    {BADGE_CLASSES.map((b) => (
                      <option key={b.value} value={b.value}>
                        {b.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div style={{ display: "flex", gap: "12px", marginTop: "8px" }}>
                  <button className="btn" type="submit" style={{ flexGrow: 1 }}>
                    {editingWaitlistId ? "Save Changes" : "Create Tier"}
                  </button>
                  <button className="btn btn-secondary" type="button" onClick={handleCancelWaitlist}>
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Promo Offers */}
      {activeTab === "promo" && (
        <div className="offers-grid">
          <div className="offers-list-panel">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <h2 style={{ fontSize: "1.2rem", fontWeight: "600", margin: 0 }}>Active Promotional Coupon Codes</h2>
              {!isAddingPromo && !editingPromoId && (
                <button className="btn btn-small" onClick={() => setIsAddingPromo(true)}>
                  ＋ Create New Coupon
                </button>
              )}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {promoOffers.map((offer) => (
                <div
                  key={offer.id}
                  className="offer-card"
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: "10px",
                    padding: "16px",
                    background: "var(--bg-card)",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "16px",
                    transition: "all 0.2s ease"
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px", flexGrow: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <code
                        style={{
                          fontSize: "1rem",
                          fontWeight: "800",
                          color: "var(--accent)",
                          background: "rgba(var(--accent-rgb), 0.1)",
                          padding: "4px 10px",
                          borderRadius: "6px",
                          letterSpacing: "1px"
                        }}
                      >
                        {offer.code}
                      </code>
                      <span
                        style={{
                          fontSize: "0.75rem",
                          fontWeight: "600",
                          background: offer.discountType === "percentage" ? "rgba(22, 163, 74, 0.1)" : "rgba(37, 99, 235, 0.1)",
                          color: offer.discountType === "percentage" ? "#16a34a" : "#2563eb",
                          padding: "2px 6px",
                          borderRadius: "4px"
                        }}
                      >
                        {offer.discountType === "percentage" ? `${offer.value}% OFF` : `₹${offer.value} FLAT OFF`}
                      </span>
                      {offer.minCartValue > 0 && (
                        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                          Min Order: ₹{offer.minCartValue}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: "0.9rem", fontWeight: "500", color: "var(--text-color)" }}>
                      {offer.description}
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
                    <button
                      className="btn btn-small btn-secondary"
                      onClick={() => handleEditPromo(offer)}
                    >
                      ✏️ Edit
                    </button>
                    <button
                      className="btn btn-small"
                      style={{ background: "rgba(220, 38, 38, 0.08)", color: "#dc2626", border: "1px solid rgba(220, 38, 38, 0.2)" }}
                      onClick={() => handleDeletePromo(offer.id)}
                    >
                      🗑️ Delete
                    </button>
                  </div>
                </div>
              ))}
              {promoOffers.length === 0 && (
                <p style={{ color: "var(--muted)", fontStyle: "italic", textAlign: "center", padding: "24px 0" }}>
                  No coupons configured. Click &apos;Create New Coupon&apos; to start.
                </p>
              )}
            </div>
          </div>

          {/* Form Drawer */}
          {(isAddingPromo || editingPromoId) && (
            <div className="card form-drawer" style={{ marginTop: "24px", border: "1px solid var(--accent)", padding: "20px" }}>
              <h3 style={{ margin: "0 0 16px 0", fontSize: "1.1rem", fontWeight: "600" }}>
                {editingPromoId ? `✏️ Edit Coupon: ${promoForm.code}` : "＋ Create New Promotional Coupon"}
              </h3>

              <form onSubmit={handleSavePromoForm} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                <div className="field">
                  <label htmlFor="promo-code">Coupon Code</label>
                  <input
                    id="promo-code"
                    type="text"
                    placeholder="e.g. PIZZA30, MONSOON50"
                    style={{ textTransform: "uppercase" }}
                    value={promoForm.code}
                    onChange={(e) => setPromoForm({ ...promoForm, code: e.target.value })}
                  />
                  <small style={{ color: "var(--muted)", marginTop: "4px" }}>
                    Code must be alphanumeric and will be forced to UPPERCASE.
                  </small>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                  <div className="field">
                    <label htmlFor="discount-type">Discount Type</label>
                    <select
                      id="discount-type"
                      className="select"
                      value={promoForm.discountType}
                      onChange={(e) => setPromoForm({ ...promoForm, discountType: e.target.value as "percentage" | "flat" })}
                    >
                      <option value="percentage">Percentage (%)</option>
                      <option value="flat">Flat Amount (₹)</option>
                    </select>
                  </div>

                  <div className="field">
                    <label htmlFor="discount-value">
                      Discount Value {promoForm.discountType === "percentage" ? "(%)" : "(₹)"}
                    </label>
                    <input
                      id="discount-value"
                      type="number"
                      min={0}
                      max={promoForm.discountType === "percentage" ? 100 : 5000}
                      value={promoForm.value}
                      onChange={(e) => setPromoForm({ ...promoForm, value: parseInt(e.target.value, 10) || 0 })}
                    />
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="min-cart-value">Minimum Order Value (Rupees)</label>
                  <input
                    id="min-cart-value"
                    type="number"
                    min={0}
                    value={promoForm.minCartValue}
                    onChange={(e) => setPromoForm({ ...promoForm, minCartValue: parseInt(e.target.value, 10) || 0 })}
                  />
                  <small style={{ color: "var(--muted)", marginTop: "4px" }}>
                    The minimum cart amount required to apply this coupon. Use 0 for no minimum.
                  </small>
                </div>

                <div className="field">
                  <label htmlFor="promo-desc">Public Description</label>
                  <textarea
                    id="promo-desc"
                    rows={2}
                    placeholder="e.g. Get 20% off on your total bill on orders of ₹400 or more!"
                    value={promoForm.description}
                    onChange={(e) => setPromoForm({ ...promoForm, description: e.target.value })}
                  />
                </div>

                <div style={{ display: "flex", gap: "12px", marginTop: "8px" }}>
                  <button className="btn" type="submit" style={{ flexGrow: 1 }}>
                    {editingPromoId ? "Save Changes" : "Create Coupon"}
                  </button>
                  <button className="btn btn-secondary" type="button" onClick={handleCancelPromo}>
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      )}

      <style>{`
        .offer-card:hover {
          border-color: var(--accent) !important;
          box-shadow: 0 4px 12px rgba(var(--accent-rgb), 0.04);
        }
        .offer-badge {
          display: inline-block;
          font-family: var(--font-sans);
        }
        .badge-vip {
          background: #fef3c7 !important;
          color: #d97706 !important;
          border: 1px solid #fcd34d;
        }
        .badge-gold {
          background: #fffbeb !important;
          color: #b45309 !important;
          border: 1px solid #fef3c7;
        }
        .badge-silver-plus {
          background: #f1f5f9 !important;
          color: #475569 !important;
          border: 1px solid #cbd5e1;
        }
        .badge-silver {
          background: #fafafa !important;
          color: #666666 !important;
          border: 1px solid #e5e5e5;
        }
        .badge-bronze {
          background: #fff7ed !important;
          color: #c2410c !important;
          border: 1px solid #ffedd5;
        }
      `}</style>
    </>
  );
}
