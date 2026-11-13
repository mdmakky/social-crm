"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import type { Role } from "@crm/core/permissions";
import { Tooltip } from "@/components/ui/overlays";
import { cn } from "@/lib/cn";
import { builtNav, href, plannedItems } from "@/lib/nav";

export function SidebarNav({ workspaceId, role, compact, onNavigate }: { workspaceId: string; role: Role; compact?: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const groups = builtNav(role);
  const planned = plannedItems(role);
  return (
    <nav aria-label="Main" className="flex flex-1 flex-col gap-4 overflow-y-auto px-2 py-2">
      {groups.map((g, gi) => (
        <div key={gi} className="flex flex-col gap-0.5">
          {g.label && !compact && groups.filter((x) => x.label).length > 1 && <p className="px-2 pb-1 pt-1 text-2xs font-medium text-fg-subtle">{g.label}</p>}
          {g.label && compact && <div className="mx-2 my-1 h-px bg-line" aria-hidden />}
          {g.items.map((item) => {
            const Icon = item.icon;
            const to = href(workspaceId, item);
            const active = item.path === "" ? pathname === to : pathname === to || pathname.startsWith(`${to}/`);
            const link = (
              <Link
                href={to}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                aria-label={compact ? item.label : undefined}
                className={cn("group flex h-8 items-center gap-2.5 rounded-control px-2 text-base font-medium pointer-coarse:h-11", compact && "justify-center", active ? "bg-selected text-accent-fg" : "text-fg-muted hover:bg-hover hover:text-fg")}
              >
                <Icon className={cn("size-4 shrink-0", active ? "text-accent-fg" : "text-fg-subtle group-hover:text-fg-muted")} />
                {!compact && <span className="truncate">{item.label}</span>}
              </Link>
            );
            return compact ? <Tooltip key={item.key} label={item.label}>{link}</Tooltip> : <div key={item.key}>{link}</div>;
          })}
        </div>
      ))}
      {!compact && planned.length > 0 && (
        <details className="group">
          <summary className="flex h-8 cursor-pointer list-none items-center gap-1 rounded-control px-2 text-xs font-medium text-fg-subtle hover:bg-hover pointer-coarse:h-11 [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
            Coming soon
          </summary>
          <ul className="px-2 pb-1 pt-0.5">
            {planned.map((i) => (
              <li key={i.key} className="flex h-7 items-center gap-2.5 pl-2 text-sm text-fg-subtle">
                <i.icon className="size-4 shrink-0 text-fg-subtle" />
                {i.label}
              </li>
            ))}
          </ul>
        </details>
      )}
    </nav>
  );
}
