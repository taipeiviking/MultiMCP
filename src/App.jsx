import React, { useEffect, useState, useCallback } from "react";
import CredentialsSetup from "./components/CredentialsSetup.jsx";
import Dashboard from "./components/Dashboard.jsx";

const api = window.api;

export default function App() {
  const [creds, setCreds] = useState(null);
  const [prereqs, setPrereqs] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [c, p] = await Promise.all([api.credentials.get(), api.prereqs.check()]);
    setCreds(c);
    setPrereqs(p);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (loading) {
    return (
      <div className="app shell--center">
        <div className="spinner" /> <span className="muted">Loading…</span>
      </div>
    );
  }

  const needsSetup = !creds?.clientId || !creds?.hasSecret;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__dot" />
          <div className="brand__text">
            <span className="brand__name">MultiMCP — Google Workspace Manager</span>
            <span className="brand__tagline">
              Connect multiple Google Workspace accounts to Claude Desktop — sign in
              once, and Claude gets Gmail, Drive &amp; Calendar access per account.
            </span>
          </div>
        </div>
      </header>

      <main className="content">
        {needsSetup ? (
          <CredentialsSetup creds={creds} onSaved={refresh} />
        ) : (
          <Dashboard creds={creds} prereqs={prereqs} onChangeCreds={() => setCreds({ ...creds, _edit: true })} />
        )}
        {creds?._edit && (
          <CredentialsSetup creds={creds} onSaved={refresh} editing />
        )}
      </main>

      <StatusBar prereqs={prereqs} />
    </div>
  );
}

function StatusBar({ prereqs }) {
  const uvxOk = !!prereqs?.uvx?.ok;
  const uvxPath = prereqs?.uvx?.path;
  const pyOk = !!prereqs?.python?.ok;
  const installHint = prereqs?.installHint;

  return (
    <footer className={`statusbar ${uvxOk ? "statusbar--ok" : "statusbar--warn"}`}>
      <span className={`statusbar__dot ${uvxOk ? "is-ok" : "is-warn"}`} />
      {uvxOk ? (
        <span className="statusbar__text">
          <strong>Engine ready.</strong> This app runs the diagnostics/auth backend
          (<code>workspace-mcp</code>) through <code>uvx</code>
          {uvxPath ? (
            <> — found at <code>{uvxPath}</code></>
          ) : null}
          . Claude Desktop launches the same backend per session, so your accounts
          stay connected{pyOk ? " (Python detected)" : ""}.
        </span>
      ) : (
        <span className="statusbar__text">
          <strong>Engine missing.</strong> <code>uvx</code> (from{" "}
          <code>uv</code>) is required to sign in accounts and run the backend.
          Install it, then reopen this app:{" "}
          <code className="statusbar__cmd">{installHint || "irm https://astral.sh/uv/install.ps1 | iex"}</code>
        </span>
      )}
    </footer>
  );
}
