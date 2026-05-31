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
        <PrereqChip prereqs={prereqs} />
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
    </div>
  );
}

function PrereqChip({ prereqs }) {
  const ok = prereqs?.uvx?.ok;
  return (
    <span className={`chip ${ok ? "chip--ok" : "chip--warn"}`} title={prereqs?.uvx?.path || ""}>
      uvx {ok ? "ready" : "missing"}
    </span>
  );
}
