import React, { useState } from "react";

const api = window.api;

function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!isFinite(ms) || ms < 0) return "just now";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function expiryLabel(account) {
  if (!account.connected) return "not connected";
  if (!account.hasRefresh) return "needs re-auth (no refresh token)";
  if (account.expired) {
    return account.verifyStatus === "invalid_grant"
      ? "re-auth needed — Google rejected the saved sign-in"
      : "re-auth needed";
  }
  // Alive. Prefer the empirically-verified status over any clock.
  if (account.verifyOk && account.verifiedAt) {
    return `connected ✓ · verified ${timeAgo(account.verifiedAt)}`;
  }
  if (account.productionMode) return "connected ✓";
  if (account.expiry) {
    const ms = new Date(account.expiry).getTime() - Date.now();
    if (ms <= 0) return "re-auth needed";
    const days = Math.floor(ms / 86400000);
    const hours = Math.floor((ms % 86400000) / 3600000);
    const base = days > 0 ? `re-auth in ${days}d ${hours}h` : `re-auth in ${hours}h`;
    return `${base} · Testing mode`;
  }
  return "connected";
}

export default function AccountCard({ account, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { kind: "info"|"error", text, url? }
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState(account.label || "");
  const status = account.expired ? "expired" : account.connected ? "ok" : "off";

  async function saveLabel() {
    setEditingLabel(false);
    const next = labelDraft.trim();
    if (next === (account.label || "")) return; // no change
    await api.accounts.setLabel(account.email, next);
    onChanged();
  }

  async function reauth() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.accounts.authorize(account.email);
      if (res.ok && res.connected) {
        setMsg(null);
      } else if (res.ok && res.pending) {
        setMsg({ kind: "info", text: res.note || "Waiting for sign-in…", url: res.authUrl });
      } else if (!res.ok) {
        setMsg({ kind: "error", text: res.error || "Sign-in failed.", url: res.authUrl });
      }
    } catch (e) {
      setMsg({ kind: "error", text: String(e?.message || e) });
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  async function remove() {
    await api.accounts.remove(account.email);
    onChanged();
  }

  return (
    <div className="account-card">
      <div className="account-card__main">
        <span className={`status-dot status-dot--${status}`} />
        <div>
          <div className="account-card__email">
            {account.email}
            {editingLabel ? (
              <input
                className="account-label-input"
                value={labelDraft}
                autoFocus
                maxLength={40}
                placeholder="e.g. Personal, Work…"
                onChange={(e) => setLabelDraft(e.target.value)}
                onBlur={saveLabel}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveLabel();
                  if (e.key === "Escape") {
                    setLabelDraft(account.label || "");
                    setEditingLabel(false);
                  }
                }}
              />
            ) : account.label ? (
              <button
                className="account-label"
                title="Rename this label — the AI uses it to know which account you mean"
                onClick={() => { setLabelDraft(account.label); setEditingLabel(true); }}
              >
                {account.label}
              </button>
            ) : (
              <button
                className="account-label account-label--add"
                title="Add a label like Personal or Work so the AI knows which account you mean"
                onClick={() => { setLabelDraft(""); setEditingLabel(true); }}
              >
                + label
              </button>
            )}
          </div>
          <div className="account-card__meta muted">{expiryLabel(account)}</div>
          {msg && (
            <div className={`account-card__msg ${msg.kind === "error" ? "error" : "muted small"}`}>
              {msg.text}
              {msg.url && (
                <>
                  {" "}
                  <a href={msg.url} target="_blank" rel="noreferrer">
                    Open sign-in page
                  </a>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="account-card__actions">
        <button className="btn btn--small" onClick={reauth} disabled={busy}>
          {busy ? "Waiting for browser…" : account.connected ? "Re-auth" : "Sign in"}
        </button>
        <button className="btn btn--small btn--danger-ghost" onClick={remove} disabled={busy}>
          Remove
        </button>
      </div>
    </div>
  );
}
