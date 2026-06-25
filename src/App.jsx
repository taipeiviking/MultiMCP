import React, { useEffect, useState, useCallback } from "react";
import CredentialsSetup from "./components/CredentialsSetup.jsx";
import Dashboard from "./components/Dashboard.jsx";

const api = window.api;

export default function App() {
  const [creds, setCreds] = useState(null);
  const [prereqs, setPrereqs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState("");

  const refresh = useCallback(async () => {
    const [c, p] = await Promise.all([api.credentials.get(), api.prereqs.check()]);
    setCreds(c);
    setPrereqs(p);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    api.app
      ?.version()
      .then((v) => {
        setVersion(v);
        // The page's <title> overrides the BrowserWindow title once loaded, so set
        // the document title here to keep the version visible in the OS title bar.
        if (v) document.title = `MultiMCP — Google Workspace Manager  v${v}`;
      })
      .catch(() => {});
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
        {version && <span className="version-badge">v{version}</span>}
        <p className="brand__desc">
          Connect multiple Google Workspace accounts to Claude Desktop — sign in once,
          and Claude gets Gmail, Drive &amp; Calendar access per account. This app runs
          the diagnostics &amp; authentication backend (<code>workspace-mcp</code>)
          through <code>uvx</code>; Claude Desktop launches the same backend each
          session, so your accounts stay connected without re-signing in every time.
        </p>
      </header>

      <main className="content">
        <div className="content__inner">
          {needsSetup ? (
            <CredentialsSetup creds={creds} onSaved={refresh} />
          ) : (
            <Dashboard creds={creds} prereqs={prereqs} onChangeCreds={() => setCreds({ ...creds, _edit: !creds._edit })} />
          )}
          {creds?._edit && (
            <CredentialsSetup creds={creds} onSaved={refresh} editing />
          )}
        </div>
      </main>

      <StatusBar prereqs={prereqs} />
    </div>
  );
}

function StatusBar({ prereqs }) {
  const uvx = prereqs?.uvx || {};
  const uvxOk = !!uvx.ok; // ok === it actually RAN (uvx --version)
  const found = !!uvx.found; // file exists but may not run
  const bundled = !!uvx.bundled;
  const ver = uvx.version ? ` ${uvx.version.replace(/^uvx\s*/i, "v").split(" ")[0]}` : "";
  const label = uvxOk
    ? `Engine ready${bundled ? " (bundled)" : ""}${ver}`
    : found
    ? "Engine found but won't run — see View log"
    : "Engine missing — install uv";
  return (
    <footer className={`statusbar ${uvxOk ? "statusbar--ok" : "statusbar--warn"}`}>
      <span className={`statusbar__dot ${uvxOk ? "is-ok" : "is-warn"}`} />
      <span className="statusbar__text" title={uvx.path || ""}>
        {label}
      </span>
    </footer>
  );
}
