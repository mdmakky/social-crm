import * as React from "react";
import type { Member } from "@crm/contracts";

export type InboxCtx = { workspaceId: string; myUserId: string; canReply: boolean; canAssignAny: boolean; canEditLead: boolean; members: Member[] };
export const InboxContext = React.createContext<InboxCtx | null>(null);
export function useInbox(): InboxCtx {
  const v = React.useContext(InboxContext);
  if (!v) throw new Error("useInbox outside InboxShell");
  return v;
}
/** Broadcast so the thread can ask the list to refetch (same pattern as crm-columns). */
export const INBOX_CHANGED = "crm-inbox-changed";
export const notifyInboxChanged = () => window.dispatchEvent(new Event(INBOX_CHANGED));
