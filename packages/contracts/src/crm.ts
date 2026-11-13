import { z } from "zod";
import { endpoint } from "./endpoint.ts";

const uuid = z.string().uuid();
const iso = z.string();
export const CONTACT_SOURCES = ["manual", "import", "messenger", "instagram", "facebook_lead_ad", "web_form", "referral", "other"] as const;
export const ContactSource = z.enum(CONTACT_SOURCES);
export const TAG_COLORS = ["neutral", "accent", "success", "warning", "danger"] as const;
export const TagColor = z.enum(TAG_COLORS);
export type TagColor = z.infer<typeof TagColor>;

const trimmed = (min: number, max: number, label: string) => z.string().trim().min(min, `${label} is required`).max(max, `Use at most ${max} characters`);
const nullableText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

// ---------- lifecycle stages ----------
export const LifecycleStage = z.object({ id: uuid, name: z.string(), position: z.number().int(), archived: z.boolean(), contactCount: z.number().int() });
export type LifecycleStage = z.infer<typeof LifecycleStage>;
export const StageName = trimmed(1, 40, "Name");
export const CreateStageBody = z.object({ name: StageName });
export const UpdateStageBody = z.object({ name: StageName.optional(), archived: z.boolean().optional() }).refine((v) => v.name !== undefined || v.archived !== undefined, "Nothing to update");
export const ReorderStagesBody = z.object({ ids: z.array(uuid).min(1).max(50) });

// ---------- tags ----------
export const Tag = z.object({ id: uuid, name: z.string(), color: TagColor, contactCount: z.number().int() });
export type Tag = z.infer<typeof Tag>;
export const TagName = trimmed(1, 40, "Tag name");
export const CreateTagBody = z.object({ name: TagName, color: TagColor.optional() });
export const UpdateTagBody = z.object({ name: TagName.optional(), color: TagColor.optional() }).refine((v) => v.name !== undefined || v.color !== undefined, "Nothing to update");
export const AddContactTagBody = z.object({ tagId: uuid.optional(), name: TagName.optional() }).refine((v) => !!v.tagId !== !!v.name, "Give either an existing tag or a new tag name");

// ---------- custom fields ----------
export const CUSTOM_FIELD_TYPES = ["text", "number", "date", "select", "multiselect", "boolean", "url"] as const;
export const CustomFieldType = z.enum(CUSTOM_FIELD_TYPES);
export const CustomField = z.object({ id: uuid, key: z.string(), label: z.string(), type: CustomFieldType, options: z.array(z.string()), required: z.boolean(), position: z.number().int(), archived: z.boolean() });
export type CustomField = z.infer<typeof CustomField>;
const Options = z.array(trimmed(1, 60, "Option")).max(50);
export const CreateCustomFieldBody = z
  .object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "Use lowercase letters, numbers and underscores, starting with a letter"), label: trimmed(1, 60, "Label"), type: CustomFieldType, options: Options.optional(), required: z.boolean().optional() })
  .refine((v) => !["select", "multiselect"].includes(v.type) || (v.options?.length ?? 0) > 0, "Add at least one option");
export const UpdateCustomFieldBody = z.object({ label: trimmed(1, 60, "Label").optional(), options: Options.optional(), required: z.boolean().optional(), archived: z.boolean().optional() }).refine((v) => Object.keys(v).length > 0, "Nothing to update");

// ---------- contacts ----------
export const ContactSummary = z.object({
  id: uuid,
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  company: z.string().nullable(),
  lifecycleStage: z.object({ id: uuid, name: z.string() }),
  owner: z.object({ id: z.string(), name: z.string() }).nullable(),
  tags: z.array(z.object({ id: uuid, name: z.string(), color: TagColor })),
  source: z.string(),
  lastActivityAt: iso.nullable(),
  createdAt: iso,
  version: z.number().int(),
});
export type ContactSummary = z.infer<typeof ContactSummary>;
export const ContactDetail = ContactSummary.extend({ custom: z.record(z.string(), z.unknown()), updatedAt: iso, openTaskCount: z.number().int() });
export type ContactDetail = z.infer<typeof ContactDetail>;

const ContactFields = {
  name: trimmed(1, 120, "Name"),
  email: nullableText(254),
  phone: nullableText(40),
  company: nullableText(120),
  ownerUserId: z.string().nullish(),
  lifecycleStageId: uuid.optional(),
  source: ContactSource.optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
};
export const CreateContactBody = z.object({ ...ContactFields, tagIds: z.array(uuid).max(20).optional(), allowDuplicate: z.boolean().optional() });
export type CreateContactBody = z.input<typeof CreateContactBody>;
export const UpdateContactBody = z.object({
  expectedVersion: z.number().int().min(1),
  name: ContactFields.name.optional(),
  email: ContactFields.email.optional(),
  phone: ContactFields.phone.optional(),
  company: ContactFields.company.optional(),
  ownerUserId: ContactFields.ownerUserId,
  lifecycleStageId: ContactFields.lifecycleStageId,
  source: ContactFields.source,
  custom: ContactFields.custom,
  allowDuplicate: z.boolean().optional(),
});
export type UpdateContactBody = z.input<typeof UpdateContactBody>;

