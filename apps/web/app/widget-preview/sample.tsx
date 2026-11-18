"use client";
import * as React from "react";

const FEATURES = [
  { title: "Fast set-up", text: "Pick a plan and start in a few minutes. No long forms." },
  { title: "Friendly help", text: "Real people answer your questions, usually the same day." },
  { title: "Fair prices", text: "One clear price. No surprise fees at the end." },
];

/**
 * The key and the preview grant arrive in the URL fragment (never sent to a server or logged). The page then adds the real loader tag, the same one a customer pastes into their site,
 * plus the grant attribute. Messages from our own settings page: "crm-preview:open" opens the chat. The page answers with "crm-preview:status" once the launcher is there (or is not).
 */
export function Sample() {
  const [ok, setOk] = React.useState<boolean | null>(null);
  const started = React.useRef(false);

  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    const p = new URLSearchParams(window.location.hash.slice(1));
    const key = p.get("key") ?? "";
    const grant = p.get("grant") ?? "";
    const tell = (shown: boolean) => window.parent.postMessage({ type: "crm-preview:status", shown }, window.location.origin);
    const launcher = () => document.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
    if (!key || !grant) { void Promise.resolve().then(() => setOk(false)); tell(false); return; }
    void Promise.resolve().then(() => setOk(true));
    const s = document.createElement("script");
    s.src = "/widget.js";
    s.async = true;
    s.setAttribute("data-widget-key", key);
    s.setAttribute("data-preview-grant", grant);
    document.body.appendChild(s);
    let tries = 0;
    const t = window.setInterval(() => {
      tries += 1;
      if (launcher()) { window.clearInterval(t); tell(true); } else if (tries > 40) { window.clearInterval(t); tell(false); }
    }, 150);
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== window.parent || e.data?.type !== "crm-preview:open") return;
      const b = launcher();
      if (b && b.getAttribute("aria-expanded") === "false") b.click();
    };
    window.addEventListener("message", onMsg);
  }, []);

  return (
    <div className="min-h-dvh bg-white text-[#111827]" style={{ fontSize: 16 }}>
      <header className="border-b border-[#e5e7eb]">
        <p className="bg-[#fef3c7] px-4 py-1.5 text-center text-sm text-[#78350f]">Sample page, not your site</p>
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4">
          <p className="text-lg font-semibold">Sunny Studio</p>
          <nav aria-label="Sample menu" className="flex gap-4 text-sm text-[#374151]">
            <span>Home</span><span>Services</span><span>Contact</span>
          </nav>
        </div>
      </header>
      <main>
        {ok === false && <p role="alert" className="mx-auto max-w-5xl px-4 py-6 text-[#b91c1c]">This page is only used by the preview in settings. Open the preview from Settings, Web chat.</p>}
        <section className="mx-auto max-w-5xl px-4 py-14">
          <h1 className="max-w-xl text-4xl font-semibold leading-tight">Simple help for your home and garden</h1>
          <p className="mt-4 max-w-xl text-[#374151]">Tell us what you need. We plan it, do it, and tidy up. Questions? Use the chat in the corner.</p>
          <span className="mt-6 inline-flex min-h-11 items-center rounded-lg bg-[#111827] px-5 font-medium text-[#ffffff]">Get a free quote</span>
        </section>
        <section aria-labelledby="why" className="mx-auto max-w-5xl px-4 pb-16">
          <h2 id="why" className="text-2xl font-semibold">Why people choose us</h2>
          <ul className="mt-6 grid gap-4 sm:grid-cols-3">
            {FEATURES.map((f) => (
              <li key={f.title} className="rounded-xl border border-[#e5e7eb] p-5">
                <h3 className="font-semibold">{f.title}</h3>
                <p className="mt-2 text-[#374151]">{f.text}</p>
              </li>
            ))}
          </ul>
        </section>
      </main>
      <footer className="border-t border-[#e5e7eb] px-4 py-6 text-center text-sm text-[#4b5563]">Sunny Studio, an invented business. This page only shows how the chat looks.</footer>
    </div>
  );
}
