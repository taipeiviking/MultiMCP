import React, { useCallback, useEffect, useState } from "react";
import AccountCard from "./AccountCard.jsx";

const api = window.api;

export default function Dashboard({ creds, onChangeCreds }) {
  const [accounts, setAccounts] = useState([]);
  const [claude, setClaude] = useState(null);
  const [newEmail, setNewEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [dbg, setDbg] = useState(null);

  const refresh = useCallback(async () => {
    const [a, c] = await Promise.all([api.accounts.list(), api.claude.status()]);
    setAccounts(a);
    setClaude(c);
  }, []);

  useEffect(() => {
    api.debug?.get().then(setDbg).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function addAccount() {
    if (!newEmail.trim()) return;
    await api.accounts.add(newEmail.trim());
    setNewEmail("");
    refresh();
  }

  async function writeClaude() {
    setBusy(true);
    await api.claude.write();
    await refresh();
    setBusy(false);
  }

  return (
    <div className="dash">
      <div className="dash__head">
        <h1>Accounts</h1>
        <button className="btn btn--ghost" onClick={onChangeCreds}>
          Credentials
        </button>
      </div>

      <div className="add-row">
        <input
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addAccount()}
          placeholder="add account email (e.g. you@yourdomain.com)"
          spellCheck={false}
        />
        <button className="btn btn--primary" onClick={addAccount}>
          Add
        </button>
      </div>

      <div className="account-list">
        {accounts.length === 0 && (
          <p className="muted">No accounts yet. Add up to all your Workspace addresses above.</p>
        )}
        {accounts.map((acc) => (
          <AccountCard key={acc.email} account={acc} onChanged={refresh} />
        ))}
      </div>

      <ClaudeStrip claude={claude} busy={busy} onWrite={writeClaude} />

      <p className="muted small note">
        Heads-up: while the Google app is in “Testing”, tokens expire about every 7 days —
        just hit Re-auth when an account goes stale.
      </p>

      {dbg?.logPath && (
        <div className="diag muted small">
          <span>
            Debug log: <code>{dbg.logPath}</code>
          </span>
          <button className="btn btn--small" onClick={() => api.debug.revealLog()}>
            Reveal log
          </button>
        </div>
      )}
    </div>
  );
}

function ClaudeStrip({ claude, busy, onWrite }) {
  if (!claude) return null;
  const state = claude.inSync ? "ok" : claude.present ? "stale" : "missing";
  const label =
    state === "ok"
      ? "Claude Desktop config in sync"
      : state === "stale"
      ? "Claude Desktop config out of date"
      : "Claude Desktop config not written yet";
  return (
    <div className={`claude-strip claude-strip--${state}`}>
      <span>{label}</span>
      <button className="btn btn--small" onClick={onWrite} disabled={busy || state === "ok"}>
        {busy ? "Writing…" : "Write config"}
      </button>
    </div>
  );
}
