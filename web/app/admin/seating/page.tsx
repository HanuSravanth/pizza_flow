"use client";

import { useEffect, useMemo, useState } from "react";
import { formatPaise } from "@/lib/format";
import {
  getActiveOrders,
  getOutletSettings,
  saveOutletSettings,
  type ActiveOrderRecord,
  getDbWaitlist,
  addDbWaitlistEntry,
  updateWaitlistTimeOffset,
  removeWaitlistEntry,
  getDbDineInTables,
  seatDineInTable,
  releaseDineInTable
} from "@/lib/data";
import { TABLE_COUNT } from "@/lib/types";
import { generateUUID } from "@/lib/uuid";

interface WaitlistEntry {
  id: string;
  customerName: string;
  phone: string;
  groupSize: number;
  joinedAt: string; // ISO String
  timeOffsetMinutes: number; // for simulation
}

interface WaitlistOffer {
  id: string;
  tier: string;
  minMinutes: number;
  incentive: string;
  colorClass: string;
}

const DEFAULT_WAITLIST_OFFERS: WaitlistOffer[] = [
  { id: "bronze", tier: "Bronze", minMinutes: 0, incentive: "Complimentary Soft Drink on Seating 🥤", colorClass: "badge-bronze" },
  { id: "silver", tier: "Silver", minMinutes: 10, incentive: "Free Fresh Garlic Bread 🫓", colorClass: "badge-silver" },
  { id: "silver-plus", tier: "Silver Plus", minMinutes: 20, incentive: "Free Fresh Garlic Bread & Cheese Dip 🫓", colorClass: "badge-silver-plus" },
  { id: "gold", tier: "Gold Premium", minMinutes: 30, incentive: "15% OFF Bill + Free Welcome Drink 🥤", colorClass: "badge-gold" },
  { id: "vip", tier: "VIP Elite", minMinutes: 45, incentive: "25% OFF Bill + Free Toppings & Starter 👑", colorClass: "badge-vip" },
];

