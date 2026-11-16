import { z } from "zod";
import { withContext } from "@crm/db";
import { PermanentError } from "../../automation/actions.ts";
import { loadAttachment, readAttachmentFile } from "../../attachments/service.ts";
import { MEDIA_FAILURES, type MediaOutcome } from "../media.ts";
import { tool, type ToolCtx } from "./context.ts";

/**
 * The media tools (read, run only when an agent run or a person asks for them): they work on ONE attachment id of the run's workspace (and, when the run has a conversation, of that conversation).
 * Reads go through `ctx.db` as the acting user (RLS), the model call goes through the same media service as the HTTP routes (budget hard stop, run log without bodies, capability gating).
 * ponytail: tools run inside the apply transaction, which stays open during the provider call (the only tools that do network work); move media calls to the plan phase if that connection hold shows up in practice.
 */
const argsSchema = z.object({ attachmentId: z.string().uuid() }).strict();

async function run(ctx: ToolCtx, attachmentId: string, kinds: string[], call: (f: { mime: string; bytes: Uint8Array }) => Promise<MediaOutcome>): Promise<Record<string, unknown>> {
  const { store, media } = ctx.attach ?? {};
  if (!store) throw new PermanentError("File storage is not set up (storage_not_configured).");
  if (!media) throw new PermanentError("AI is not set up (ai_not_configured).");
  // Own transaction on the pool (not the apply transaction): the attachment must exist in THIS workspace and, with a conversation context, in that conversation.
  const a = await withContext(ctx.db, { userId: ctx.userId, workspaceId: ctx.workspaceId }, (tx) => loadAttachment(tx, ctx.workspaceId, attachmentId, ctx.conversationId ?? undefined));
  if (!a) throw new PermanentError("That attachment does not exist in this workspace (attachment_not_found).");
  if (!kinds.includes(a.kind)) throw new PermanentError("This tool does not apply to that kind of file (unsupported_kind).");
  const file = await readAttachmentFile(store, ctx.workspaceId, a);
  if (file === "missing") throw new PermanentError("The stored file is not available (file_missing).");
  const out = await call(file);
  if (!out.ok) throw new PermanentError(`${MEDIA_FAILURES[out.code]?.message ?? "The AI call failed."} (${out.code === "not_configured" ? "capability_not_configured" : out.code})`);
  return { attachmentId: a.id, text: out.text.slice(0, 4000), mock: out.mock };
}
const who = (c: ToolCtx) => ({ workspaceId: c.workspaceId, userId: c.userId });

export const mediaDescribeImage = tool({
  name: "media.describe_image",
  description: "Describe an image attachment (id of a file in this workspace) in a few sentences. Uses the workspace's vision model and counts against the AI budget.",
  argsSchema,
  sensitivity: "read",
  requiredPermission: "ai.use",
  execute: (ctx, { attachmentId }) => run(ctx, attachmentId, ["image"], (f) => ctx.attach!.media!.describeImage(who(ctx), f)),
});
export const mediaExtractText = tool({
  name: "media.extract_text",
  description: "Extract the text of an image or PDF attachment (OCR). Uses the workspace's document or vision model and counts against the AI budget.",
  argsSchema,
  sensitivity: "read",
  requiredPermission: "ai.use",
  execute: (ctx, { attachmentId }) => run(ctx, attachmentId, ["image", "document"], (f) => ctx.attach!.media!.extractDocumentText(who(ctx), f)),
});
export const mediaTranscribe = tool({
  name: "media.transcribe",
  description: "Transcribe an audio attachment to text. Uses the workspace's speech-to-text model and counts against the AI budget.",
  argsSchema,
  sensitivity: "read",
  requiredPermission: "ai.use",
  execute: (ctx, { attachmentId }) => run(ctx, attachmentId, ["audio"], (f) => ctx.attach!.media!.transcribeAudio(who(ctx), f)),
});
