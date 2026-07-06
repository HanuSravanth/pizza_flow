"use client";

// AI settings — three tabs:
//   1. Features   — the master AI kill switch plus a per-feature sub-toggle for
//      each of the four AI features.
//   2. Model      — which OpenRouter model every AI feature uses.
//   3. Customise  — optional per-feature "custom instructions". The real system
//      prompts stay hidden on the server; this only edits the short owner text
//      folded into them (fenced and lower-priority) at request time.
//
// Everything here is enforced server-side in the /api/ai/* routes (the master
// switch, the per-feature flags, the chosen model and the custom instructions),
// never trusted from the client — the UI just reflects and edits the stored
// settings. See lib/data.ts for storage and lib/prompts.ts for the base prompts.

import { useEffect, useState } from "react";
import {
  isAiEnabled,
  setAiEnabled,
  getAiFeatureFlags,
  setAiFeatureFlag,
  getAiModel,
  setAiModel,
  getAiCustomInstructions,
  setAiCustomInstructions,
  clearAiCustomInstructions,
  getStoredOpenRouterKeyMasked,
  setOpenRouterKey,
  clearOpenRouterKey,
  isDemoMode,
} from "@/lib/data";
import { AI_FEATURES, FEATURE_META, MAX_CUSTOM_INSTRUCTIONS, type AiFeature } from "@/lib/prompts";
import { AI_MODEL_OPTIONS } from "@/lib/aiCatalog";

type Tab = "features" | "model" | "customise";

const TABS: { id: Tab; label: string }[] = [
  { id: "features", label: "Features" },
  { id: "model", label: "Model" },
  { id: "customise", label: "Customise" },
];

export default function AiSettingsPage() {
  const [tab, setTab] = useState<Tab>("features");

  return (
    <>
      <h1>AI settings</h1>
      <p className="page-sub">
        Turn AI features on or off, choose the model, and add custom instructions to fine-tune each
        feature. Ordering, billing, GST and payment are never affected — this only controls the AI panels.
      </p>

      {isDemoMode && (
        <div className="banner banner-demo">
          <strong>Demo mode:</strong> Supabase is not configured, so these settings are stored in
          this browser only. The server-side AI routes fall back to their defaults (all features on,
          the default model and prompts) until a Supabase project is connected.
        </div>
      )}

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab-btn ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "features" && <FeaturesTab />}
      {tab === "model" && <ModelTab />}
      {tab === "customise" && <CustomiseTab />}
    </>
  );
}

// ------------------------------------------------------------------ Features

