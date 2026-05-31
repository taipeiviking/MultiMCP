import React, { useState } from "react";

const api = window.api;

function expiryLabel(account) {
  if (!account.connected) return "not connected";
  if (account.expired) return "expired";
  if (!account.expiry) return "connected";
  const ms = new Date(account.expiry).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  return days > 0 ? `expires in ${days}d ${hours}h` : `expires in ${hours}h`;
}

export default function AccountCard({ account, onChanged }) {
  const [busy, setBusy] = useState(false);
  const status = account.expired ? "expired" : account.connected ? "ok" : "off";

  async function reauth() {
    setBusy(true);
    await api.accounts.authorize(account.email);
    // Sign-in continues in the system browser; user refreshes after.
    setBusy(false);
    onChanged();
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
          <div className="account-card__email">{account.email}</div>
          <div className="account-card__meta muted">{expiryLabel(account)}</div>
        </div>
      </div>
      <div className="account-card__actions">
        <button className="btn btn--small" onClick={reauth} disabled={busy}>
          {busy ? "Opening…" : account.connected ? "Re-auth" : "Sign in"}
        </button>
        <button className="btn btn--small btn--danger-ghost" onClick={remove}>
          Remove
        </button>
      </div>
    </div>
  );
}
