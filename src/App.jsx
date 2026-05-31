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
        <div className="topbar__row">
          <p className="brand__desc">
          Connect multiple Google Workspace accounts to Claude Desktop — sign in once,
          and Claude gets Gmail, Drive &amp; Calendar access per account. This app runs
          the diagnostics &amp; authentication backend (<code>workspace-mcp</code>)
          through <code>uvx</code>; Claude Desktop launches the same backend each
          session, so your accounts stay connected without re-signing in every time.
        </p>
        <button
          className="btn btn--ghost btn--small help-btn"
          onClick={() => api.help?.open()}
          title="Open the online help page"
        >
          ? Help
        </button>
        </div>
      </header>

      <main className="content">
        {needsSetup ? (
          <CredentialsSetup creds={creds} onSaved={refresh} />
        ) : (
          <Dashboard creds={creds} prereqs={prereqs} onChangeCreds={() => setCreds({ ...creds, _edit: !creds._edit })} />
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
  return (
    <footer className={`statusbar ${uvxOk ? "statusbar--ok" : "statusbar--warn"}`}>
      <span className={`statusbar__dot ${uvxOk ? "is-ok" : "is-warn"}`} />
      <span className="statusbar__text" title={uvxPath || ""}>
        {uvxOk ? "Engine ready" : "Engine missing — install uv"}
      </span>
    </footer>
  );
}
