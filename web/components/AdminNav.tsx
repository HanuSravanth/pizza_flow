"use client";

// Sub-navigation for the authenticated admin area: Dashboard, Menu
// management, and a Settings menu grouping Account / Outlet / AI — plus
// sign out. Rendered by app/admin/layout.tsx once a session is confirmed.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

export default function AdminNav({ onSignOut }: { onSignOut: () => void }) {
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
    <div className="admin-subnav">
      <div className="admin-subnav-links">
        <Link href="/admin" className={isActive("/admin") ? "active" : ""}>
          Dashboard
        </Link>
        <Link href="/admin/tables" className={isActive("/admin/tables") ? "active" : ""}>
          Tables
        </Link>
        <Link href="/admin/menu" className={isActive("/admin/menu") ? "active" : ""}>
          Menu management
        </Link>
        <Link href="/admin/promos" className={isActive("/admin/promos") ? "active" : ""}>
          Promos
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
          </div>
        </details>
      </div>
      <button className="btn btn-small btn-secondary" onClick={onSignOut}>
        Sign out
      </button>
    </div>
  );
}
