"use client";

import { useEffect, useRef, useState } from "react";

const SESSION_URL = "https://chatgpt.com/api/auth/session";

type ExtractResponse = {
  ok: boolean;
  message?: string;
  data?: {
    qrImageUrl: string;
    upiUri: string;
    paymentUrl: string;
    expiresAt: string;
    checkoutSessionId: string;
    processorEntity: string;
    createdAt: string;
  };
};

type ExtractResult = NonNullable<ExtractResponse["data"]>;

function QrIcon() {
  return (
    <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <path d="M7 7h13v13H7V7Zm21 0h13v13H28V7ZM7 28h13v13H7V28Z" stroke="currentColor" strokeWidth="3.4" strokeLinejoin="round" />
      <path d="M30 29h4v4h-4v-4Zm8 0h3v11H30v-3h8v-8Zm-14 7h4v5h-4v-5Z" fill="currentColor" />
      <path d="M12 12h3v3h-3v-3Zm21 0h3v3h-3v-3ZM12 33h3v3h-3v-3Z" fill="currentColor" />
    </svg>
  );
}

function formatRemainingTime(expiresAt?: string, now = Date.now()) {
  if (!expiresAt) return "";
  const ms = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return "QR code expired";
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `Expires in ~${minutes}:${String(seconds).padStart(2, "0")}`;
}

function getFriendlyError(message: string) {
  const text = message || "Extraction failed. Please try again.";
  if (text.includes("BillingCountryLockedError") || text.toLowerCase().includes("billing country")) {
    return "Account region locked by OpenAI – cannot change billing address.";
  }
  return text.replace(/^Error:\s*/i, "").replace(/^(UpiQrUnavailableError|BillingCountryLockedError):\s*/i, "");
}

export function ExtractorClient() {
  const [credential, setCredential] = useState("");
  const [result, setResult] = useState<ExtractResult | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<"session" | "upi" | "payment" | "">("");
  const [isLoading, setIsLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const credentialRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!result?.expiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [result?.expiresAt]);

  async function copyText(value: string, target: "session" | "upi" | "payment") {
    await navigator.clipboard.writeText(value);
    setCopied(target);
    window.setTimeout(() => setCopied(""), 1400);
  }

  async function submit() {
    const value = (credential || credentialRef.current?.value || "").trim();
    if (isLoading) return;
    if (!value) {
      setError("Please enter session token / cookie / session JSON.");
      return;
    }
    setIsLoading(true);
    setError("");
    setResult(null);

    try {
      const response = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionToken: value }),
      });
      const contentType = response.headers.get("content-type") || "";
      const payload = contentType.includes("application/json")
        ? ((await response.json()) as ExtractResponse)
        : ({ ok: false, message: `Server returned non-JSON (HTTP ${response.status}).` } satisfies ExtractResponse);

      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.message || `Extraction failed (HTTP ${response.status}).`);
      }

      setResult(payload.data);
      setCredential("");
      setNow(Date.now());
    } catch (err) {
      setError(getFriendlyError(err instanceof Error ? err.message : String(err)));
    } finally {
      setIsLoading(false);
    }
  }

  function reset() {
    setResult(null);
    setError("");
    setCopied("");
  }

  return (
    <main className="page-shell">
      <div className="extractor-wrap">
        <section className="hero" aria-labelledby="page-title">
          <div className="brand-mark"><QrIcon /></div>
          <h1 id="page-title">UPI QR Extractor</h1>
          <p className="hero-subtitle">
            Paste your ChatGPT session token / cookie / session JSON – the server generates a UPI QR code and returns the ChatGPT payment link.
          </p>
        </section>

        <section className="panel extractor-card">
          {result ? (
            <div className="result-view">
              <div className="qr-shell">
                <div className="qr-frame">
                  <img src={result.qrImageUrl} alt="UPI QR Code" />
                </div>
                <div className="expire-pill">{formatRemainingTime(result.expiresAt, now)}</div>
                <button className="btn btn-primary" type="button" onClick={reset}>Extract New UPI Link</button>
              </div>

              <div className="result-copy">
                <div className="result-title">
                  <h2>Extraction Successful</h2>
                  <p>Use the QR code or payment link immediately. UPI QR codes typically expire within minutes – re‑extract if expired.</p>
                </div>

                <div className="message success">QR code generated. Payment link and UPI URI are below.</div>

                <div className="field-block">
                  <label>ChatGPT Payment Link</label>
                  <div className="copy-row">
                    <input className="url-input" readOnly value={result.paymentUrl} onFocus={(event) => event.currentTarget.select()} />
                    <button className="btn btn-soft" type="button" onClick={() => copyText(result.paymentUrl, "payment")}>{copied === "payment" ? "Copied" : "Copy"}</button>
                  </div>
                </div>

                <div className="field-block">
                  <label>UPI URI</label>
                  <div className="copy-row">
                    <input className="url-input" readOnly value={result.upiUri} onFocus={(event) => event.currentTarget.select()} />
                    <button className="btn btn-soft" type="button" onClick={() => copyText(result.upiUri, "upi")}>{copied === "upi" ? "Copied" : "Copy"}</button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="instructions">
                <h2>How to Get Your Session Token</h2>
                <ol className="steps">
                  <li className="step"><span className="step-index">1</span><span>Open <a href="https://chatgpt.com/" target="_blank" rel="noreferrer">chatgpt.com</a> in your browser and log in to the account you want to extract.</span></li>
                  <li className="step"><span className="step-index">2</span><span>Open the session page, copy the entire JSON content shown, and paste it below.</span></li>
                </ol>
                <div className="copy-row">
                  <span className="copy-url">{SESSION_URL}</span>
                  <button className="btn btn-soft" type="button" onClick={() => copyText(SESSION_URL, "session")}>{copied === "session" ? "Copied" : "Copy URL"}</button>
                </div>
              </div>

              <div className="form-area">
                <label className="form-label" htmlFor="credential">
                  <span>Session Token / Cookie / Session JSON</span>
                  <span className="form-hint">Not stored on the server</span>
                </label>
                <textarea
                  id="credential"
                  className="token-input"
                  value={credential}
                  ref={credentialRef}
                  onChange={(event) => setCredential(event.currentTarget.value)}
                  onInput={(event) => setCredential(event.currentTarget.value)}
                  placeholder="Paste the JSON from https://chatgpt.com/api/auth/session, or your browser cookie / session token"
                  spellCheck={false}
                  disabled={isLoading}
                />

                {error ? <div className="message error" role="alert">{error}</div> : null}

                <div className="actions">
                  <div className="privacy-note">The server uses your credential only for this request – no database, no persistent storage.</div>
                  <button className="btn btn-primary" type="button" onClick={submit} disabled={isLoading}>
                    {isLoading ? <span className="spinner" aria-hidden="true" /> : null}
                    {isLoading ? "Extracting..." : "Extract UPI QR Code"}
                  </button>
                </div>
              </div>
            </>
          )}
        </section>

        <p className="footer-note">
          Proxies are configured via server environment variables – the source code does not contain any hardcoded proxy addresses.
        </p>
      </div>
    </main>
  );
}
