"use client";
import Link from "next/link";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/overlays";
import { ROLE_LABEL } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { ShellWorkspace } from "./types";

export function WorkspaceSwitcher({ current, all, compact }: { current: ShellWorkspace; all: ShellWorkspace[]; compact?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={compact ? `Switch workspace, current: ${current.name}` : undefined}
        className={cn("press flex w-full items-center gap-2.5 rounded-xl p-1.5 pointer-coarse:min-h-11 text-left hover:bg-canvas data-[state=open]:bg-canvas", compact && "justify-center")}
      >
        <span aria-hidden data-initials={current.name.trim().slice(0, 2).toUpperCase()} className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent text-[11px] font-bold text-on-accent after:content-[attr(data-initials)]" />
        {!compact && (
          <>
            <span className="min-w-0 flex-1">
              <span className="sr-only">Switch workspace, current: </span>
              <span className="block truncate text-base font-semibold leading-5 text-fg">{current.name}</span>
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {all.map((w) => (
          <DropdownMenuItem key={w.id} asChild>
            <Link href={`/w/${w.id}`} aria-current={w.id === current.id ? "true" : undefined}>
              <Avatar name={w.name} size="xs" className="rounded" />
              <span className="min-w-0 flex-1 truncate">{w.name}</span>
              <span className="text-xs text-fg-subtle">{ROLE_LABEL[w.role]}</span>
              {w.id === current.id && <Check aria-hidden />}
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/onboarding?new=1"><Plus aria-hidden />Create workspace</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
