"use client";

import { useEffect, useState } from "react";

interface DemoState {
  userId: string;
  proAccess: boolean | null;
  stripeStatus: string | null;
  source: string;
}

const DEMO_USER_ID = "paypath-test-demo-user";

export default function HomePage() {
  const [state, setState] = useState<DemoState | null>(null);
  const [message, setMessage] = useState("Loading entitlement state…");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setMessage("Loading entitlement state…");
    try {
      const response = await fetch("/api/entitlement", {
        cache: "no-store",
      });
      const result = (await response.json()) as DemoState & { error?: string };
      if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status}).`);
      setState(result);
      setMessage("State loaded from the demo application's authorization endpoint.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to load state.");
    }
  }

  async function startCheckout() {
    setBusy(true);
    setMessage("Creating a Stripe Test Mode Checkout Session…");
    try {
      const response = await fetch("/api/checkout", { method: "POST" });
      const result = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || result.url === undefined) throw new Error(result.error ?? "Checkout is not configured.");
      window.location.assign(result.url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to start checkout.");
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <main className="shell">
      <section className="card">
        <p className="eyebrow">PAYPATH CI · PROOF OF VALUE</p>
        <h1>Subscription demo</h1>
        <p className="intro">
          This small SaaS grants Pro access from signed Stripe subscription webhooks. PayPath checks the billing,
          persisted entitlement, and the authorization outcome together.
        </p>
        <div className="state-grid">
          <div><span>Test user</span><strong>{state?.userId ?? DEMO_USER_ID}</strong></div>
          <div><span>Stripe subscription</span><strong>{state?.stripeStatus ?? "Not linked"}</strong></div>
          <div><span>Pro authorization</span><strong className={state?.proAccess ? "good" : "muted"}>{state?.proAccess === null || state === null ? "Unknown" : state.proAccess ? "Granted" : "Not granted"}</strong></div>
          <div><span>Persistence</span><strong>{state?.source ?? "Checking…"}</strong></div>
        </div>
        <div className="actions">
          <button onClick={startCheckout} disabled={busy}>Start test subscription</button>
          <button className="secondary" onClick={() => void refresh()} disabled={busy}>Refresh state</button>
        </div>
        <p className="message" role="status">{message}</p>
        <p className="footnote">Use Stripe test cards only. A local in-memory store resets when the server restarts; configure the dedicated Supabase test database for persistence.</p>
      </section>
    </main>
  );
}
