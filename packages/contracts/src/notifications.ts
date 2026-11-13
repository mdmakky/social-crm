import { z } from "zod";
import { endpoint } from "./endpoint.ts";

/** Notification kinds shipped now. A new kind = add it here + register a generator in apps/api/src/notifications/generators.ts. */
export const NOTIFICATION_KINDS = {
  "contact.owner_assigned": { label: "Contact assigned to you", description: "Someone makes you the owner of a contact." },
  "lead.owner_assigned": { label: "Lead assigned to you", description: "Someone makes you the owner of a lead." },
  "task.assigned": { label: "Task assigned to you", description: "Someone assigns a task to you." },
  "import.completed": { label: "Import finished", description: "A contact import you started has completed." },
} as const;
export type NotificationKind = keyof typeof NOTIFICATION_KINDS;
export const NotificationKindSchema = z.enum(Object.keys(NOTIFICATION_KINDS) as [NotificationKind, ...NotificationKind[]]);

/**
 * Domain event payloads the notification generators consume. The emitting code (contacts, tasks, imports routes)
 * must call emitEvent inside its own transaction with exactly these shapes; see docs/architecture/notifications.md.
 */
export const EventPayloads = {
  "contact.owner_assigned": z.object({ ownerUserId: z.string(), previousOwnerUserId: z.string().nullable().optional(), contactName: z.string() }),
  "lead.owner_assigned": z.object({ ownerUserId: z.string(), previousOwnerUserId: z.string().nullable().optional(), leadTitle: z.string() }),
  "task.assigned": z.object({ assigneeUserId: z.string(), title: z.string(), contactId: z.string().uuid().nullable().optional() }),
  "import.completed": z.object({ importedByUserId: z.string(), created: z.number().int(), updated: z.number().int(), skipped: z.number().int(), failed: z.number().int().optional() }),
} as const satisfies Record<NotificationKind, z.ZodType>;

const uuid = z.string().uuid();
export const NotificationDto = z.object({
  id: uuid,
  kind: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  readAt: z.string().nullable(),
});
export type NotificationDto = z.infer<typeof NotificationDto>;

export const NotificationListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: uuid.optional(),
  unread: z.enum(["true", "false"]).optional(),
});
export type NotificationListQuery = z.input<typeof NotificationListQuery>;
export const NotificationPage = z.object({ items: z.array(NotificationDto), nextCursor: z.string().nullable() });
export type NotificationPage = z.infer<typeof NotificationPage>;

export const UnreadCount = z.object({ count: z.number().int() });
export const SetReadBody = z.object({ read: z.boolean() });
export const MarkAllReadResponse = z.object({ updated: z.number().int() });

export const NotificationPreference = z.object({ kind: NotificationKindSchema, label: z.string(), description: z.string(), inApp: z.boolean() });
export const NotificationPreferences = z.object({ preferences: z.array(NotificationPreference) });
export type NotificationPreferences = z.infer<typeof NotificationPreferences>;
export const UpdatePreferencesBody = z.object({ preferences: z.array(z.object({ kind: NotificationKindSchema, inApp: z.boolean() })).min(1).max(50) });

const W = "/v1/workspaces/:workspaceId";
export const notificationEndpoints = {
  listNotifications: endpoint({ method: "GET", path: `${W}/notifications`, query: NotificationListQuery, response: NotificationPage }),
  unreadNotificationCount: endpoint({ method: "GET", path: `${W}/notifications/unread-count`, response: UnreadCount }),
  markAllNotificationsRead: endpoint({ method: "POST", path: `${W}/notifications/read-all`, response: MarkAllReadResponse }),
  setNotificationRead: endpoint({ method: "PATCH", path: `${W}/notifications/:notificationId`, body: SetReadBody, response: NotificationDto }),
  getNotificationPreferences: endpoint({ method: "GET", path: `${W}/notification-preferences`, response: NotificationPreferences }),
  updateNotificationPreferences: endpoint({ method: "PATCH", path: `${W}/notification-preferences`, body: UpdatePreferencesBody, response: NotificationPreferences }),
} as const;