export default function SeatingPage() {
  const [role, setRole] = useState<"admin" | "manager" | null>(null);
  const [tableCount, setTableCount] = useState(TABLE_COUNT);
  const [outletLocation, setOutletLocation] = useState("New Ashok Nagar, Delhi");
  const [selectedRangeStart, setSelectedRangeStart] = useState(1);

  const [activeOrders, setActiveOrders] = useState<ActiveOrderRecord[]>([]);
  const [waitlist, setWaitlist] = useState<WaitlistEntry[]>([]);
  const [manualTables, setManualTables] = useState<Record<number, {
    customerName: string;
    groupSize: number;
    seatedAt: string | null;
    status: "occupied" | "reserved";
    offerTier?: string | null;
    offerIncentive?: string | null;
  }>>({});

  // Custom Offers State
  const [waitlistOffers, setWaitlistOffers] = useState<WaitlistOffer[]>(DEFAULT_WAITLIST_OFFERS);

  // Form states
  const [newWaitName, setNewWaitName] = useState("");
  const [newWaitPhone, setNewWaitPhone] = useState("");
  const [newWaitSize, setNewWaitSize] = useState(2);
  const [waitFormError, setWaitFormError] = useState("");

  const [manualTableForm, setManualTableForm] = useState<number | null>(null);
  const [manualTableName, setManualTableName] = useState("");
  const [manualTableSize, setManualTableSize] = useState(2);

  const [reserveTableForm, setReserveTableForm] = useState<number | null>(null);
  const [reserveTableName, setReserveTableName] = useState("");
  const [reserveTableSize, setReserveTableSize] = useState(2);

  const [aiOfferModal, setAiOfferModal] = useState<{
    entry: WaitlistEntry;
    loading: boolean;
    data?: { message: string; suggestedIncentive: string; waitTier: string; isAi: boolean };
    error?: string;
  } | null>(null);

  const [seatingModal, setSeatingModal] = useState<WaitlistEntry | null>(null);
  const [tick, setTick] = useState(0);
  const [copiedText, setCopiedText] = useState(false);
  const [operationError, setOperationError] = useState("");
  const [autoAdvance, setAutoAdvance] = useState(false);

  const tableRanges = useMemo(() => {
    const ranges = [];
    for (let i = 1; i <= tableCount; i += 10) {
      const end = Math.min(i + 9, tableCount);
      ranges.push({ start: i, end, label: `Tables ${i}-${end}` });
    }
    return ranges;
  }, [tableCount]);

  const busyCount = useMemo(() => {
    let count = 0;
    for (let t = 1; t <= tableCount; t++) {
      const hasActiveOrder = activeOrders.some((o) => o.tableNumber === t);
      const hasManual = !!manualTables[t];
      if (hasActiveOrder || hasManual) {
        count++;
      }
    }
    return count;
  }, [tableCount, activeOrders, manualTables]);

  useEffect(() => {
    if (selectedRangeStart > tableCount) {
      setSelectedRangeStart(1);
    }
  }, [tableCount, selectedRangeStart]);

  // Load Custom Waitlist Offers
  useEffect(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("pizzaflow_waitlist_offers");
      if (stored) {
        try {
          setWaitlistOffers(JSON.parse(stored));
        } catch (e) {
          console.error("Could not parse waitlist offers", e);
        }
      }
    }
  }, []);

  const reloadData = () => {
    getActiveOrders()
      .then(setActiveOrders)
      .catch((err) => console.error("Could not load active orders", err));
    getDbWaitlist()
      .then(setWaitlist)
      .catch((err) => console.error("Could not load waitlist", err));
    getDbDineInTables()
      .then(setManualTables)
      .catch((err) => console.error("Could not load seating tables", err));
  };

  useEffect(() => {
    reloadData();
    const interval = setInterval(reloadData, 10000);
    return () => clearInterval(interval);
  }, []);

  // Tick for elapsed minutes
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 10000);
    return () => clearInterval(timer);
  }, []);

  // Auto-advance waitlist time automatically (+2 minutes every 2 seconds)
  useEffect(() => {
    if (!autoAdvance || waitlist.length === 0) return;

    const timer = setInterval(() => {
      const promises = waitlist.map((entry) => {
        const newOffset = entry.timeOffsetMinutes + 2;
        return updateWaitlistTimeOffset(entry.id, newOffset);
      });

      Promise.all(promises)
        .then(() => {
          getDbWaitlist().then(setWaitlist).catch(() => {});
        })
        .catch((err) => console.error("Error auto-advancing wait times:", err));
    }, 2000);

    return () => clearInterval(timer);
  }, [autoAdvance, waitlist]);

  useEffect(() => {
    getOutletSettings()
      .then((settings) => {
        let tc = settings.tableCount;
        if (tc === 10 || tc === 30) {
          tc = 15;
          saveOutletSettings({ ...settings, tableCount: 15 }).catch(() => {});
        }
        setTableCount(tc);
        setOutletLocation(settings.location);
      })
      .catch(() => {});

    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("pizzaflow_admin_role") || "admin";
      setRole(saved as "admin" | "manager");
    }
  }, []);

  const getElapsedMinutes = (isoString: string, offset = 0) => {
    const diffMs = Date.now() - new Date(isoString).getTime();
    return Math.max(0, Math.floor(diffMs / 60000) + offset);
  };

  const getOfferDetails = (minutes: number) => {
    const sorted = [...waitlistOffers].sort((a, b) => b.minMinutes - a.minMinutes);
    for (const offer of sorted) {
      if (minutes >= offer.minMinutes) {
        return {
          tier: offer.tier,
          incentive: offer.incentive,
          colorClass: offer.colorClass,
        };
      }
    }
    return {
      tier: "Bronze",
      incentive: "Complimentary Soft Drink on Seating 🥤",
      colorClass: "badge-bronze",
    };
  };

  const handleAddWaitlist = (e: React.FormEvent) => {
    e.preventDefault();
    setWaitFormError("");
    
    const name = newWaitName.trim();
    const phone = newWaitPhone.trim();
    
    if (name.length < 2 || name.length > 40) {
      setWaitFormError("Name must be between 2 and 40 characters.");
      return;
    }
    const phoneRegex = /^[6789]\d{9}$/;
    if (!phoneRegex.test(phone)) {
      setWaitFormError("Phone must be exactly 10 digits starting with 6, 7, 8, or 9.");
      return;
    }
    if (newWaitSize < 2 || newWaitSize > 5) {
      setWaitFormError("Group size must be between 2 and 5.");
      return;
    }

    const newEntry: WaitlistEntry = {
      id: generateUUID(),
      customerName: name,
      phone,
      groupSize: newWaitSize,
      joinedAt: new Date().toISOString(),
      timeOffsetMinutes: 0,
    };

    addDbWaitlistEntry(newEntry).then(() => {
      getDbWaitlist().then(setWaitlist).catch(() => {});
    });
    setNewWaitName("");
    setNewWaitPhone("");
    setNewWaitSize(2);
  };

  const handleSimulateWaitTime = (id: string, amount: number) => {
    const entry = waitlist.find((e) => e.id === id);
    if (!entry) return;
    const newOffset = entry.timeOffsetMinutes + amount;
    updateWaitlistTimeOffset(id, newOffset).then(() => {
      getDbWaitlist().then(setWaitlist).catch(() => {});
    });
  };

  const handleRemoveWaitlist = (id: string) => {
    removeWaitlistEntry(id, "cancelled").then(() => {
      getDbWaitlist().then(setWaitlist).catch(() => {});
    });
  };

  const handleSeatFromWaitlist = (entry: WaitlistEntry, tableNo: number) => {
    const minutes = getElapsedMinutes(entry.joinedAt, entry.timeOffsetMinutes);
    const offer = getOfferDetails(minutes);

    seatDineInTable(
      tableNo,
      entry.customerName,
      entry.groupSize,
      "occupied",
      offer.tier,
      offer.incentive
    ).then((errorMsg) => {
      if (errorMsg) {
        setOperationError(errorMsg);
      } else {
        setOperationError("");
        removeWaitlistEntry(entry.id, "seated", tableNo, new Date().toISOString()).then(() => {
          getDbWaitlist().then(setWaitlist).catch(() => {});
          getDbDineInTables().then(setManualTables).catch(() => {});
        });
      }
    });
    setSeatingModal(null);
  };

  const handleSeatWalkInDirect = (tableNo: number) => {
    const name = manualTableName.trim();
    if (!name) return;
    
    seatDineInTable(tableNo, name, manualTableSize, "occupied").then((errorMsg) => {
      if (errorMsg) {
        setOperationError(errorMsg);
      } else {
        setOperationError("");
        getDbDineInTables().then(setManualTables).catch(() => {});
      }
    });
    setManualTableForm(null);
    setManualTableName("");
    setManualTableSize(2);
  };

  const handleReserveTableDirect = (tableNo: number) => {
    const name = reserveTableName.trim();
    if (!name) return;

    seatDineInTable(tableNo, name, reserveTableSize, "reserved").then((errorMsg) => {
      if (errorMsg) {
        setOperationError(errorMsg);
      } else {
        setOperationError("");
        getDbDineInTables().then(setManualTables).catch(() => {});
      }
    });
    setReserveTableForm(null);
    setReserveTableName("");
    setReserveTableSize(2);
  };

  const handleSeatReservedGuest = (tableNo: number) => {
    const reserved = manualTables[tableNo];
    if (!reserved) return;

    seatDineInTable(reserved.offerTier ? tableNo : tableNo, reserved.customerName, reserved.groupSize, "occupied", reserved.offerTier, reserved.offerIncentive).then((errorMsg) => {
      if (errorMsg) {
        setOperationError(errorMsg);
      } else {
        setOperationError("");
        getDbDineInTables().then(setManualTables).catch(() => {});
      }
    });
  };

  const handleReleaseTable = (tableNo: number) => {
    releaseDineInTable(tableNo).then((errorMsg) => {
      if (errorMsg) {
        setOperationError(errorMsg);
      } else {
        setOperationError("");
        reloadData();
      }
    });
  };

  const handleTriggerAiOffer = async (entry: WaitlistEntry) => {
    const minutes = getElapsedMinutes(entry.joinedAt, entry.timeOffsetMinutes);
    setAiOfferModal({ entry, loading: true });
    
    try {
      const response = await fetch("/api/ai/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: entry.customerName,
          waitedMinutes: minutes,
          groupSize: entry.groupSize,
          currentOccupancy: busyCount,
          totalCapacity: tableCount,
        }),
      });
      if (!response.ok) throw new Error("Could not connect to service");
      const data = await response.json();
      setAiOfferModal({ entry, loading: false, data });
    } catch (err: any) {
      setAiOfferModal({
        entry,
        loading: false,
        error: err.message || "Failed to generate AI offer details.",
      });
    }
  };

  const handleCopyMessage = (text: string) => {
    if (typeof window !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
    setCopiedText(true);
    setTimeout(() => setCopiedText(false), 2000);
  };

  return (
    <div style={{ padding: "0 12px 40px 12px" }}>
      {role === "manager" ? (
        <>
          <h1>Restaurant Manager Console – {outletLocation}</h1>
          <p className="page-sub">Coordinate weekend rush hour table allocation ({tableCount} tables), track active orders, and trigger personalized AI loyalty offers.</p>
        </>
      ) : (
        <>
          <h1>Outlet Seating & Waitlist Manager</h1>
          <p className="page-sub">Coordinate tables and configure waitlist customer loyalty tiers for {outletLocation}.</p>
        </>
      )}

      {operationError && (
        <div className="banner banner-error" style={{ marginTop: 20, marginBottom: 20, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <div>
            <strong>Error performing action:</strong> {operationError}
            <div style={{ fontSize: "0.85rem", marginTop: "4px" }}>
              Note: If this is a database check constraint or RLS error, please ensure you have applied all updates from <code>supabase/schema.sql</code> in your Supabase project.
            </div>
          </div>
          <button className="btn btn-secondary btn-small" onClick={() => setOperationError("")} style={{ whiteSpace: "nowrap" }}>
            Dismiss
          </button>
        </div>
      )}

      {/* Dine-In Tables & Waitlist System */}
      <div className="card dine-in-waitlist-card" id="dine-in-waitlist-system" style={{ marginTop: 20, padding: "24px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px", borderBottom: "1px solid var(--border)", paddingBottom: "16px", marginBottom: "20px" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: "1.4rem", fontWeight: "600" }}>Live Allocation Console</h2>
            <p className="page-sub" style={{ margin: "4px 0 0 0" }}>
              Coordinate layout tables and real-time waiting list.
            </p>
          </div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <span className="badge badge-occupied" style={{ display: "inline-flex", alignItems: "center", gap: "6px", background: "rgba(220, 38, 38, 0.1)", color: "#dc2626", padding: "4px 10px", borderRadius: "12px", fontSize: "0.8rem", fontWeight: "500" }}>
              ● {busyCount} Seated / Busy
            </span>
            <span className="badge badge-vacant" style={{ display: "inline-flex", alignItems: "center", gap: "6px", background: "rgba(22, 163, 74, 0.1)", color: "#16a34a", padding: "4px 10px", borderRadius: "12px", fontSize: "0.8rem", fontWeight: "500" }}>
              ● {Math.max(0, tableCount - busyCount)} Free
            </span>
            <span className="badge badge-waiting" style={{ display: "inline-flex", alignItems: "center", gap: "6px", background: "rgba(234, 88, 12, 0.1)", color: "#ea580c", padding: "4px 10px", borderRadius: "12px", fontSize: "0.8rem", fontWeight: "500" }}>
              ● {waitlist.length} Waiting Queue
            </span>
          </div>
        </div>

        <div className="table-waitlist-grid">
          {/* Left Column: Table Map */}
          <div className="tables-section">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", gap: "12px", flexWrap: "wrap" }}>
              <h3 style={{ fontSize: "1.1rem", fontWeight: "600", margin: 0, display: "flex", alignItems: "center", gap: "8px" }}>
                🪑 Dine-In Layout ({tableCount} Tables)
              </h3>
              {tableCount > 10 && (
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontSize: "0.85rem", color: "var(--muted)", fontWeight: "500" }}>Select Range:</span>
                  <select
                    className="select"
                    style={{ padding: "4px 12px", fontSize: "0.85rem", width: "auto", margin: 0, height: "auto", minHeight: "32px" }}
                    value={selectedRangeStart}
                    onChange={(e) => setSelectedRangeStart(Number(e.target.value))}
                  >
                    {tableRanges.map((r) => (
                      <option key={r.start} value={r.start}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div className="tables-grid-30">
              {Array.from({ length: Math.min(10, tableCount - selectedRangeStart + 1) }, (_, index) => {
                const tableNo = selectedRangeStart + index;
                const activeOrder = activeOrders.find((o) => o.tableNumber === tableNo);
                const manualSeated = manualTables[tableNo];

                const isReserved = !activeOrder && manualSeated?.status === "reserved";
                const isOccupied = !!activeOrder || (manualSeated && manualSeated.status === "occupied");
                const customerName = activeOrder ? activeOrder.customerName : (manualSeated ? manualSeated.customerName : "");
                const groupSize = manualSeated ? manualSeated.groupSize : null;
                const billTotal = activeOrder ? activeOrder.totalPaise : null;
                const seatedAt = activeOrder ? activeOrder.createdAt : (manualSeated?.seatedAt || null);
                const elapsed = seatedAt ? getElapsedMinutes(seatedAt) : 0;

                return (
                  <div
                    key={tableNo}
                    className={`table-card ${isOccupied ? (activeOrder ? "status-order-active" : "status-manual-seated") : (isReserved ? "status-reserved" : "status-vacant")}`}
                    style={{
                      position: "relative",
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "space-between",
                      padding: "12px",
                      borderRadius: "8px",
                      minHeight: "115px",
                      transition: "all 0.2s ease"
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <span className="table-number" style={{ fontWeight: "700", fontSize: "1.1rem" }}>
                        T-{tableNo}
                      </span>
                      {isOccupied && (
                        <span style={{ fontSize: "0.7rem", fontWeight: "600", textTransform: "uppercase", padding: "2px 5px", borderRadius: "4px", background: activeOrder ? "rgba(220, 38, 38, 0.1)" : (manualSeated?.offerTier ? "rgba(22, 163, 74, 0.1)" : "rgba(37, 99, 235, 0.1)"), color: activeOrder ? "#dc2626" : (manualSeated?.offerTier ? "#16a34a" : "#2563eb") }}>
                          {activeOrder ? "Active Order" : (manualSeated?.offerTier ? "Seated (Waitlist)" : "Seated (Walk-in)")}
                        </span>
                      )}
                      {isReserved && (
                        <span style={{ fontSize: "0.7rem", fontWeight: "600", textTransform: "uppercase", padding: "2px 5px", borderRadius: "4px", background: "rgba(217, 119, 6, 0.1)", color: "#d97706" }}>
                          Reserved
                        </span>
                      )}
                    </div>

                    {isOccupied || isReserved ? (
                      <div style={{ margin: "6px 0", flexGrow: 1 }}>
                        <div style={{ fontWeight: "600", fontSize: "0.85rem", textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }} title={customerName}>
                          👤 {customerName}
                        </div>
                        {groupSize && (
                          <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
                            👥 Group size: {groupSize}
                          </div>
                        )}
                        {billTotal !== null && (
                          <div style={{ fontSize: "0.75rem", fontWeight: "600", color: "#16a34a" }}>
                            🍕 Bill: {formatPaise(billTotal)}
                          </div>
                        )}
                        {seatedAt ? (
                          <div style={{ fontSize: "0.7rem", color: "var(--muted)", marginTop: "2px" }}>
                            ⏱️ Seated {elapsed} min{elapsed !== 1 ? "s" : ""} ago
                          </div>
                        ) : (
                          <div style={{ fontSize: "0.7rem", color: "#d97706", fontWeight: "600", marginTop: "2px" }}>
                            📅 Status: Reserved
                          </div>
                        )}

                        {manualSeated?.offerTier && (
                          <div style={{ marginTop: "6px", display: "flex", flexDirection: "column", gap: "2px", background: "rgba(22, 163, 74, 0.05)", border: "1px solid rgba(22, 163, 74, 0.1)", padding: "4px 6px", borderRadius: "4px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                              <span style={{ fontSize: "0.65rem", fontWeight: "700", textTransform: "uppercase", color: "#16a34a" }}>
                                🎁 {manualSeated.offerTier} Reward
                              </span>
                            </div>
                            <div style={{ fontSize: "0.65rem", color: "var(--text-color)", fontWeight: "500", textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }} title={manualSeated.offerIncentive || ""}>
                              {manualSeated.offerIncentive}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div style={{ margin: "12px 0", textAlign: "center", color: "var(--muted)", fontSize: "0.75rem" }}>
                        Vacant Table
                      </div>
                    )}

                    <div style={{ marginTop: "4px" }}>
                      {isOccupied ? (
                        <button
                          className="btn btn-small"
                          style={{
                            width: "100%",
                            padding: "4px",
                            fontSize: "0.75rem",
                            background: "rgba(220, 38, 38, 0.08)",
                            color: "#dc2626",
                            border: "1px solid rgba(220, 38, 38, 0.2)"
                          }}
                          onClick={() => handleReleaseTable(tableNo)}
                        >
                          Clear Table
                        </button>
                      ) : isReserved ? (
                        <div style={{ display: "flex", gap: "4px" }}>
                          <button
                            className="btn btn-small"
                            style={{ flexGrow: 1, padding: "4px", fontSize: "0.75rem", background: "#16a34a", color: "#fff" }}
                            onClick={() => handleSeatReservedGuest(tableNo)}
                          >
                            Seat Guest
                          </button>
                          <button
                            className="btn btn-small btn-secondary"
                            style={{ padding: "4px", fontSize: "0.75rem", color: "#dc2626" }}
                            onClick={() => handleReleaseTable(tableNo)}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div style={{ display: "flex", gap: "4px" }}>
                          <button
                            className="btn btn-small btn-secondary"
                            style={{ flexGrow: 1, padding: "4px", fontSize: "0.75rem" }}
                            onClick={() => {
                              setManualTableForm(tableNo);
                              setManualTableName("");
                              setManualTableSize(2);
                            }}
                          >
                            Seat Walk-In
                          </button>
                          <button
                            className="btn btn-small btn-secondary"
                            style={{ padding: "4px", fontSize: "0.75rem" }}
                            onClick={() => {
                              setReserveTableForm(tableNo);
                              setReserveTableName("");
                              setReserveTableSize(2);
                            }}
                            title="Reserve Table"
                          >
                            Reserve
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right Column: Waitlist Panel */}
          <div className="waitlist-section" style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "12px", padding: "16px" }}>
            <h3 style={{ fontSize: "1.1rem", fontWeight: "600", marginBottom: "12px", display: "flex", alignItems: "center", gap: "8px" }}>
              📝 Add to Waitlist
            </h3>
            
            <form onSubmit={handleAddWaitlist} style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "20px" }}>
              <div>
                <input
                  type="text"
                  placeholder="Customer Name"
                  className="input"
                  style={{ width: "100%" }}
                  value={newWaitName}
                  onChange={(e) => setNewWaitName(e.target.value)}
                />
              </div>
              <div>
                <input
                  type="text"
                  placeholder="Phone Number (10 digits)"
                  className="input"
                  style={{ width: "100%" }}
                  value={newWaitPhone}
                  onChange={(e) => setNewWaitPhone(e.target.value)}
                />
              </div>
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <span style={{ fontSize: "0.8rem", color: "var(--muted)", whiteSpace: "nowrap" }}>Group Size:</span>
                <select
                  className="select"
                  style={{ flexGrow: 1 }}
                  value={newWaitSize}
                  onChange={(e) => setNewWaitSize(Number(e.target.value))}
                >
                  {Array.from({ length: 4 }, (_, i) => i + 2).map((n) => (
                    <option key={n} value={n}>
                      {n} Guest{n > 1 ? "s" : ""}
                    </option>
                  ))}
                </select>
              </div>
              
              {waitFormError && (
                <div style={{ color: "#dc2626", fontSize: "0.75rem", fontWeight: "500" }}>
                  ⚠️ {waitFormError}
                </div>
              )}

              <button className="btn" type="submit" style={{ width: "100%", padding: "8px" }}>
                Add to Waitlist Queue
              </button>
            </form>

            <div style={{ borderTop: "1px solid var(--border)", paddingTop: "16px", marginBottom: "12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                <h3 style={{ fontSize: "1.1rem", fontWeight: "600", margin: 0, display: "flex", alignItems: "center", gap: "8px" }}>
                  👥 Waiting Queue
                </h3>
                <span style={{ fontSize: "0.8rem", fontWeight: "500", color: "var(--muted)" }}>
                  {waitlist.length} Group{waitlist.length !== 1 ? "s" : ""}
                </span>
              </div>
              
              {/* Auto-Advance Feature */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "rgba(37, 99, 235, 0.05)", border: "1px solid rgba(37, 99, 235, 0.1)", borderRadius: "8px", padding: "8px 12px", marginBottom: "4px" }}>
                <div style={{ display: "flex", flexDirection: "column" }}>
                  <span style={{ fontSize: "0.8rem", fontWeight: "600", color: "#2563eb", display: "flex", alignItems: "center", gap: "4px" }}>
                    ⚡ Auto-Advance Wait Times
                  </span>
                  <span style={{ fontSize: "0.7rem", color: "var(--muted)" }}>
                    Fast-forwards queue (+2m every 2s)
                  </span>
                </div>
                <button
                  type="button"
                  className={`btn btn-small ${autoAdvance ? "btn-primary" : "btn-secondary"}`}
                  style={{
                    padding: "4px 12px",
                    fontSize: "0.75rem",
                    background: autoAdvance ? "#2563eb" : "transparent",
                    color: autoAdvance ? "#fff" : "var(--text-color)",
                    border: "1px solid #2563eb",
                    borderRadius: "20px",
                    cursor: "pointer",
                    fontWeight: "600"
                  }}
                  onClick={() => setAutoAdvance(!autoAdvance)}
                >
                  {autoAdvance ? "ON (Fast)" : "OFF (Real)"}
                </button>
              </div>
            </div>

            {waitlist.length === 0 ? (
              <div style={{ padding: "24px 12px", textAlign: "center", color: "var(--muted)", fontSize: "0.85rem" }}>
                The queue is empty. All waiting customers seated!
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "12px", maxHeight: "400px", overflowY: "auto" }}>
                {[...waitlist]
                  .sort((a, b) => {
                    const elapsedA = getElapsedMinutes(a.joinedAt, a.timeOffsetMinutes);
                    const elapsedB = getElapsedMinutes(b.joinedAt, b.timeOffsetMinutes);
                    return elapsedB - elapsedA;
                  })
                  .map((entry) => {
                    const minutes = getElapsedMinutes(entry.joinedAt, entry.timeOffsetMinutes);
                    const offer = getOfferDetails(minutes);

                    return (
                      <div
                        key={entry.id}
                        className="wait-item"
                        style={{
                          border: "1px solid var(--border)",
                          borderRadius: "8px",
                          padding: "10px",
                          background: "var(--bg-page)",
                          position: "relative"
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                          <div>
                            <div style={{ fontWeight: "700", fontSize: "0.9rem" }}>{entry.customerName}</div>
                            <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>{entry.phone} · {entry.groupSize} Guests</div>
                          </div>
                          <span
                            className="time-badge"
                            style={{
                              fontSize: "0.75rem",
                              fontWeight: "700",
                              color: minutes > 30 ? "#dc2626" : (minutes > 15 ? "#ea580c" : "var(--muted)")
                            }}
                          >
                            ⏱️ {minutes}m wait
                          </span>
                        </div>

                        {/* Interactive Simulation Controls */}
                        <div style={{ display: "flex", gap: "6px", marginTop: "4px", alignItems: "center" }}>
                          <span style={{ fontSize: "0.65rem", color: "var(--muted)" }}>Simulate time:</span>
                          <button
                            className="btn btn-small btn-secondary"
                            style={{ padding: "1px 6px", fontSize: "0.65rem", height: "auto", minHeight: "20px" }}
                            onClick={() => handleSimulateWaitTime(entry.id, 5)}
                          >
                            +5m
                          </button>
                          <button
                            className="btn btn-small btn-secondary"
                            style={{ padding: "1px 6px", fontSize: "0.65rem", height: "auto", minHeight: "20px" }}
                            onClick={() => handleSimulateWaitTime(entry.id, 15)}
                          >
                            +15m
                          </button>
                        </div>

                        {/* Loyalty Offer Badge & Incentive */}
                        <div style={{ margin: "8px 0", background: "rgba(0,0,0,0.02)", padding: "6px", borderRadius: "4px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                            <span className={`offer-badge ${offer.colorClass}`} style={{ fontSize: "0.65rem", padding: "2px 6px", borderRadius: "4px", fontWeight: "700", textTransform: "uppercase" }}>
                              {offer.tier} Tier
                            </span>
                            <span style={{ fontSize: "0.75rem", fontWeight: "600" }}>Offer:</span>
                          </div>
                          <div style={{ fontSize: "0.75rem", color: "var(--text-color)", fontWeight: "500", marginTop: "2px" }}>
                            {offer.incentive}
                          </div>
                        </div>

                        {/* Actions */}
                        <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", marginTop: "8px" }}>
                          <button
                            className="btn btn-small"
                            style={{ flexGrow: 1, padding: "4px", fontSize: "0.75rem", background: "#16a34a", color: "#fff" }}
                            onClick={() => setSeatingModal(entry)}
                          >
                            Seat Customer
                          </button>
                          
                          <button
                            className="btn btn-small btn-secondary"
                            style={{ padding: "4px" }}
                            title="Generate Hospitable AI Apology Message"
                            onClick={() => handleTriggerAiOffer(entry)}
                          >
                            ✦ AI Offer
                          </button>
                        </div>

                        {/* Cancel button */}
                        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", borderTop: "1px dashed var(--border)", marginTop: "8px", paddingTop: "6px" }}>
                          <button
                            style={{ background: "transparent", border: "none", color: "#dc2626", fontSize: "0.7rem", cursor: "pointer", fontWeight: "500" }}
                            onClick={() => handleRemoveWaitlist(entry.id)}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Modal: Seat Walk-In Table Direct */}
      {manualTableForm !== null && (
        <div className="modal-overlay" style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.5)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 1000 }}>
          <div className="card" style={{ width: "100%", maxWidth: "360px", margin: "16px", padding: "20px" }}>
            <h3 style={{ margin: "0 0 12px 0", fontSize: "1.1rem" }}>Direct Seating: Table T-{manualTableForm}</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              <label>
                <span style={{ fontSize: "0.8rem", color: "var(--muted)" }}>Customer Name</span>
                <input
                  type="text"
                  className="input"
                  style={{ width: "100%", marginTop: "4px" }}
                  placeholder="e.g. Rahul Sharma"
                  value={manualTableName}
                  onChange={(e) => setManualTableName(e.target.value)}
                />
              </label>
              <label>
                <span style={{ fontSize: "0.8rem", color: "var(--muted)" }}>Group Size</span>
                <select
                  className="select"
                  style={{ width: "100%", marginTop: "4px" }}
                  value={manualTableSize}
                  onChange={(e) => setManualTableSize(Number(e.target.value))}
                >
                  {Array.from({ length: 4 }, (_, i) => i + 2).map((n) => (
                    <option key={n} value={n}>
                      {n} Guest{n > 1 ? "s" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <div style={{ display: "flex", gap: "8px", marginTop: "10px" }}>
                <button
                  className="btn"
                  style={{ flexGrow: 1 }}
                  onClick={() => handleSeatWalkInDirect(manualTableForm)}
                  disabled={!manualTableName.trim()}
                >
                  Confirm Seating
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => setManualTableForm(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Reserve Table */}
      {reserveTableForm !== null && (
        <div className="modal-overlay" style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.5)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 1000 }}>
          <div className="card" style={{ width: "100%", maxWidth: "360px", margin: "16px", padding: "20px" }}>
            <h3 style={{ margin: "0 0 12px 0", fontSize: "1.1rem" }}>Reserve Table: Table T-{reserveTableForm}</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              <label>
                <span style={{ fontSize: "0.8rem", color: "var(--muted)" }}>Customer Name</span>
                <input
                  type="text"
                  className="input"
                  style={{ width: "100%", marginTop: "4px" }}
                  placeholder="e.g. Priyesh Patel"
                  value={reserveTableName}
                  onChange={(e) => setReserveTableName(e.target.value)}
                />
              </label>
              <label>
                <span style={{ fontSize: "0.8rem", color: "var(--muted)" }}>Group Size</span>
                <select
                  className="select"
                  style={{ width: "100%", marginTop: "4px" }}
                  value={reserveTableSize}
                  onChange={(e) => setReserveTableSize(Number(e.target.value))}
                >
                  {Array.from({ length: 4 }, (_, i) => i + 2).map((n) => (
                    <option key={n} value={n}>
                      {n} Guest{n > 1 ? "s" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <div style={{ display: "flex", gap: "8px", marginTop: "10px" }}>
                <button
                  className="btn"
                  style={{ flexGrow: 1, background: "#d97706", color: "#fff" }}
                  onClick={() => handleReserveTableDirect(reserveTableForm)}
                  disabled={!reserveTableName.trim()}
                >
                  Confirm Reservation
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => setReserveTableForm(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Seat Waiting Guest to a Free Table */}
      {seatingModal !== null && (
        <div className="modal-overlay" style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.5)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 1000 }}>
          <div className="card" style={{ width: "100%", maxWidth: "420px", margin: "16px", padding: "20px" }}>
            <h3 style={{ margin: "0 0 4px 0", fontSize: "1.1rem" }}>Seat {seatingModal.customerName}</h3>
            <p className="page-sub" style={{ margin: "0 0 16px 0" }}>
              Allocate one of our {tableCount} tables to this party of {seatingModal.groupSize} guest{seatingModal.groupSize !== 1 ? "s" : ""}.
            </p>
            
            <div style={{ maxHeight: "200px", overflowY: "auto", border: "1px solid var(--border)", borderRadius: "6px", padding: "10px", marginBottom: "16px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "8px" }}>
                {Array.from({ length: tableCount }, (_, index) => {
                  const tableNo = index + 1;
                  const activeOrder = activeOrders.find((o) => o.tableNumber === tableNo);
                  const manualSeated = manualTables[tableNo];
                  const isOccupied = !!activeOrder || !!manualSeated;

                  return (
                    <button
                      key={tableNo}
                      className={`btn btn-small ${isOccupied ? "btn-secondary" : ""}`}
                      style={{
                        padding: "8px 0",
                        fontWeight: "700",
                        fontSize: "0.85rem",
                        background: isOccupied ? "rgba(0,0,0,0.05)" : "#16a34a",
                        color: isOccupied ? "var(--muted)" : "#fff",
                        cursor: isOccupied ? "not-allowed" : "pointer"
                      }}
                      disabled={isOccupied}
                      onClick={() => handleSeatFromWaitlist(seatingModal, tableNo)}
                    >
                      T-{tableNo}
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button className="btn btn-secondary" onClick={() => setSeatingModal(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Hospitable AI Apology / Compensation Copilot */}
      {aiOfferModal !== null && (
        <div className="modal-overlay" style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.5)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 1000 }}>
          <div className="card ai-panel" style={{ width: "100%", maxWidth: "500px", margin: "16px", padding: "20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
              <h3 style={{ margin: 0, fontSize: "1.1rem" }}>
                ✦ AI Hospitality Assistant
              </h3>
              <span className="ai-sparkle" aria-hidden="true">✦</span>
            </div>

            {aiOfferModal.loading ? (
              <div style={{ padding: "40px 0", textAlign: "center", color: "var(--muted)" }}>
                <div className="ai-pulse" style={{ marginBottom: "10px", fontSize: "1.2rem" }}>Generating personalized apology & gesture...</div>
                <p className="ai-note" style={{ margin: 0 }}>Consulting hospitality algorithms based on {getElapsedMinutes(aiOfferModal.entry.joinedAt, aiOfferModal.entry.timeOffsetMinutes)}m wait time...</p>
              </div>
            ) : aiOfferModal.error ? (
              <div style={{ padding: "12px", background: "rgba(220, 38, 38, 0.05)", border: "1px solid rgba(220, 38, 38, 0.1)", borderRadius: "6px", color: "#dc2626", fontSize: "0.85rem" }}>
                <strong>Error:</strong> {aiOfferModal.error}
              </div>
            ) : (
              <div>
                <p className="ai-note" style={{ marginTop: 0, marginBottom: "16px" }}>
                  Below is an AI-generated, high-hospitality text message to copy and send to the customer via SMS/WhatsApp, or read out to them with absolute warmth.
                </p>

                <div style={{ border: "1px solid var(--border)", borderRadius: "8px", background: "var(--bg-page)", padding: "16px", position: "relative", marginBottom: "16px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px dashed var(--border)", paddingBottom: "8px", marginBottom: "10px" }}>
                    <span style={{ fontSize: "0.75rem", fontWeight: "700", textTransform: "uppercase" }}>
                      Wait Tier: <span className="text-accent">{aiOfferModal.data?.waitTier}</span>
                    </span>
                    <span style={{ fontSize: "0.7rem", color: "var(--muted)" }}>
                      {aiOfferModal.data?.isAi ? "Generated by Gemini AI" : "Local Rule Match"}
                    </span>
                  </div>

                  <blockquote style={{ margin: 0, fontSize: "0.9rem", fontStyle: "italic", lineHeight: "1.5", color: "var(--text-color)" }}>
                    &ldquo;{aiOfferModal.data?.message}&rdquo;
                  </blockquote>

                  <div style={{ marginTop: "12px", background: "rgba(22, 163, 74, 0.05)", border: "1px solid rgba(22, 163, 74, 0.1)", padding: "8px", borderRadius: "6px", fontSize: "0.8rem", color: "#16a34a", fontWeight: "600" }}>
                    🎁 Incentive Locked: {aiOfferModal.data?.suggestedIncentive}
                  </div>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <button
                    className="btn btn-small"
                    onClick={() => handleCopyMessage(aiOfferModal.data?.message || "")}
                  >
                    {copiedText ? "✓ Copied to clipboard!" : "📋 Copy Message"}
                  </button>
                  <button className="btn btn-small btn-secondary" onClick={() => setAiOfferModal(null)}>
                    Close
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <style>{`
        .table-waitlist-grid {
          display: grid;
          grid-template-columns: 1fr 340px;
          gap: 24px;
          align-items: start;
        }
        @media (max-width: 1024px) {
          .table-waitlist-grid {
            grid-template-columns: 1fr;
          }
        }
        .tables-grid-30 {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
          gap: 12px;
        }
        .table-card {
          border-radius: 8px;
          padding: 12px;
          transition: all 0.2s ease-in-out;
        }
        .status-vacant {
          border: 1px dashed var(--border);
          background: var(--bg-card);
          color: var(--text-muted);
        }
        .status-vacant:hover {
          border-color: var(--accent);
          background: rgba(var(--accent-rgb), 0.02);
        }
        .status-order-active {
          border: 2px solid #dc2626 !important;
          background: rgba(220, 38, 38, 0.03);
          box-shadow: 0 4px 12px rgba(220, 38, 38, 0.05);
        }
        .status-manual-seated {
          border: 1.5px solid #2563eb !important;
          background: rgba(37, 99, 235, 0.03);
          box-shadow: 0 4px 12px rgba(37, 99, 235, 0.05);
        }
        .status-reserved {
          border: 1.5px dashed #d97706 !important;
          background: rgba(217, 119, 6, 0.03);
          box-shadow: 0 4px 12px rgba(217, 119, 6, 0.05);
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
    </div>
  );
}