function FeaturesTab() {
  const [enabled, setEnabled] = useState(true);
  const [flags, setFlags] = useState<Record<AiFeature, boolean>>(
    () => Object.fromEntries(AI_FEATURES.map((f) => [f, true])) as Record<AiFeature, boolean>
  );
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([isAiEnabled(), getAiFeatureFlags()]).then(([master, featureFlags]) => {
      setEnabled(master);
      setFlags(featureFlags);
      setLoaded(true);
    });
  }, []);

  async function toggleMaster() {
    const next = !enabled;
    setEnabled(next); // optimistic
    setError("");
    const message = await setAiEnabled(next);
    if (message) {
      setError(message);
      setEnabled(!next); // revert
    }
  }

  async function toggleFeature(feature: AiFeature) {
    const next = !flags[feature];
    setFlags((prev) => ({ ...prev, [feature]: next })); // optimistic
    setError("");
    const message = await setAiFeatureFlag(feature, next);
    if (message) {
      setError(message);
      setFlags((prev) => ({ ...prev, [feature]: !next })); // revert
    }
  }

  return (
    <>
      <div className="card" style={{ maxWidth: 560 }}>
        <div className="ai-toggle-row">
          <label className="switch">
            <input type="checkbox" checked={enabled} disabled={!loaded} onChange={toggleMaster} />
            <span className="switch-track" />
          </label>
          <div>
            <strong>{enabled ? "AI features are ON" : "AI features are OFF"}</strong>
            <p className="page-sub" style={{ margin: 0 }}>
              {enabled
                ? "The master switch is on. Use the per-feature toggles below to fine-tune which features are live."
                : "All four AI panels are hidden from customers and admin. Every /api/ai/* call is also rejected server-side, even if called directly."}
            </p>
          </div>
        </div>

        <div className="ai-subtoggles" aria-disabled={!enabled}>
          {AI_FEATURES.map((feature) => {
            const meta = FEATURE_META[feature];
            const on = enabled && flags[feature];
            return (
              <div key={feature} className={`ai-subtoggle ${enabled ? "" : "disabled"}`}>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={flags[feature]}
                    disabled={!loaded || !enabled}
                    onChange={() => toggleFeature(feature)}
                  />
                  <span className="switch-track" />
                </label>
                <div>
                  <strong>
                    {meta.label} — {on ? "on" : "off"}
                  </strong>
                  <p className="page-sub" style={{ margin: 0 }}>
                    {meta.blurb}
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        {error && <p className="error-text">{error}</p>}
        {!enabled && (
          <p className="page-sub" style={{ marginTop: 12 }}>
            The master switch is off, so every feature is off regardless of its own toggle. Turn the
            master switch on to control features individually.
          </p>
        )}
      </div>
    </>
  );
}

// --------------------------------------------------------------------- Model

const CUSTOM = "__custom__";

function ModelTab() {
  const [selected, setSelected] = useState("");
  const [custom, setCustom] = useState("");
  const [active, setActive] = useState(""); // the model currently in effect
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getAiModel().then((model) => {
      setActive(model);
      const known = AI_MODEL_OPTIONS.some((o) => o.id === model);
      setSelected(known ? model : CUSTOM);
      if (!known) setCustom(model);
      setLoaded(true);
    });
  }, []);

  const chosen = selected === CUSTOM ? custom.trim() : selected;

  async function save() {
    setBusy(true);
    setError("");
    setSaved(false);
    const message = await setAiModel(chosen);
    setBusy(false);
    if (message) {
      setError(message);
      return;
    }
    setActive(chosen);
    setSaved(true);
  }

  return (
    <div className="card" style={{ maxWidth: 860 }}>
      <h3>Model provider</h3>
      <p className="page-sub">Where the models are served from. More providers can be added later.</p>
      <select className="select" value="openrouter" disabled style={{ maxWidth: 300 }}>
        <option value="openrouter">OpenRouter</option>
      </select>

      <ApiKeySection />

      <div className="settings-section">
        <h3>Model selection</h3>
        <p className="page-sub">
          Every AI feature uses this OpenRouter model. Currently active:{" "}
          <strong>{loaded ? active : "…"}</strong>
        </p>
      </div>

      <div className="model-list">
        {AI_MODEL_OPTIONS.map((option) => (
          <label key={option.id} className={`model-option ${selected === option.id ? "selected" : ""}`}>
            <input
              type="radio"
              name="ai-model"
              value={option.id}
              checked={selected === option.id}
              onChange={() => {
                setSelected(option.id);
                setSaved(false);
              }}
            />
            <div>
              <strong>{option.label}</strong> <code className="model-slug">{option.id}</code>
              <p className="page-sub" style={{ margin: 0 }}>
                {option.note}
              </p>
            </div>
          </label>
        ))}

        <label className={`model-option model-custom ${selected === CUSTOM ? "selected" : ""}`}>
          <input
            type="radio"
            name="ai-model"
            value={CUSTOM}
            checked={selected === CUSTOM}
            onChange={() => {
              setSelected(CUSTOM);
              setSaved(false);
            }}
          />
          <div style={{ flex: 1 }}>
            <strong>Custom</strong>
            <p className="page-sub" style={{ margin: "0 0 8px" }}>
              Any OpenRouter model id, e.g. <code>openai/gpt-4o-mini</code>.
            </p>
            <input
              type="text"
              placeholder="provider/model"
              value={custom}
              disabled={selected !== CUSTOM}
              onChange={(e) => {
                setCustom(e.target.value);
                setSaved(false);
              }}
            />
          </div>
        </label>
      </div>

      {error && <p className="error-text">{error}</p>}
      {saved && <p className="banner banner-ok" style={{ marginTop: 12 }}>Model saved.</p>}

      <button
        className="btn"
        style={{ marginTop: 14 }}
        onClick={save}
        disabled={!loaded || busy || !chosen || chosen === active}
      >
        {busy ? "Saving…" : "Save model"}
      </button>
    </div>
  );
}

function ApiKeySection() {
  const [stored, setStored] = useState<string | null>(null); // masked, or null
  const [value, setValue] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    getStoredOpenRouterKeyMasked().then((masked) => {
      setStored(masked);
      setLoaded(true);
    });
  }, []);

  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    const message = await setOpenRouterKey(value);
    setBusy(false);
    if (message) {
      setError(message);
      return;
    }
    setStored(await getStoredOpenRouterKeyMasked());
    setValue("");
    setNotice("API key saved.");
  }

  async function clear() {
    setBusy(true);
    setError("");
    setNotice("");
    const message = await clearOpenRouterKey();
    setBusy(false);
    if (message) {
      setError(message);
      return;
    }
    setStored(null);
    setValue("");
    setNotice("API key removed — falling back to the server environment key.");
  }

  return (
    <div className="settings-section">
      <h3>API key</h3>
      <p className="page-sub">
        Your OpenRouter API key (from{" "}
        <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
          openrouter.ai/keys
        </a>
        ). Stored server-side and never shown in full again. Leave it unset to use the key from the
        server environment instead.
      </p>

      <p className="page-sub" style={{ marginBottom: 8 }}>
        {!loaded
          ? "Checking…"
          : stored
            ? `A key is saved: ${stored}`
            : "No key saved — the app uses the server environment key (if configured)."}
      </p>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="password"
          placeholder="sk-or-v1-…"
          value={value}
          disabled={!loaded || busy}
          autoComplete="off"
          onChange={(e) => {
            setValue(e.target.value);
            setNotice("");
            setError("");
          }}
          style={{ maxWidth: 360 }}
        />
        <button className="btn btn-small" onClick={save} disabled={!loaded || busy || !value.trim()}>
          {busy ? "Saving…" : stored ? "Replace key" : "Save key"}
        </button>
        {stored && (
          <button className="btn btn-small btn-secondary" onClick={clear} disabled={busy}>
            Remove
          </button>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}
      {notice && <p className="banner banner-ok" style={{ marginTop: 10 }}>{notice}</p>}
      {isDemoMode && (
        <p className="page-sub" style={{ marginTop: 8 }}>
          Demo mode: stored in this browser only; the server routes still use their environment key.
        </p>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- Customise
// The admin never sees the underlying system prompts — that would give away the
// app's prompt engineering. This tab only edits a short block of "custom
// instructions" per feature, which the server folds into the hidden base prompt
// (fenced and explicitly lower-priority) at request time. See lib/prompts.ts.

function CustomiseTab() {
  const [feature, setFeature] = useState<AiFeature>("assistant");
  const [drafts, setDrafts] = useState<Record<AiFeature, string>>(
    () => Object.fromEntries(AI_FEATURES.map((f) => [f, ""])) as Record<AiFeature, string>
  );
  // What is actually saved on the server, per feature — used to show the
  // "Customised" dot and to enable/disable the buttons.
  const [saved, setSaved] = useState<Record<AiFeature, string>>(
    () => Object.fromEntries(AI_FEATURES.map((f) => [f, ""])) as Record<AiFeature, string>
  );
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    getAiCustomInstructions().then((custom) => {
      const next = Object.fromEntries(
        AI_FEATURES.map((f) => [f, custom[f] ?? ""])
      ) as Record<AiFeature, string>;
      setDrafts(next);
      setSaved({ ...next });
      setLoaded(true);
    });
  }, []);

  const meta = FEATURE_META[feature];
  const draft = drafts[feature];
  const hasCustom = saved[feature].trim().length > 0;
  const dirty = draft.trim() !== saved[feature].trim();
  const overLimit = draft.length > MAX_CUSTOM_INSTRUCTIONS;

  function selectFeature(next: AiFeature) {
    setFeature(next);
    setError("");
    setNotice("");
  }

  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    const message = await setAiCustomInstructions(feature, draft);
    setBusy(false);
    if (message) {
      setError(message);
      return;
    }
    // Store what we sent (trimmed) so the UI reflects the effective value.
    setSaved((prev) => ({ ...prev, [feature]: draft.trim() }));
    setDrafts((prev) => ({ ...prev, [feature]: draft.trim() }));
    setNotice("Custom instructions saved.");
  }

  async function clear() {
    setBusy(true);
    setError("");
    setNotice("");
    const message = await clearAiCustomInstructions(feature);
    setBusy(false);
    if (message) {
      setError(message);
      return;
    }
    setSaved((prev) => ({ ...prev, [feature]: "" }));
    setDrafts((prev) => ({ ...prev, [feature]: "" }));
    setNotice("Custom instructions cleared — using the built-in behaviour.");
  }

  return (
    <div className="card" style={{ maxWidth: 820 }}>
      <h3>Customise the AI</h3>
      <p className="page-sub">
        Add your own instructions to fine-tune each feature — tone, wording, what to emphasise. These
        are layered on top of the built-in behaviour. They <strong>can’t</strong> change what data the
        AI uses, invent menu items or prices, or override the safety rules, so they’re safe to edit.
      </p>

      <div className="prompt-feature-tabs">
        {AI_FEATURES.map((f) => (
          <button
            key={f}
            className={`chip ${feature === f ? "active" : ""}`}
            onClick={() => selectFeature(f)}
          >
            {FEATURE_META[f].label}
            {saved[f].trim().length > 0 && (
              <span className="chip-dot" title="Customised" aria-hidden="true" />
            )}
          </button>
        ))}
      </div>

      <p className="page-sub" style={{ margin: "14px 0 4px" }}>
        <strong>{meta.label}</strong>{" "}
        <span className={hasCustom ? "prompt-status-custom" : "prompt-status-default"}>
          {hasCustom ? "Customised." : "Using the built-in behaviour."}
        </span>
      </p>
      <p className="page-sub" style={{ margin: "0 0 12px" }}>
        {meta.summary}
      </p>

      <label className="page-sub" style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>
        Custom instructions (optional)
      </label>
      <textarea
        value={draft}
        disabled={!loaded || busy}
        maxLength={MAX_CUSTOM_INSTRUCTIONS + 200}
        placeholder={`e.g. ${meta.examples[0]}`}
        onChange={(e) => {
          setDrafts((prev) => ({ ...prev, [feature]: e.target.value }));
          setNotice("");
          setError("");
        }}
        style={{ minHeight: 150 }}
      />
      <p
        className="page-sub"
        style={{ margin: "4px 0 0", fontSize: 12.5, color: overLimit ? "var(--danger, #c0392b)" : undefined }}
      >
        {draft.length} / {MAX_CUSTOM_INSTRUCTIONS} characters
        {overLimit && " — too long, please shorten"}
      </p>

      <div className="settings-section" style={{ marginTop: 14 }}>
        <p className="page-sub" style={{ margin: "0 0 6px", fontSize: 12.5, fontWeight: 600 }}>
          Ideas
        </p>
        <ul className="page-sub" style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
          {meta.examples.map((ex) => (
            <li key={ex}>{ex}</li>
          ))}
        </ul>
      </div>

      {error && <p className="error-text">{error}</p>}
      {notice && <p className="banner banner-ok" style={{ marginTop: 12 }}>{notice}</p>}

      <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
        <button
          className="btn"
          onClick={save}
          disabled={!loaded || busy || !dirty || overLimit || !draft.trim()}
        >
          {busy ? "Saving…" : "Save instructions"}
        </button>
        <button
          className="btn btn-secondary"
          onClick={clear}
          disabled={!loaded || busy || (!hasCustom && !draft.trim())}
        >
          Clear
        </button>
      </div>
    </div>
  );
}
