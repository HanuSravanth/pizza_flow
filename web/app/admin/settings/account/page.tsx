"use client";

// Account settings: the signed-in admin's own email (read-only here — email
// changes go through Supabase's confirmation flow, which needs email
// delivery configured) and a password change. Additional admin accounts are
// created with `npm run admin:create` — a deliberately privileged CLI action,
// not a page in this app.

import { useEffect, useState } from "react";
import { adminChangePassword, getAdminEmail, isDemoMode } from "@/lib/data";

export default function AccountSettingsPage() {
  const [email, setEmail] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    getAdminEmail().then(setEmail);
  }, []);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setStatus("saving");
    const message = await adminChangePassword(password);
    if (message) {
      setError(message);
      setStatus("idle");
    } else {
      setStatus("saved");
      setPassword("");
      setConfirm("");
    }
  }

  return (
    <>
      <h1>Account settings</h1>
      <p className="page-sub">Manage the login you&apos;re signed in with.</p>

      <div className="card" style={{ maxWidth: 420 }}>
        <div className="field">
          <label>Signed in as</label>
          <p style={{ fontWeight: 700 }}>{email ?? (isDemoMode ? "demo mode — no account" : "…")}</p>
        </div>

        <form onSubmit={changePassword}>
          <div className="field">
            <label htmlFor="new-password">New password</label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setStatus("idle");
              }}
              minLength={8}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="confirm-password">Confirm new password</label>
            <input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value);
                setStatus("idle");
              }}
              minLength={8}
              required
            />
          </div>
          {error && <p className="error-text">{error}</p>}
          {status === "saved" && <p style={{ color: "var(--ok)", fontWeight: 600 }}>Password updated ✓</p>}
          <button className="btn" style={{ width: "100%" }} disabled={status === "saving"}>
            {status === "saving" ? "Saving…" : "Change password"}
          </button>
        </form>
      </div>
    </>
  );
}
