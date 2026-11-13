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
    <nav aria-label="Main" className={cn("flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-2", compact && "items-center px-2")}>
      {groups.map((g, gi) => (
        <div key={gi} className={cn("flex flex-col gap-px", compact && "w-full")}>
          {g.label && !compact && groups.filter((x) => x.label).length > 1 && <p className="px-2.5 pb-1 pt-3 text-xs font-semibold text-fg-subtle">{g.label}</p>}
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
                // Selected = a white pill on the canvas with a hairline; hover = a soft wash. The accent appears only on the icon.
                className={cn("press group flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-base font-medium pointer-coarse:h-11 active:scale-[0.985]", compact && "justify-center px-0", active ? "bg-hover text-fg" : "text-fg-muted hover:bg-canvas hover:text-fg")}
              >
                <Icon className={cn("size-4 shrink-0 stroke-[1.75] transition-colors duration-[var(--dur-fast)]", active ? "text-accent" : "text-fg-subtle group-hover:text-fg-muted")} />
                {!compact && <span className="truncate">{item.label}</span>}
              </Link>
            );
            return compact ? <Tooltip key={item.key} label={item.label}>{link}</Tooltip> : <div key={item.key}>{link}</div>;
          })}
        </div>
      ))}
      {!compact && planned.length > 0 && (
        <details className="group">
          <summary className="press flex h-8 cursor-pointer list-none items-center gap-1 rounded-lg px-3 text-xs font-semibold text-fg-subtle hover:bg-canvas pointer-coarse:h-11 [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 transition-transform duration-[var(--dur-base)] group-open:rotate-90" aria-hidden />
            Coming soon
          </summary>
          <ul className="px-2 pb-1 pt-0.5">
            {planned.map((i) => (
              <li key={i.key} className="flex h-7 items-center gap-2 pl-2 text-sm text-fg-subtle">
                <i.icon className="size-4 shrink-0 stroke-[1.75]" />
                {i.label}
              </li>
            ))}
          </ul>
        </details>
      )}
    </nav>
  );
}