export const CONTACT_SORTS = ["name", "created", "lastActivity"] as const;
export const ContactListQuery = z.object({
  search: z.string().max(100).optional(),
  lifecycleStageId: uuid.optional(),
  /** "me", "unassigned" or a user id */
  ownerId: z.string().max(100).optional(),
  /** comma-separated tag ids; a contact matches when it has any of them */
  tagIds: z.string().max(400).optional(),
  source: ContactSource.optional(),
  createdFrom: z.string().max(40).optional(),
  createdTo: z.string().max(40).optional(),
  sort: z.enum(CONTACT_SORTS).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export type ContactListQuery = z.input<typeof ContactListQuery>;
export const ContactPage = z.object({ items: z.array(ContactSummary), nextCursor: z.string().nullable(), total: z.number().int() });
export type ContactPage = z.infer<typeof ContactPage>;
export const DuplicateCandidate = z.object({ id: uuid, name: z.string(), email: z.string().nullable(), phone: z.string().nullable(), matchedOn: z.array(z.enum(["email", "phone"])) });
export type DuplicateCandidate = z.infer<typeof DuplicateCandidate>;

// ---------- notes, activity, tasks ----------
export const NoteBody = z.object({ body: z.string().trim().min(1, "Write something first").max(5000, "Use at most 5000 characters") });
export const Note = z.object({ id: uuid, body: z.string(), author: z.object({ id: z.string(), name: z.string() }), createdAt: iso, updatedAt: iso });
export type Note = z.infer<typeof Note>;
export const ActivityItem = z.object({ id: uuid, kind: z.string(), actorName: z.string().nullable(), data: z.record(z.string(), z.unknown()), occurredAt: iso });
export type ActivityItem = z.infer<typeof ActivityItem>;
export const ActivityPage = z.object({ items: z.array(ActivityItem), nextCursor: z.string().nullable() });
export const PageQuery = z.object({ cursor: uuid.optional(), limit: z.coerce.number().int().min(1).max(100).optional() });

// ---------- saved views ----------
export const CONTACT_COLUMNS = ["contact", "lifecycle", "owner", "tags", "source", "lastActivity", "created"] as const;
export const ContactColumn = z.enum(CONTACT_COLUMNS);
export type ContactColumn = z.infer<typeof ContactColumn>;
export const ViewConfig = z.object({
  columns: z.array(ContactColumn).min(1).max(7).refine((c) => new Set(c).size === c.length, "Columns must be unique").refine((c) => c.includes("contact"), "The contact column is always shown"),
  filters: ContactListQuery.omit({ cursor: true, limit: true, sort: true, dir: true }),
  sort: z.enum(CONTACT_SORTS).default("lastActivity"),
  dir: z.enum(["asc", "desc"]).default("desc"),
});
export type ViewConfig = z.infer<typeof ViewConfig>;
export const SavedView = z.object({ id: uuid, name: z.string(), shared: z.boolean(), mine: z.boolean(), config: ViewConfig });
export type SavedView = z.infer<typeof SavedView>;
export const CreateViewBody = z.object({ name: trimmed(1, 60, "Name"), shared: z.boolean().optional(), config: ViewConfig });
export const UpdateViewBody = z.object({ name: trimmed(1, 60, "Name").optional(), config: ViewConfig.optional() }).refine((v) => v.name !== undefined || v.config !== undefined, "Nothing to update");

// ---------- import ----------
export const IMPORT_FIELDS = ["name", "first_name", "last_name", "email", "phone", "company", "source", "lifecycle_stage", "owner_email", "tags"] as const;
export const ImportFieldId = z.string().regex(new RegExp(`^(${IMPORT_FIELDS.join("|")}|custom:[a-z][a-z0-9_]{0,39})$`), "Unknown import field");
export const UploadImportBody = z.object({ filename: trimmed(1, 200, "Filename"), csv: z.string().min(1, "The file is empty").max(5 * 1024 * 1024) });
export const ImportUpload = z.object({ id: uuid, headers: z.array(z.string()), rowCount: z.number().int(), sample: z.array(z.array(z.string())), suggestedMapping: z.array(ImportFieldId.nullable()), fields: z.array(z.object({ id: z.string(), label: z.string() })) });
export type ImportUpload = z.infer<typeof ImportUpload>;
export const DUPLICATE_ACTIONS = ["skip", "update", "create"] as const;
export const ImportPlanBody = z.object({
  mapping: z.array(ImportFieldId.nullable()).max(50),
  onDuplicate: z.enum(DUPLICATE_ACTIONS),
  /** per-row override keyed by the 1-based data row number */
  rowDecisions: z.record(z.string().regex(/^\d+$/), z.enum(DUPLICATE_ACTIONS)).optional(),
  skipInvalid: z.boolean().optional(),
});
export type ImportPlanBody = z.input<typeof ImportPlanBody>;
export const ImportPreview = z.object({
  total: z.number().int(),
  valid: z.number().int(),
  invalid: z.number().int(),
  willCreate: z.number().int(),
  willUpdate: z.number().int(),
  willSkip: z.number().int(),
  errors: z.array(z.object({ row: z.number().int(), messages: z.array(z.string()) })),
  duplicates: z.array(z.object({ row: z.number().int(), matchedOn: z.string(), existing: z.object({ id: uuid, name: z.string() }).nullable(), duplicateOfRow: z.number().int().nullable(), action: z.enum(DUPLICATE_ACTIONS) })),
  /** rows that will be skipped for a reason the user did not choose (for example an update with nothing to update) */
  warnings: z.array(z.object({ row: z.number().int(), message: z.string() })).optional(),
  truncated: z.boolean(),
});
export type ImportPreview = z.infer<typeof ImportPreview>;
export const ImportResult = z.object({ importId: uuid, created: z.number().int(), updated: z.number().int(), skipped: z.number().int() });
export type ImportResult = z.infer<typeof ImportResult>;

const W = "/v1/workspaces/:workspaceId";
export const crmEndpoints = {
  listLifecycleStages: endpoint({ method: "GET", path: `${W}/lifecycle-stages`, response: z.array(LifecycleStage) }),
  createLifecycleStage: endpoint({ method: "POST", path: `${W}/lifecycle-stages`, body: CreateStageBody, response: LifecycleStage }),
  updateLifecycleStage: endpoint({ method: "PATCH", path: `${W}/lifecycle-stages/:stageId`, body: UpdateStageBody, response: LifecycleStage }),
  reorderLifecycleStages: endpoint({ method: "POST", path: `${W}/lifecycle-stages/reorder`, body: ReorderStagesBody, response: z.array(LifecycleStage) }),

  listTags: endpoint({ method: "GET", path: `${W}/tags`, response: z.array(Tag) }),
  createTag: endpoint({ method: "POST", path: `${W}/tags`, body: CreateTagBody, response: Tag }),
  updateTag: endpoint({ method: "PATCH", path: `${W}/tags/:tagId`, body: UpdateTagBody, response: Tag }),
  deleteTag: endpoint({ method: "DELETE", path: `${W}/tags/:tagId`, response: z.undefined() }),

  listCustomFields: endpoint({ method: "GET", path: `${W}/custom-fields`, response: z.array(CustomField) }),
  createCustomField: endpoint({ method: "POST", path: `${W}/custom-fields`, body: CreateCustomFieldBody, response: CustomField }),
  updateCustomField: endpoint({ method: "PATCH", path: `${W}/custom-fields/:fieldId`, body: UpdateCustomFieldBody, response: CustomField }),

  listContacts: endpoint({ method: "GET", path: `${W}/contacts`, query: ContactListQuery, response: ContactPage }),
  createContact: endpoint({ method: "POST", path: `${W}/contacts`, body: CreateContactBody, response: ContactDetail }),
  exportContacts: endpoint({ method: "GET", path: `${W}/contacts/export`, query: ContactListQuery, response: z.string(), responseType: "text" }),
  getContact: endpoint({ method: "GET", path: `${W}/contacts/:contactId`, response: ContactDetail }),
  updateContact: endpoint({ method: "PATCH", path: `${W}/contacts/:contactId`, body: UpdateContactBody, response: ContactDetail }),
  deleteContact: endpoint({ method: "DELETE", path: `${W}/contacts/:contactId`, response: z.undefined() }),
  addContactTag: endpoint({ method: "POST", path: `${W}/contacts/:contactId/tags`, body: AddContactTagBody, response: ContactDetail }),
  removeContactTag: endpoint({ method: "DELETE", path: `${W}/contacts/:contactId/tags/:tagId`, response: ContactDetail }),

  listNotes: endpoint({ method: "GET", path: `${W}/contacts/:contactId/notes`, response: z.array(Note) }),
  createNote: endpoint({ method: "POST", path: `${W}/contacts/:contactId/notes`, body: NoteBody, response: Note }),
  updateNote: endpoint({ method: "PATCH", path: `${W}/contacts/:contactId/notes/:noteId`, body: NoteBody, response: Note }),
  deleteNote: endpoint({ method: "DELETE", path: `${W}/contacts/:contactId/notes/:noteId`, response: z.undefined() }),
  listActivity: endpoint({ method: "GET", path: `${W}/contacts/:contactId/activity`, query: PageQuery, response: ActivityPage }),


  listViews: endpoint({ method: "GET", path: `${W}/views`, response: z.array(SavedView) }),
  createView: endpoint({ method: "POST", path: `${W}/views`, body: CreateViewBody, response: SavedView }),
  updateView: endpoint({ method: "PATCH", path: `${W}/views/:viewId`, body: UpdateViewBody, response: SavedView }),
  deleteView: endpoint({ method: "DELETE", path: `${W}/views/:viewId`, response: z.undefined() }),

  uploadImport: endpoint({ method: "POST", path: `${W}/imports`, body: UploadImportBody, response: ImportUpload }),
  previewImport: endpoint({ method: "POST", path: `${W}/imports/:importId/preview`, body: ImportPlanBody, response: ImportPreview }),
  commitImport: endpoint({ method: "POST", path: `${W}/imports/:importId/commit`, body: ImportPlanBody, response: ImportResult }),
} as const;
