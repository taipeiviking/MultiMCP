import React, { useEffect, useState, useCallback } from "react";
import CredentialsSetup from "./components/CredentialsSetup.jsx";
import Dashboard from "./components/Dashboard.jsx";

const api = window.api;

export default function App() {
  const [creds, setCreds] = useState(null);
  const [prereqs, setPrereqs] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    // Guard against a boot-time race: when the app autostarts right after login,
    // the very first credentials read can transiently come back empty (Credential
    // Manager not ready yet), which would wrongly show the first-run setup screen.
    // Retry a few times if it looks unconfigured before committing to that view.
    // `needsRecovery` is a definitive answer (settings were lost), not a slow one -
    // retrying it just delays the screen that explains what happened.
    let c = await api.credentials.get();
    for (let i = 0; i < 4 && !c?.needsRecovery && (!c?.clientId || !c?.hasSecret); i++) {
      await new Promise((r) => setTimeout(r, 400));
      c = await api.credentials.get();
    }
    const p = await api.prereqs.check();
    setCreds(c);
    setPrereqs(p);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    api.app
      ?.version()
      .then((v) => {
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
        {/* No version badge here: the OS title bar (document.title above) already
            shows it, and the floating chip overlapped the intro text at narrow
            widths. */}
        <p className="brand__desc">
          Connect multiple Google Workspace accounts to <strong>Claude Desktop</strong> and{" "}
          <strong>OpenAI Codex</strong> — sign in once, and each gets Gmail, Drive &amp;
          Calendar access per account, from the same sign-ins. This app runs the
          diagnostics &amp; authentication backend (<code>workspace-mcp</code>) through{" "}
          <code>uvx</code>; each AI client launches its own copy of that backend, so your
          accounts stay connected without re-signing in every time.
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
