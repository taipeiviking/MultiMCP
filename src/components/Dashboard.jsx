import React, { useCallback, useEffect, useState } from "react";
import AccountCard from "./AccountCard.jsx";
import ImportSettings from "./ImportSettings.jsx";

const api = window.api;

export default function Dashboard({ creds, onChangeCreds }) {
  const [accounts, setAccounts] = useState([]);
  const [claude, setClaude] = useState(null);
  const [codex, setCodex] = useState(null);
  const [codexErr, setCodexErr] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [dbg, setDbg] = useState(null);
  const [autostart, setAutostart] = useState(null); // {enabled, isDev}
  const [logView, setLogView] = useState(null); // { text, path } when viewer open
  const [backupMsg, setBackupMsg] = useState(null); // { kind, text } (export only)
  const [prefs, setPrefs] = useState(null); // { productionMode, productionModeSource }
  const [checking, setChecking] = useState(false);

  async function viewLog() {
    const r = await api.debug?.readLog();
    if (r?.ok) setLogView({ text: r.text, path: r.path });
    else setLogView({ text: "Could not read log: " + (r?.error || "unknown error"), path: dbg?.logPath });
  }

  const refresh = useCallback(async () => {
    const [a, c, x] = await Promise.all([
      api.accounts.list(),
      api.claude.status(),
      api.codex?.status().catch(() => null),
    ]);
    setAccounts(a);
    setClaude(c);
    setCodex(x);
  }, []);

  useEffect(() => {
    api.debug?.get().then(setDbg).catch(() => {});
    api.autostart?.get().then(setAutostart).catch(() => {});
    api.prefs?.get().then(setPrefs).catch(() => {});
  }, []);

  async function toggleAutostart(e) {
    const res = await api.autostart.set(e.target.checked);
    setAutostart(res);
  }

  async function checkNow() {
    setChecking(true);
    try {
      const a = await api.accounts.verify();
      if (Array.isArray(a)) setAccounts(a);
    } catch {
      /* leave prior status in place */
    } finally {
      setChecking(false);
    }
    refresh();
  }

  async function toggleProduction(e) {
    const res = await api.prefs.set(e.target.checked);
    setPrefs(res);
    // Re-verify so the labels switch to the new mode immediately.
    checkNow();
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

  async function writeCodex() {
    setBusy(true);
    setCodexErr("");
    // Unlike Claude's JSON config, this one edits a TOML file the user (and the
    // Codex app itself) also write to. The service refuses rather than guesses, so
    // surface the refusal instead of silently doing nothing.
    const r = await api.codex.write();
    if (r && r.ok === false) setCodexErr(r.error || "Could not write the Codex config.");
    await refresh();
    setBusy(false);
  }

  async function exportSettings() {
    setBackupMsg(null);
    const r = await api.backup?.export();
    if (r?.ok) {
      const c = r.counts || {};
      setBackupMsg({
        kind: "ok",
        text: `Exported ${c.accounts || 0} account(s)${c.hasSecret ? " + client secret" : ""} to ${r.path}`,
      });
    } else if (!r?.canceled) {
      setBackupMsg({ kind: "err", text: "Export failed: " + (r?.error || "unknown error") });
    }
  }

  async function afterImport() {
    // Already on the dashboard (creds exist); just re-read accounts/tokens.
    await refresh();
  }

  return (
    <div className="dash">
      <div className="dash__head">
        <h1>Accounts</h1>
        <div className="modal__head-actions">
          <button
            className="btn btn--ghost btn--small"
            onClick={checkNow}
            disabled={checking}
            title="Verify every account's sign-in against Google right now"
          >
            {checking ? "Checking…" : "Check now"}
          </button>
          <button
            className="btn btn--ghost btn--small"
            onClick={() => api.help?.open()}
            title="Open the online help page"
          >
            ? Help
          </button>
        </div>
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
      <CodexStrip codex={codex} busy={busy} err={codexErr} onWrite={writeCodex} />

      {prefs?.productionMode ? (
        <p className="muted small note">
          Production mode: sign-ins don’t expire on a 7-day clock. The app verifies each
          account against Google (on launch, every 6h, and via “Check now”) and warns you
          only if a sign-in is actually revoked or fails.
        </p>
      ) : (
        <p className="muted small note">
          Heads-up: while the Google app is in “Testing”, tokens expire about every 7 days.
          The app verifies each account against Google and counts down only until then —
          tick the box below once your OAuth consent screen is published to production.
        </p>
      )}

      <label className="diag muted small toggle-row">
        <input
          type="checkbox"
          checked={!!prefs?.productionMode}
          onChange={toggleProduction}
        />
        <span>
          OAuth app published to “In production” (no 7-day token expiry)
          {prefs?.productionModeSource === "auto" && (
            <em className="muted"> — detected automatically</em>
          )}
        </span>
      </label>

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

      <div className="diag muted small">
        <span>
          Move this setup to another computer — export everything (Client ID &amp;
          Secret, accounts, and sign-in tokens) to a file, then import it there.
        </span>
        <div className="modal__head-actions">
          <button className="btn btn--small" onClick={exportSettings}>
            Export settings…
          </button>
          <ImportSettings onImported={afterImport} />
        </div>
      </div>

      {backupMsg && (
        <p className={`small ${backupMsg.kind === "err" ? "backup-msg--err" : "backup-msg--ok"}`}>
          {backupMsg.text}
        </p>
      )}
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

// The same connector, offered to OpenAI Codex. Codex runs the identical server as a
// separate process of its own, so it needs its own port (9001) - that is handled in
// the service, not here.
//
// If Codex isn't installed we still show the row, but as a quiet explanation rather
// than a dead button: most people have never heard of Codex, and a greyed-out control
// with no reason attached just looks broken.
function CodexStrip({ codex, busy, err, onWrite }) {
  if (!codex) return null;

  if (!codex.installed) {
    return (
      <div className="claude-strip claude-strip--absent">
        <span className="muted small">
          <strong>OpenAI Codex</strong> isn't installed — nothing to do here. If you install it
          later, come back and you can add the same accounts to it in one click.
        </span>
      </div>
    );
  }

  const state = codex.inSync ? "ok" : codex.present ? "stale" : "missing";
  const label = codex.error
    ? `Codex config: ${codex.error}`
    : state === "ok"
      ? "Codex config in sync"
      : state === "stale"
        ? "Codex config out of date"
        : "Codex config not written yet";

  return (
    <>
      <div className={`claude-strip claude-strip--${state}`}>
        <span>{label}</span>
        <button
          className={`btn btn--small ${state === "ok" ? "btn--done" : ""}`}
          onClick={onWrite}
          disabled={busy || state === "ok" || !!codex.error}
        >
          {busy ? "Writing…" : state === "ok" ? "✓ Done" : "Write Codex config"}
        </button>
      </div>
      {err && <div className="error">{err}</div>}
    </>
  );
}
