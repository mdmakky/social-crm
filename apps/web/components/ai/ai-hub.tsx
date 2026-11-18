"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { formatMicro } from "@/lib/ai-money";
import { useHubStatus } from "./hub-status";

type Tab = { key: string; label: string; path: string; show: boolean };

/**
 * One place for the assistant, its agents, what it knows and the rules that act. A strip answers "is it working, what does it cost, what needs me" before any tab is opened.
 * Tabs are real routes (deep links, back button, per-tab loading) and are hidden for roles that cannot use them.
 */
export function AiHub({ workspaceId, canAi, canWorkflow, children }: { workspaceId: string; canAi: boolean; canWorkflow: boolean; children: React.ReactNode }) {
  const pathname = usePathname();
  const base = `/w/${workspaceId}/settings/ai`;
  const { status, loaded } = useHubStatus(workspaceId, canAi, canWorkflow);
  const tabs: Tab[] = [
    { key: "overview", label: "Overview", path: base, show: canAi || canWorkflow },
    { key: "agents", label: "Agents", path: `${base}/agents`, show: canAi },
    { key: "knowledge", label: "Knowledge", path: `${base}/knowledge`, show: true },
    { key: "automations", label: "Automations", path: `${base}/automations`, show: canWorkflow },
    { key: "setup", label: "Setup", path: `${base}/setup`, show: canAi },
  ];
  const active = tabs.find((t) => (t.path === base ? pathname === base : pathname === t.path || pathname.startsWith(`${t.path}/`)));
  const showStrip = canAi || canWorkflow;
  return (
    <div>
      {showStrip && (
        <Panel aria-label="Status" className="grid grid-cols-2 divide-line-card overflow-hidden sm:grid-cols-4 [&>div]:min-w-0 [&>div]:border-line-card [&>div]:p-4 max-sm:[&>div:nth-child(-n+2)]:border-b max-sm:[&>div:nth-child(odd)]:border-r sm:[&>div:not(:last-child)]:border-r">
          <div><p className="text-xs text-fg-subtle">Provider</p>{!loaded ? <Skeleton className="mt-1 h-5 w-24" /> : canAi && status.provider ? (
            <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-base font-semibold text-fg">{status.provider.label}{status.provider.mock && <Badge tone="warning">MOCK</Badge>}</p>
          ) : <p className="mt-0.5 text-base text-fg-muted">Unavailable</p>}</div>
          <div><p className="text-xs text-fg-subtle">This month</p>{!loaded ? <Skeleton className="mt-1 h-5 w-24" /> : status.usage ? (
            <>
              <p className="mt-0.5 text-base font-semibold tabular-nums text-fg">${formatMicro(status.usage.usedMicro)} <span className="font-normal text-fg-muted">{status.usage.capMicro === null ? "· no limit set" : `of $${formatMicro(status.usage.capMicro)}`}</span></p>
              {status.usage.capMicro !== null && status.usage.capMicro > 0 && <div aria-hidden className="mt-2 h-1.5 overflow-hidden rounded-full bg-hover"><div className="h-full rounded-full bg-accent transition-[width] duration-[var(--dur-slow)]" style={{ width: `${Math.max(1, Math.min(100, (status.usage.usedMicro / status.usage.capMicro) * 100))}%` }} /></div>}
            </>
          ) : <p className="mt-0.5 text-base text-fg-muted">Unavailable</p>}</div>
          <div><p className="text-xs text-fg-subtle">Waiting for you</p>{!loaded ? <Skeleton className="mt-1 h-5 w-24" /> : status.approvals === null ? <p className="mt-0.5 text-base text-fg-muted">Unavailable</p> : status.approvals > 0 ? (
            <p className="mt-0.5"><Badge tone="warning"><span aria-hidden className="size-1.5 rounded-full bg-current" />{status.approvals} {status.approvals === 1 ? "approval" : "approvals"}</Badge></p>
          ) : <p className="mt-0.5"><Badge tone="success">Nothing waiting</Badge></p>}</div>
          <div><p className="text-xs text-fg-subtle">Automations</p>{!loaded ? <Skeleton className="mt-1 h-5 w-24" /> : status.rules ? (
            <p className="mt-0.5 flex flex-wrap items-center gap-1.5">
              {status.rules.killSwitch ? <Badge tone="danger">All paused</Badge> : <Badge tone="success"><span aria-hidden className="size-1.5 rounded-full bg-current" />{status.rules.running} running</Badge>}
              {status.rules.paused > 0 && <Badge tone="neutral">{status.rules.paused} paused</Badge>}
            </p>
          ) : <p className="mt-0.5 text-base text-fg-muted">{canWorkflow ? "Unavailable" : "Owners and admins"}</p>}</div>
        </Panel>
      )}
      <nav ref={(el) => { el?.querySelector<HTMLElement>("[aria-current=page]")?.scrollIntoView({ inline: "center", block: "nearest" }); }} aria-label="AI and automation sections" data-scroll="allowed" className={cn("-mx-1 flex gap-0.5 overflow-x-auto border-b border-line px-1", showStrip ? "mt-5" : "")}>
        {tabs.filter((t) => t.show).map((t) => {
          const on = active?.key === t.key;
          return (
            <Link key={t.key} href={t.path} aria-current={on ? "page" : undefined} className={cn("press relative inline-flex h-10 shrink-0 items-center gap-1.5 px-3 text-base font-medium pointer-coarse:h-11", on ? "text-fg" : "text-fg-subtle hover:text-fg")}>
              {t.label}
              {t.key === "overview" && (status.approvals ?? 0) > 0 && <span className="rounded-full bg-warning-bg px-1.5 text-xs font-semibold tabular-nums text-warning-fg"><span className="sr-only">{status.approvals} waiting: </span><span aria-hidden>{status.approvals}</span></span>}
              <span aria-hidden className={cn("absolute inset-x-3 -bottom-px h-0.5 origin-left rounded bg-accent transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)]", on ? "scale-x-100" : "scale-x-0")} />
            </Link>
          );
        })}
      </nav>
      <div className="mt-5">{children}</div>
    </div>
  );
}
