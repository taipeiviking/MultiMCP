import React, { useCallback, useEffect, useState } from "react";
import AccountCard from "./AccountCard.jsx";

const api = window.api;

export default function Dashboard({ creds, onChangeCreds }) {
  const [accounts, setAccounts] = useState([]);
  const [claude, setClaude] = useState(null);
  const [newEmail, setNewEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [dbg, setDbg] = useState(null);
  const [autostart, setAutostart] = useState(null); // {enabled, isDev}
  const [logView, setLogView] = useState(null); // { text, path } when viewer open

  async function viewLog() {
    const r = await api.debug?.readLog();
    if (r?.ok) setLogView({ text: r.text, path: r.path });
    else setLogView({ text: "Could not read log: " + (r?.error || "unknown error"), path: dbg?.logPath });
  }

  const refresh = useCallback(async () => {
    const [a, c] = await Promise.all([api.accounts.list(), api.claude.status()]);
    setAccounts(a);
    setClaude(c);
  }, []);

  useEffect(() => {
    api.debug?.get().then(setDbg).catch(() => {});
    api.autostart?.get().then(setAutostart).catch(() => {});
  }, []);

  async function toggleAutostart(e) {
    const res = await api.autostart.set(e.target.checked);
    setAutostart(res);
  }

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
        <button
          className="btn btn--ghost btn--small"
          onClick={() => api.help?.open()}
          title="Open the online help page"
        >
          ? Help
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
        the app runs in the tray and will warn you before an account goes stale.
      </p>

      {autostart && (
        <label className="diag muted small toggle-row">
          <input
            type="checkbox"
            checked={!!autostart.enabled}
            onChange={toggleAutostart}
          />
          <span>
            Start automatically with Windows (runs in the background tray)
            {autostart.isDev && (
              <em className="muted"> — takes effect in the installed app</em>
            )}
          </span>
        </label>
      )}

      {dbg?.logPath && (
        <div className="diag muted small">
          <span>
            Debug log: <code>{dbg.logPath}</code>
          </span>
          <button className="btn btn--small" onClick={viewLog}>
            View log
          </button>
        </div>
      )}

      {logView && (
        <LogViewer
          text={logView.text}
          path={logView.path}
          onRefresh={viewLog}
          onClose={() => setLogView(null)}
        />
      )}

      <div className="diag muted small">
        <span>
          Google OAuth client — one Client ID &amp; Secret shared by all accounts.
        </span>
        <button className="btn btn--small" onClick={onChangeCreds}>
          {creds?._edit ? "Hide credentials" : "Edit credentials"}
        </button>
      </div>
    </div>
  );
}

function LogViewer({ text, path, onRefresh, onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal log-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <strong>Debug log</strong>
          <div className="modal__head-actions">
            <button className="btn btn--small" onClick={onRefresh}>Refresh</button>
            <button className="btn btn--small" onClick={onClose}>Close</button>
          </div>
        </div>
        <pre className="log-modal__body">{text}</pre>
        <div className="modal__foot muted small">
          <code>{path}</code>
        </div>
      </div>
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
      <button
        className={`btn btn--small ${state === "ok" ? "btn--done" : ""}`}
        onClick={onWrite}
        disabled={busy || state === "ok"}
      >
        {busy ? "Writing…" : state === "ok" ? "✓ Done" : "Write config"}
      </button>
    </div>
  );
}
