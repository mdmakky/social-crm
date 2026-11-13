"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Role } from "@crm/core/permissions";
import { Tooltip } from "@/components/ui/overlays";
import { cn } from "@/lib/cn";
import { href, visibleNav } from "@/lib/nav";

export function SidebarNav({ workspaceId, role, compact, onNavigate }: { workspaceId: string; role: Role; compact?: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const groups = visibleNav(role);
  return (
    <nav aria-label="Main" className="flex flex-1 flex-col gap-4 overflow-y-auto px-2 py-2">
      {groups.map((g, gi) => (
        <div key={gi} className="flex flex-col gap-0.5">
          {g.label && !compact && <p className="px-2 pb-1 pt-1 text-2xs font-medium text-fg-subtle">{g.label}</p>}
          {g.label && compact && gi > 0 && <div className="mx-2 my-1 h-px bg-line" aria-hidden />}
          {g.items.map((item) => {
            const Icon = item.icon;
            const base = "group flex h-8 items-center gap-2.5 rounded-md px-2 text-base pointer-coarse:h-11";
            if (item.soon) {
              const body = (
                <span aria-disabled="true" aria-describedby={`soon-${item.key}${compact ? "-rail" : ""}`} className={cn(base, "cursor-not-allowed text-fg-disabled", compact && "justify-center")} tabIndex={0} role="link" aria-label={compact ? `${item.label} (soon)` : undefined}>
                  <Icon className="size-4 shrink-0" />
                  {!compact && <span className="flex-1 truncate">{item.label}</span>}
                  {!compact && <span className="rounded bg-hover px-1 text-2xs font-medium text-fg-subtle">Soon</span>}
                  <span id={`soon-${item.key}${compact ? "-rail" : ""}`} className="sr-only">{item.soon}</span>
                </span>
              );
              return <Tooltip key={item.key} label={`${item.label}: ${item.soon}`}>{body}</Tooltip>;
            }
            const to = href(workspaceId, item);
            const active = item.path === "" ? pathname === to : pathname === to || pathname.startsWith(`${to}/`);
            const link = (
              <Link
                href={to}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                aria-label={compact ? item.label : undefined}
                className={cn(base, "font-medium", compact && "justify-center", active ? "bg-selected text-accent-fg" : "text-fg-muted hover:bg-hover hover:text-fg")}
              >
                <Icon className={cn("size-4 shrink-0", active ? "text-accent-fg" : "text-fg-subtle group-hover:text-fg-muted")} />
                {!compact && <span className="truncate">{item.label}</span>}
              </Link>
            );
            return compact ? <Tooltip key={item.key} label={item.label}>{link}</Tooltip> : <div key={item.key}>{link}</div>;
          })}
        </div>
      ))}
    </nav>
  );
}
