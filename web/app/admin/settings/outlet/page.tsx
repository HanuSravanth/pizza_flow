"use client";

// Outlet branding: name + location line, shown in the site header, the
// waiter's table-selection screen, and on every printed bill. White-label by
// design — nothing here is hardcoded to one owner or one outlet.

import { useEffect, useState } from "react";
import { getOutletSettings, saveOutletSettings, DEFAULT_OUTLET, type OutletSettings } from "@/lib/data";

export default function OutletSettingsPage() {
  const [outlet, setOutlet] = useState<OutletSettings>(DEFAULT_OUTLET);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    getOutletSettings()
      .then(setOutlet)
      .catch(() => {});
  }, []);

  async function save() {
    setStatus("saving");
    setError("");
    const message = await saveOutletSettings(outlet);
    if (message) {
      setError(message);
      setStatus("idle");
    } else {
      setStatus("saved");
    }
  }

  return (
    <>
      <h1>Outlet settings</h1>
      <p className="page-sub">Shown in the header, the welcome screen, and on every bill.</p>
      <div className="card" style={{ maxWidth: 480 }}>
        <div className="field">
          <label htmlFor="outlet-name">Outlet name</label>
          <input
            id="outlet-name"
            type="text"
            value={outlet.name}
            onChange={(e) => {
              setOutlet({ ...outlet, name: e.target.value });
              setStatus("idle");
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="outlet-location">Address</label>
          <textarea
            id="outlet-location"
            rows={3}
            value={outlet.location}
            onChange={(e) => {
              setOutlet({ ...outlet, location: e.target.value });
              setStatus("idle");
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="outlet-phone">Phone number</label>
          <input
            id="outlet-phone"
            type="tel"
            value={outlet.phone}
            onChange={(e) => {
              setOutlet({ ...outlet, phone: e.target.value });
              setStatus("idle");
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="outlet-table-count">Dine-In Table Count (1-50)</label>
          <input
            id="outlet-table-count"
            type="number"
            min={1}
            max={50}
            value={outlet.tableCount || 15}
            onChange={(e) => {
              const val = Math.max(1, Math.min(50, parseInt(e.target.value, 10) || 1));
              setOutlet({ ...outlet, tableCount: val });
              setStatus("idle");
            }}
          />
        </div>
        {error && <p className="error-text">{error}</p>}
        <button className="btn" onClick={save} disabled={status === "saving"}>
          {status === "saving" ? "Saving…" : status === "saved" ? "Saved ✓" : "Save"}
        </button>
        {status === "saved" && (
          <p className="page-sub" style={{ marginTop: 8 }}>
            Refresh any open ordering screens to show the new name.
          </p>
        )}
      </div>
    </>
  );
}
