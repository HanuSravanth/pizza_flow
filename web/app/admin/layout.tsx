"use client";

// Shared shell for every /admin/* route: session gate, sub-navigation, and
// the floating Insights chat widget. Sub-pages (dashboard, menu management,
// settings/*) assume they are already authenticated — this layout is the
// only place that checks.

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import AdminNav from "@/components/AdminNav";
import InsightsChatWidget from "@/components/InsightsChatWidget";
import { adminSignIn, adminSignOut, getAdminSession, getEffectiveAiFeatures, getAdminEmail } from "@/lib/data";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const [checked, setChecked] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [insightsEnabled, setInsightsEnabled] = useState(true);
  const [digestEnabled, setDigestEnabled] = useState(true);
  const [activeRole, setActiveRole] = useState<"admin" | "manager">("admin");
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    getAdminSession()
      .then((ok) => {
        setSignedIn(ok);
        if (ok) {
          getAdminEmail().then((emailStr) => {
            let role: "admin" | "manager" = "admin";
            if (emailStr) {
              role = emailStr.toLowerCase().includes("manager") ? "manager" : "admin";
            } else if (typeof window !== "undefined") {
              const savedEmail = localStorage.getItem("pizzaflow_demo_admin_email") || "admin";
              role = savedEmail.toLowerCase().includes("manager") ? "manager" : "admin";
            }
            setActiveRole(role);
            localStorage.setItem("pizzaflow_admin_role", role);
            setChecked(true);
          });
        } else {
          setChecked(true);
        }
      })
      .catch((err) => {
        console.error("Failed to check admin session:", err);
        setSignedIn(false);
        setChecked(true);
      });
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    getEffectiveAiFeatures()
      .then((features) => {
        setInsightsEnabled(features.insights);
        setDigestEnabled(features.digest);
      })
      .catch((err) => {
        console.error("Failed to load AI features:", err);
      });
  }, [signedIn]);

  useEffect(() => {
    if (
      signedIn &&
      activeRole === "manager" &&
      pathname !== "/admin/seating" &&
      pathname !== "/admin/settings/outlet"
    ) {
      router.push("/admin/seating");
    }
  }, [signedIn, activeRole, pathname, router]);

  const handleRoleChange = (newRole: "admin" | "manager") => {
    localStorage.setItem("pizzaflow_admin_role", newRole);
    setActiveRole(newRole);
    if (newRole === "manager" && pathname !== "/admin/seating" && pathname !== "/admin/settings/outlet") {
      router.push("/admin/seating");
    }
  };

  if (!checked) return <p className="page-sub">Checking session…</p>;
  if (!signedIn) {
    return (
      <Login
        onSignedIn={(role, emailStr) => {
          localStorage.setItem("pizzaflow_demo_admin_email", emailStr);
          localStorage.setItem("pizzaflow_admin_role", role);
          setActiveRole(role);
          setSignedIn(true);
        }}
      />
    );
  }

  return (
    <>
      <AdminNav
        activeRole={activeRole}
        onRoleChange={handleRoleChange}
        onSignOut={async () => {
          await adminSignOut();
          localStorage.removeItem("pizzaflow_demo_admin_email");
          localStorage.removeItem("pizzaflow_admin_role");
          setSignedIn(false);
        }}
      />
      {children}
      {activeRole === "admin" && (insightsEnabled || digestEnabled) && (
        <InsightsChatWidget insightsEnabled={insightsEnabled} digestEnabled={digestEnabled} />
      )}
    </>
  );
}

function Login({ onSignedIn }: { onSignedIn: (role: "admin" | "manager", email: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const message = await adminSignIn(email, password);
    setBusy(false);
    if (message) {
      setError(message);
    } else {
      const resolvedRole = email.toLowerCase().includes("manager") ? "manager" : "admin";
      onSignedIn(resolvedRole, email);
    }
  }

  return (
    <div style={{ maxWidth: 420, margin: "40px auto" }}>
      <div className="card">
        <h1>Admin login</h1>
        <p className="page-sub">Authorised staff only.</p>
        
        <div style={{ display: "flex", gap: "10px", marginBottom: "20px" }}>
          <button
            type="button"
            className={`btn btn-small ${email.toLowerCase().includes("admin") ? "" : "btn-secondary"}`}
            style={{ flex: 1, padding: "8px", fontSize: "0.85rem" }}
            onClick={() => {
              setEmail("admin");
              setPassword("admin123");
            }}
          >
            👤 Admin Preset
          </button>
          <button
            type="button"
            className={`btn btn-small ${email.toLowerCase().includes("manager") ? "" : "btn-secondary"}`}
            style={{ flex: 1, padding: "8px", fontSize: "0.85rem" }}
            onClick={() => {
              setEmail("manager");
              setPassword("manager123");
            }}
          >
            💼 Manager Preset
          </button>
        </div>

        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="email">Email or username</label>
            <input
              id="email"
              type="text"
              autoComplete="username"
              placeholder="e.g. manager or admin"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && <p className="error-text">{error}</p>}
          <button className="btn" style={{ width: "100%" }} disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
