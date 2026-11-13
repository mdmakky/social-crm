"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogOut, Settings } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/overlays";
import { authClient } from "@/lib/auth-client";
import type { ShellUser } from "./types";

export function UserMenu({ user, workspaceId }: { user: ShellUser; workspaceId: string }) {
  const router = useRouter();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Account menu" className="flex size-8 items-center justify-center rounded-full hover:bg-hover data-[state=open]:bg-hover pointer-coarse:size-11">
        <Avatar name={user.name} size="md" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <div className="px-2 py-1.5">
          <p className="truncate text-base font-medium text-fg">{user.name}</p>
          <p className="truncate text-xs text-fg-subtle">{user.email}</p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild><Link href={`/w/${workspaceId}/settings`}><Settings aria-hidden />Settings</Link></DropdownMenuItem>
        <DropdownMenuLabel className="sr-only">Session</DropdownMenuLabel>
        <DropdownMenuItem onSelect={async () => { await authClient.signOut(); router.replace("/login"); }}><LogOut aria-hidden />Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
