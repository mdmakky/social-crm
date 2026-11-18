import type { z } from "zod";
import type { EventPayloads } from "@crm/contracts";
import { registerGenerator } from "./consumer.ts";

type P<T extends keyof typeof EventPayloads> = z.output<(typeof EventPayloads)[T]>;

registerGenerator("contact.owner_assigned", (e, raw) => {
  const p = raw as P<"contact.owner_assigned">;
  if (p.ownerUserId === p.previousOwnerUserId) return [];
  return [{ userId: p.ownerUserId, kind: "contact.owner_assigned", title: `${p.contactName} was assigned to you`, entityType: "contact", entityId: e.entityId, data: { contactName: p.contactName } }];
});

registerGenerator("lead.owner_assigned", (e, raw) => {
  const p = raw as P<"lead.owner_assigned">;
  if (p.ownerUserId === p.previousOwnerUserId) return [];
  return [{ userId: p.ownerUserId, kind: "lead.owner_assigned", title: `${p.leadTitle} was assigned to you`, entityType: "lead", entityId: e.entityId, data: { leadTitle: p.leadTitle } }];
});

registerGenerator("task.assigned", (e, raw) => {
  const p = raw as P<"task.assigned">;
  return [{ userId: p.assigneeUserId, kind: "task.assigned", title: `New task: ${p.title}`, entityType: "task", entityId: e.entityId, data: { title: p.title, contactId: p.contactId ?? null } }];
});

registerGenerator("import.completed", (e, raw) => {
  const p = raw as P<"import.completed">;
  return [{ userId: p.importedByUserId, kind: "import.completed", title: "Your lead import finished", body: `${p.created} created, ${p.updated} updated, ${p.skipped} skipped`, entityType: "import", entityId: e.entityId, data: { created: p.created, updated: p.updated, skipped: p.skipped } }];
});
