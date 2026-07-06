"use client";

// Sub-navigation for the authenticated admin area: Dashboard, Menu
// management, and a Settings menu grouping Account / Outlet / AI — plus
// sign out. Rendered by app/admin/layout.tsx once a session is confirmed.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

interface AdminNavProps {
  activeRole: "admin" | "manager";
  onRoleChange: (newRole: "admin" | "manager") => void;
  onSignOut: () => void;
}

export default function AdminNav({ activeRole, onRoleChange, onSignOut }: AdminNavProps) {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href;
  const settingsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const el = settingsRef.current;
      if (el?.open && !el.contains(event.target as Node)) el.open = false;
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="admin-subnav" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
      <div className="admin-subnav-links">
        {activeRole === "admin" ? (
          <>
            <Link href="/admin" className={isActive("/admin") ? "active" : ""}>
              Dashboard
            </Link>
            <Link href="/admin/menu" className={isActive("/admin/menu") ? "active" : ""}>
              Menu management
            </Link>
            <Link href="/admin/seating" className={isActive("/admin/seating") ? "active" : ""}>
              Outlet Seating & Waitlist
            </Link>
            <Link href="/admin/ratings" className={isActive("/admin/ratings") ? "active" : ""}>
              Ratings
            </Link>
            <details className="dd admin-settings-dd" ref={settingsRef}>
              <summary>⚙ Settings</summary>
              <div className="dd-panel">
                <Link
                  href="/admin/settings/account"
                  className="dd-item"
                  onClick={() => { if (settingsRef.current) settingsRef.current.open = false; }}
                >
                  Account settings
                </Link>
                <Link
                  href="/admin/settings/outlet"
                  className="dd-item"
                  onClick={() => { if (settingsRef.current) settingsRef.current.open = false; }}
                >
                  Outlet settings
                </Link>
                <Link
                  href="/admin/settings/ai"
                  className="dd-item"
                  onClick={() => { if (settingsRef.current) settingsRef.current.open = false; }}
                >
                  AI settings
                </Link>
                <Link
                  href="/admin/settings/offers"
                  className="dd-item"
                  onClick={() => { if (settingsRef.current) settingsRef.current.open = false; }}
                >
                  Offer list
                </Link>
              </div>
            </details>
          </>
        ) : (
          <>
            <Link href="/admin/seating" className={isActive("/admin/seating") ? "active" : ""}>
              Outlet Seating & Waitlist
            </Link>
            <Link href="/admin/settings/outlet" className={isActive("/admin/settings/outlet") ? "active" : ""}>
              Outlet Settings
            </Link>
          </>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "0.85rem" }}>
          <span className="text-muted" style={{ fontWeight: "500" }}>Role:</span>
          <span style={{ padding: "4px 8px", fontSize: "0.8rem", background: "rgba(128, 128, 128, 0.1)", color: "inherit", borderRadius: "4px", fontWeight: "600" }}>
            {activeRole === "admin" ? "Administrator" : "Restaurant Manager"}
          </span>
        </div>
        <button className="btn btn-small btn-secondary" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}
