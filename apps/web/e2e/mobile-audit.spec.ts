import { test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { signUpAndCreate } from "./helpers";
import { seed, WEB } from "./channel-helpers";

/**
 * Measurement audit, not an assertion suite: visits every built route at phone, tablet and desktop sizes with touch emulation
 * (so `pointer: coarse` styles apply) and writes /tmp/mobile-audit.json plus screenshots. Run with MOBILE_AUDIT=1.
 */
test.skip(process.env.MOBILE_AUDIT !== "1", "measurement tool: MOBILE_AUDIT=1");

const SIZES = [
  { n: "360", w: 360, h: 740, touch: true },
  { n: "375", w: 375, h: 812, touch: true },
  { n: "390", w: 390, h: 844, touch: true },
  { n: "430", w: 430, h: 932, touch: true },
  { n: "tablet", w: 820, h: 1180, touch: true },
  { n: "desktop", w: 1440, h: 900, touch: false },
] as const;

const measure = (page: Page) =>
  page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const vis = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !el.closest("[aria-hidden=true],[inert]");
    };
    const small = Array.from(document.querySelectorAll<HTMLElement>("a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=tab],[role=menuitem],summary"))
      .filter((el) => vis(el) && !el.closest(".sr-only") && !el.classList.contains("sr-only"))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      // an inline text link inside running text is exempt (WCAG 2.5.8 inline exception); report the rest
      .filter(({ el, r }) => (r.width < 44 || r.height < 44) && !(el.tagName === "A" && el.closest("p,li,dd") && getComputedStyle(el).display === "inline"))
      .map(({ el, r }) => `${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 28)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    const wide = Array.from(document.querySelectorAll("body *")).filter((el) => {
      if (!vis(el) || getComputedStyle(el).position === "fixed") return false;
      if (el.getBoundingClientRect().right <= vw + 0.5) return false;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) if (getComputedStyle(a).overflowX !== "visible") return false;
      return true;
    }).slice(0, 4).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)} right=${Math.round(el.getBoundingClientRect().right)}`);
    const clipped = Array.from(document.querySelectorAll<HTMLElement>("h1,h2,h3,p,span,a,button,label,td,th,dd"))
      .filter((el) => vis(el) && el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow === "hidden" && getComputedStyle(el).textOverflow !== "ellipsis" && el.clientWidth > 0)
      .slice(0, 4).map((el) => `${el.tagName.toLowerCase()} "${(el.textContent || "").trim().slice(0, 24)}" sw=${el.scrollWidth} cw=${el.clientWidth}`);
    const tinyText = Array.from(document.querySelectorAll<HTMLElement>("p,span,a,button,label,td,th,dd,dt,li")).filter((el) => vis(el) && el.childElementCount === 0 && (el.textContent || "").trim().length > 2 && parseFloat(getComputedStyle(el).fontSize) < 12).length;
    return { overflowX: document.documentElement.scrollWidth > vw + 1, scrollW: document.documentElement.scrollWidth, vw, wide, clipped, small, smallCount: small.length, tinyText, fixedBottom: Array.from(document.querySelectorAll("*")).some((el) => { const s = getComputedStyle(el); return s.position === "fixed" && el.getBoundingClientRect().bottom >= innerHeight - 1 && el.getBoundingClientRect().width > innerWidth * 0.6; }) };
  });

test("mobile audit", async ({ browser }) => {
  test.setTimeout(600_000);
  const dir = "/tmp/mobile-audit";
  mkdirSync(dir, { recursive: true });
  const boot = await browser.newContext({ baseURL: WEB });
  const bp = await boot.newPage();
  const { workspaceId: ws } = await signUpAndCreate(bp, "Audit Owner", "Audit Co");
  seed(ws);
  const post = (p: string, data: unknown) => bp.request.post(p, { data, headers: { origin: WEB } });
  const c1 = await (await post(`/v1/workspaces/${ws}/contacts`, { name: "Rahim Uddin Chowdhury", email: "rahim@example.com", phone: "+8801712345678" })).json();
  await post(`/v1/workspaces/${ws}/contacts`, { name: "Nusrat Jahan", email: "nusrat@example.com" });
  const pipes = await (await bp.request.get(`/v1/workspaces/${ws}/pipelines`)).json();
  await post(`/v1/workspaces/${ws}/leads`, { title: "Bulk order for the Eid collection", primaryContactId: c1.id, pipelineId: pipes.pipelines[0].id });
  await post(`/v1/workspaces/${ws}/contacts/${c1.id}/tasks`, { title: "Call Rahim about delivery to Chattogram", dueAt: new Date(Date.now() + 86_400_000).toISOString() });
  const conv = await (await bp.request.get(`/v1/workspaces/${ws}/conversations`)).json();
  const convId = conv.items[0].id as string;
  const state = await boot.storageState();
  await boot.close();

  const routes: [string, string][] = [
    ["home", ""], ["inbox", "/inbox"], ["thread", `/inbox/${convId}`], ["contacts", "/contacts"], ["contact", `/contacts/${c1.id}`], ["import", "/contacts/import"],
    ["leads", "/leads"], ["pipeline", "/pipeline"], ["tasks", "/tasks"], ["reports", "/reports"], ["notifications", "/notifications"], ["integrations", "/integrations"],
    ["members", "/members"], ["audit", "/audit-log"], ["settings", "/settings"], ["set-automations", "/settings/automations"], ["set-contacts", "/settings/contacts"],
    ["set-integrations", "/settings/integrations"], ["set-notifications", "/settings/notifications"], ["set-pipelines", "/settings/pipelines"],
  ];
  const out: Record<string, unknown> = {};
  for (const s of SIZES) {
    const ctx = await browser.newContext({ baseURL: WEB, storageState: state, viewport: { width: s.w, height: s.h }, hasTouch: s.touch, isMobile: s.touch, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    for (const [name, path] of routes) {
      await page.goto(`/w/${ws}${path}`);
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(500);
      out[`${s.n}/${name}`] = await measure(page);
      if (s.n === "390" || (s.n === "desktop" && ["home", "inbox"].includes(name))) await page.screenshot({ path: `${dir}/${s.n}-${name}.png` });
    }
    await ctx.close();
  }
  writeFileSync("/tmp/mobile-audit.json", JSON.stringify(out, null, 1));
});
