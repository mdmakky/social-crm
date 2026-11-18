import * as React from "react";
import { Globe, Send, X } from "lucide-react";
import { STR, type Lang } from "@/app/widget/[key]/strings";
import "@/app/widget/[key]/widget.css";

export type MockValues = { name: string; color: string; avatar: string; subtitle: string; greeting: string; position: "left" | "right"; quick: string[]; away: boolean; awayText: string; lang: Lang };

const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};

/**
 * A still picture of the visitor chat for the settings page, drawn with the same styles as the real panel (widget.css) so the two cannot drift apart. It is not interactive: nothing in it is a button,
 * and screen readers skip it (the form above it is the accessible way to change the same values). Quick replies shown are the ones typed so far.
 */
export function WidgetMock({ v }: { v: MockValues }) {
  const t = STR[v.lang];
  const hex = /^#[0-9a-fA-F]{6}$/.test(v.color) ? v.color : "#2563eb";
  const on = lum(hex) > 0.4 ? "#111827" : "#ffffff";
  const https = /^https:\/\/\S+$/.test(v.avatar.trim());
  const letter = (v.name.trim().charAt(0) || "C").toUpperCase();
  const mark = (small?: boolean) => <span className={`cw-mark${small ? " sm" : ""}`}>{https ? <img src={v.avatar.trim()} alt="" referrerPolicy="no-referrer" /> : letter}</span>;
  const sub = v.lang === "bn" && v.subtitle === STR.en.defaultSubtitle ? STR.bn.defaultSubtitle : v.subtitle;
  const quick = v.quick.map((q) => q.trim()).filter(Boolean);
  const style = { "--accent": hex, "--on": on, "--chip": on === "#ffffff" ? hex : "#1c1d22", height: v.away ? 470 : 400, borderRadius: 22, border: "1px solid #e4e5ea" } as React.CSSProperties;
  return (
    <div aria-hidden="true" data-testid="widget-mock" className="flex flex-col gap-3" style={{ alignItems: v.position === "left" ? "flex-start" : "flex-end" }}>
      <div className="cw" style={{ ...style, width: "100%", maxWidth: 392 }} lang={v.lang}>
        <div className="cw-top">
          <div className="cw-bar">
            {mark()}
            <div className="cw-who"><h1 style={{ fontSize: 15 }}>{v.name.trim() || "Chat"}</h1><small>{sub}</small></div>
            <span className="cw-ibtn"><Globe size={16} strokeWidth={1.8} /><span>{t.langShort}</span></span>
            <span className="cw-ibtn"><X size={20} strokeWidth={1.9} /></span>
          </div>
          <div className="cw-hero"><div className="cw-heroin">
            <h2>{v.greeting.trim() || t.hi}</h2>
            {quick.length > 0 && <div className="cw-chips">{quick.map((q, i) => <span key={i} style={{ border: "1px solid var(--tint-line)", background: "#fff", color: "var(--chip)", borderRadius: 18, padding: "5px 14px", fontSize: 14, fontWeight: 600 }}>{q}</span>)}</div>}
          </div></div>
        </div>
        <div className="cw-log" />
        {v.away && <div className="cw-away"><span>{v.awayText.trim() || t.away}</span><form onSubmit={(e) => e.preventDefault()}><input tabIndex={-1} placeholder={t.emailPh} readOnly /><span style={{ background: "#1c1d22", color: "#fff", borderRadius: 10, padding: "8px 14px", fontWeight: 600 }}>{t.send}</span></form></div>}
        <div className="cw-composer"><textarea tabIndex={-1} readOnly rows={1} placeholder={t.ph} /><span style={{ width: 40, height: 40, borderRadius: "50%", background: "#d9dbe6", color: "#fff", display: "grid", placeItems: "center" }}><Send size={18} strokeWidth={2} /></span></div>
      </div>
      <div style={{ height: 56, padding: "0 22px 0 9px", borderRadius: 28, border: "1px solid #e4e5ea", background: "#fff", display: "flex", alignItems: "center", gap: 11, font: '650 15px/1 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Bengali",sans-serif', boxShadow: "0 10px 28px -8px rgba(28,29,34,.28)", color: "#1c1d22" }}>
        <span className="cw-mark" style={{ width: 40, height: 40, ["--accent" as string]: hex, ["--on" as string]: on }}>{https ? <img src={v.avatar.trim()} alt="" referrerPolicy="no-referrer" /> : letter}</span>
        <span>{v.lang === "bn" ? "চ্যাট করুন" : "Chat with us"}</span>
      </div>
    </div>
  );
}
