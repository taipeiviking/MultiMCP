import React, { useState } from "react";

const api = window.api;

// Telegram section. Two ways to provide the my.telegram.org API credentials:
//   guided  — the app fetches api_id/api_hash for you (phone -> web code), then
//             rolls straight into the connector sign-in. Default.
//   manual  — paste api_id/api_hash yourself (fallback if the portal changes).
// Once credentials exist, the connector sign-in is phone -> login code (-> 2FA).
export default function TelegramCard({ status, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { kind, text }
  const [mode, setMode] = useState("guided"); // "guided" | "manual"

  // guided-setup state
  const [gPhone, setGPhone] = useState("");
  const [gStage, setGStage] = useState(null); // null | "code"
  const [gCode, setGCode] = useState("");

  // manual-creds state
  const [apiId, setApiId] = useState("");
  const [apiHash, setApiHash] = useState("");

  // connector sign-in state
  const [phone, setPhone] = useState("");
  const [stage, setStage] = useState(null); // null | "code" | "password"
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");

  if (!status) return null;

  async function run(fn) {
    setBusy(true);
    setMsg(null);
    try {
      return await fn();
    } catch (e) {
      setMsg({ kind: "error", text: String(e?.message || e) });
    } finally {
      setBusy(false);
    }
  }

  // -- guided setup -------------------------------------------------------
  const guidedRequest = () =>
    run(async () => {
      const r = await api.telegram.portalRequestCode(gPhone.trim());
      if (r.codeSent) {
        setGStage("code");
        setMsg({ kind: "info", text: "Telegram sent a login code to your app — enter it below." });
      }
    });

  const guidedComplete = () =>
    run(async () => {
      await api.telegram.portalComplete(gCode.trim());
      // Credentials captured. Prefill the connector sign-in with the same phone.
      setGStage(null);
      setGCode("");
      setPhone(gPhone.trim());
      setMsg({ kind: "info", text: "API credentials set up automatically — now signing in…" });
      onChanged();
      // Chain directly into the connector login (a second code will arrive).
      const s = await api.telegram.startLogin(gPhone.trim());
      if (s.codeSent) {
        setStage("code");
        setMsg({ kind: "info", text: "Setup done. Enter the new login code Telegram just sent." });
      }
    });

  // -- manual creds -------------------------------------------------------
  const saveManual = () =>
    run(async () => {
      await api.telegram.saveCreds(apiId, apiHash);
      setApiId("");
      setApiHash("");
      onChanged();
    });

  // -- connector sign-in --------------------------------------------------
  const sendCode = () =>
    run(async () => {
      const r = await api.telegram.startLogin(phone.trim());
      if (r.codeSent) {
        setStage("code");
        setMsg({ kind: "info", text: "Login code sent — check your Telegram app." });
      }
    });

  const submitCode = () =>
    run(async () => {
      const r = await api.telegram.submitCode(code.trim());
      if (r.needPassword) {
        setStage("password");
        setMsg({ kind: "info", text: "Two-step verification is on — enter your Telegram password." });
      } else if (r.authorized) {
        setStage(null);
        setMsg(null);
        onChanged();
      }
    });

  const submitPassword = () =>
    run(async () => {
      const r = await api.telegram.submitPassword(password);
      setPassword("");
      if (r.authorized) {
        setStage(null);
        setMsg(null);
        onChanged();
      }
    });

  const unlink = () =>
    run(async () => {
      if (!window.confirm("Log out of Telegram on this computer? The AI clients lose access immediately.")) return;
      const r = await api.telegram.unlink();
      if (!r.ok) setMsg({ kind: "error", text: r.error || "Could not unlink." });
      onChanged();
    });

  const meta = status.authorized
    ? "signed in — Telegram history is read live from the server, nothing to collect or import"
    : status.configured
      ? "API credentials ready — sign in with your phone number below"
      : "one-time setup — the app gets your Telegram API credentials for you";

  return (
    <div className="account-card account-card--stack">
      <div className="account-card__row">
        <div className="account-card__main">
          <span className={`status-dot status-dot--${status.authorized ? "ok" : "off"}`} />
          <div>
            <div className="account-card__email">
              {status.authorized ? status.account : "No account linked yet"}
              {status.authorized && <span className="account-label">linked</span>}
            </div>
            <div className="account-card__meta muted">{meta}</div>
            {status.engineError && !stage && <div className="error">{status.engineError}</div>}
            {msg && <div className={msg.kind === "error" ? "error" : "muted small"}>{msg.text}</div>}
          </div>
        </div>
        <div className="account-card__actions">
          {status.authorized && (
            <button className="btn btn--small btn--danger-ghost" onClick={unlink} disabled={busy}>
              Unlink
            </button>
          )}
        </div>
      </div>

      {/* One-time credential setup (only until credentials exist) */}
      {!status.authorized && !status.configured && (
        <div className="tg-setup">
          {mode === "guided" ? (
            <>
              <p className="muted small">
                Enter your Telegram phone number — the app will set up your API access for you
                (Telegram sends a one-time code to confirm it's you).{" "}
                <a href="#" onClick={(e) => { e.preventDefault(); setMode("manual"); }}>
                  Enter credentials manually instead
                </a>
              </p>
              {gStage === null && (
                <div className="tg-setup__row">
                  <input
                    value={gPhone}
                    onChange={(e) => setGPhone(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && gPhone.trim() && guidedRequest()}
                    placeholder="your phone number (e.g. +886912345678)"
                    spellCheck={false}
                  />
                  <button className="btn btn--small btn--primary" onClick={guidedRequest} disabled={busy || !gPhone.trim()}>
                    {busy ? "Working…" : "Set up automatically"}
                  </button>
                </div>
              )}
              {gStage === "code" && (
                <div className="tg-setup__row">
                  <input
                    value={gCode}
                    onChange={(e) => setGCode(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && gCode.trim() && guidedComplete()}
                    placeholder="confirmation code from Telegram"
                    autoFocus
                    spellCheck={false}
                    style={{ width: 240 }}
                  />
                  <button className="btn btn--small btn--primary" onClick={guidedComplete} disabled={busy || !gCode.trim()}>
                    {busy ? "Setting up…" : "Continue"}
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              <p className="muted small">
                Paste the <strong>App api_id</strong> and <strong>App api_hash</strong> from{" "}
                <a href="https://my.telegram.org/apps" target="_blank" rel="noreferrer">my.telegram.org/apps</a>.{" "}
                <a href="#" onClick={(e) => { e.preventDefault(); setMode("guided"); }}>
                  Let the app do it for me
                </a>
              </p>
              <div className="tg-setup__row">
                <input value={apiId} onChange={(e) => setApiId(e.target.value)} placeholder="api_id" spellCheck={false} style={{ width: 140 }} />
                <input value={apiHash} onChange={(e) => setApiHash(e.target.value)} placeholder="api_hash" type="password" spellCheck={false} />
                <button className="btn btn--small btn--primary" onClick={saveManual} disabled={busy || !apiId || !apiHash}>
                  Save
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Connector sign-in (credentials exist, not yet authorized) */}
      {!status.authorized && (status.configured || stage) && (
        <div className="tg-setup">
          {stage === null && (
            <div className="tg-setup__row">
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && phone.trim() && sendCode()}
                placeholder="your phone number (e.g. +886912345678)"
                spellCheck={false}
              />
              <button className="btn btn--small btn--primary" onClick={sendCode} disabled={busy || !phone.trim()}>
                {busy ? "Sending…" : "Send login code"}
              </button>
            </div>
          )}
          {stage === "code" && (
            <div className="tg-setup__row">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && code.trim() && submitCode()}
                placeholder="login code from Telegram"
                autoFocus
                spellCheck={false}
                style={{ width: 200 }}
              />
              <button className="btn btn--small btn--primary" onClick={submitCode} disabled={busy || !code.trim()}>
                {busy ? "Checking…" : "Sign in"}
              </button>
            </div>
          )}
          {stage === "password" && (
            <div className="tg-setup__row">
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && password && submitPassword()}
                placeholder="two-step verification password"
                type="password"
                autoFocus
                style={{ width: 240 }}
              />
              <button className="btn btn--small btn--primary" onClick={submitPassword} disabled={busy || !password}>
                {busy ? "Checking…" : "Verify"}
              </button>
            </div>
          )}
          {status.configured && !stage && (
            <p className="muted small" style={{ marginTop: 8 }}>
              <a href="#" onClick={(e) => { e.preventDefault(); onChanged(); }}>Re-run credential setup</a>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
