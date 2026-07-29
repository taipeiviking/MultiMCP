import React, { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

const api = window.api;

// Signal messenger section: one card (one linked account), mirroring the
// account-card look. Linking is Signal's analog of the Google sign-in: instead
// of a browser consent screen, the phone scans a QR code of the sgnl:// link
// URI that the main process gets from `signal-cli link`.
export default function SignalCard({ status, onChanged }) {
  const [linking, setLinking] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [msg, setMsg] = useState(null); // { kind: "info"|"error", text }
  const [busy, setBusy] = useState(false);
  const [capture, setCapture] = useState(null); // background capture status
  const unsubRef = useRef(null);

  // The capture service lives in the main process and changes on its own
  // (reconnects, new messages) — poll it while the card is visible.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const c = await api.signal.captureStatus();
        if (!stop) setCapture(c);
      } catch {
        /* main process busy; try again next tick */
      }
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  // The QR must never outlive the link attempt that produced it.
  useEffect(() => {
    return () => {
      if (unsubRef.current) unsubRef.current();
    };
  }, []);

  if (!status) return null;

  async function startLink() {
    setMsg(null);
    setQrDataUrl(null);
    setLinking(true);
    unsubRef.current = api.signal.onLinkUri(async (uri) => {
      // Rendered locally (the qrcode package) — the URI never leaves the machine.
      const dataUrl = await QRCode.toDataURL(uri, { width: 280, margin: 1 });
      setQrDataUrl(dataUrl);
    });
    try {
      const r = await api.signal.link();
      if (r.ok) {
        setMsg(null);
      } else if (r.timedOut) {
        setMsg({ kind: "error", text: "Timed out waiting for the scan — try again." });
      } else {
        setMsg({ kind: "error", text: r.error || "Linking failed." });
      }
    } catch (e) {
      setMsg({ kind: "error", text: String(e?.message || e) });
    } finally {
      if (unsubRef.current) {
        unsubRef.current();
        unsubRef.current = null;
      }
      setLinking(false);
      setQrDataUrl(null);
      onChanged();
    }
  }

  async function cancelLink() {
    await api.signal.cancelLink();
    setLinking(false);
    setQrDataUrl(null);
  }

  async function unlink() {
    if (
      !window.confirm(
        "Unlink Signal from this computer? The AI clients lose access immediately. " +
          "(You should also remove “MultiMCP” on your phone under Signal → Settings → Linked devices.)"
      )
    ) {
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.signal.unlink();
      if (!r.ok) setMsg({ kind: "error", text: r.error || "Could not unlink." });
      else if (r.note) setMsg({ kind: "info", text: r.note });
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  if (!status.engine?.ok) {
    return (
      <div className="claude-strip claude-strip--absent">
        <span className="muted small">
          <strong>Signal messenger</strong> — the Signal engine isn't bundled in this build
          {import.meta.env.DEV ? " (dev: run “npm run fetch-signal” and restart)" : ""}, so
          there's nothing to set up here.
        </span>
      </div>
    );
  }

  return (
    <>
      <div className="account-card">
        <div className="account-card__main">
          <span className={`status-dot status-dot--${status.linked ? "ok" : "off"}`} />
          <div>
            <div className="account-card__email">
              {status.linked ? status.account : "No account linked yet"}
              {status.linked && <span className="account-label">linked</span>}
            </div>
            <div className="account-card__meta muted">
              {status.linked
                ? "this computer is a companion device of your phone — write the client configs below to use it"
                : "connect your Signal account by scanning a QR code with your phone"}
            </div>
            {msg && (
              <div className={`account-card__msg ${msg.kind === "error" ? "error" : "muted small"}`}>
                {msg.text}
              </div>
            )}
          </div>
        </div>
        <div className="account-card__actions">
          {status.linked ? (
            <button className="btn btn--small btn--danger-ghost" onClick={unlink} disabled={busy}>
              Unlink
            </button>
          ) : (
            <button className="btn btn--small" onClick={startLink} disabled={linking}>
              {linking ? "Waiting for scan…" : "Link with your phone…"}
            </button>
          )}
        </div>
      </div>

      {status.linked && capture && (
        <div className="capture-box">
          <div className="capture-box__head">
            <span className={`status-dot status-dot--${capture.subscribed ? "ok" : "off"}`} />
            <span className="small">
              Background message collector{" "}
              {capture.subscribed
                ? "— listening (runs in the tray, no window)"
                : capture.connected
                  ? "— connecting…"
                  : "— starting the engine…"}
            </span>
            <span className="muted small capture-box__stats">
              {capture.storedMessages} message{capture.storedMessages === 1 ? "" : "s"} stored
              {capture.lastMessageAt
                ? ` · last ${new Date(capture.lastMessageAt).toLocaleString()}`
                : ""}
            </span>
          </div>
          {capture.activity?.length > 0 && (
            <pre className="capture-box__log">{capture.activity.join("\n")}</pre>
          )}
          <p className="muted small capture-box__note">
            Signal keeps no history on its servers, so messages are collected as they arrive —
            whenever this tray app is running, even with no AI chat open.
          </p>
        </div>
      )}

      {linking && (
        <div className="modal-overlay" onClick={cancelLink}>
          <div className="modal qr-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal__head">
              <strong>Link Signal</strong>
              <div className="modal__head-actions">
                <button className="btn btn--small" onClick={cancelLink}>
                  Cancel
                </button>
              </div>
            </div>
            <div className="qr-modal__body">
              {qrDataUrl ? (
                <img className="qr-modal__code" src={qrDataUrl} alt="Signal link QR code" />
              ) : (
                <p className="muted">Preparing the link code…</p>
              )}
              <ol className="muted small qr-modal__steps">
                <li>Open Signal on your phone</li>
                <li>
                  Go to <strong>Settings → Linked devices</strong>
                </li>
                <li>
                  Tap <strong>Link new device</strong> and scan this code
                </li>
              </ol>
              <p className="muted small">
                This computer becomes a companion device named “MultiMCP”. Your phone stays the
                primary device, and you can unlink at any time — here or on the phone.
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
