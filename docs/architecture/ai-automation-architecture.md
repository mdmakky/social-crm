# Automation and AI Architecture

Version 0.1 (Phase 0). Principle: AI is a step type inside the workflow engine and a set of tools behind one facade, not a separate chatbot. The MVP builds the foundation and a few useful features. It does not build an agent platform.

## 1. Workflow engine

> Status (2026-11-16): slice 1 implements the deterministic core, simplified: `automation_rules` (one trigger, a condition tree, a linear action list, inline in the row) instead of `workflows.definition` graphs; `automation_runs` (unique per rule + event, snapshot of actions) and `automation_run_steps`; approval is a run status (`awaiting_approval`), not a separate `approvals` table; kill switch is `automation_settings.kill_switch` plus per-rule enable. Actions: create_task, add_tag, assign_owner. Not built yet: AI steps, send actions, delays, per-action auto-send policy, approval expiry/edit-and-approve. See D73 to D75.

Components: **Trigger** (domain event such as message received, lead created, stage changed, follow-up due, schedule), **Condition** (rule over contact, lead, conversation fields), **Action** (from an action registry), **Delay**, **AI step** (classify, summarize, suggest), **Human approval**, **Notification**.

Definition is versioned JSON (`workflows.definition`): a trigger plus a directed graph of typed nodes. MVP supports linear flows with branches from conditions; the builder UI starts as a form-based rule list and grows into a canvas later.

Execution:
1. Domain event arrives from the outbox; matching enabled workflows get a run with `idempotency_key = workflow_id + version + trigger_event_id`, so a replayed event cannot start a second run.
2. A job executes one node at a time and persists a `workflow_run_steps` row (input, output, attempt, error). Delays are scheduled jobs, not sleeping workers.
3. Each action declares whether it is idempotent and supplies its own idempotency key (for example an outbound message uses the run step id as `client_nonce`).
4. Failures retry with backoff up to a limit, then the run fails visibly with the step error. Runs can be cancelled.
5. Kill switches: workspace `global_enabled`, per-workflow disable, and a per-action-type auto-send policy.

Action registry (MVP): create/update contact, create lead, move stage, assign owner or conversation, add tag/note, send reply (always routed through approval unless policy allows), create reminder, notify user, send CAPI event (via the CAPI mapping, never directly), call AI step.

Examples from the brief map directly: "New Instagram message -> detect intent -> find contact -> summarize -> suggest reply -> approval -> send" and "New Facebook lead -> create contact -> create lead -> assign -> AI summary -> notify".

## 2. Human approval
An approval step creates an `approvals` row with the proposed action, notifies the assignee (push and web), and pauses the run. Approve, edit-and-approve or reject resumes or ends the run. Pending approvals expire. All decisions are audited. Default policy: any outbound customer message or consequential action (stage to won/lost, CAPI purchase) requires approval. Policy can allow auto-send per action type only through an explicit workspace setting that is logged.

## 3. AI layer

> Status (2026-11-16): slice 1 built (decisions D86 to D96). `packages/ai` is a thin port plus registry, not the Vercel AI SDK (adapters on fetch). Built: provider config with sealed key, model catalog with workspace price overrides, versioned prompts, `ai_runs` (tokens, cost, latency, no text), monthly budget with hard stop, retry only on rate_limit and timeout, ONE capability (reply suggestion, draft only). Not built: summaries, lead classification, purpose-based routing (one default provider and model today), secondary-model fallback, tools, redacted output storage and retention (nothing is stored), evaluation fixtures, mobile surfaces. Real providers are UNVERIFIED.

```
Feature (suggest reply / summarize / classify / workflow AI step)
  -> ai facade (packages/ai): purpose-based model routing, prompt templates (versioned),
     context builder (minimized, redacted), tool allow-list, budget check, logging
  -> provider SDK (Vercel AI SDK candidate; Anthropic, OpenAI, others via config)
```

- **Provider abstraction:** workspaces configure providers and models per purpose (`suggest`, `summarize`, `classify`, `agent`). Nothing hardcodes one vendor. Keys are stored in the credential envelope and never reach clients.
- **Logging and cost:** every call writes `ai_runs` (tokens, cost, latency, prompt version, status). Prompts and outputs are stored redacted and with retention limits. Budgets (`ai_budgets`) enforce soft warnings and hard stops per workspace per period.
- **Data protection:** context builder sends only the fields a feature needs; PII masking option; no customer data is used for anything except the configured call. Workspace setting can disable AI entirely.
- **Tools:** AI may call only registered, read-mostly tools (search contact, get conversation, list lead fields). Write tools produce proposals that enter approval, never direct mutations.
- **MVP features:** reply suggestions (shown as drafts in the composer), conversation summaries (stored on the conversation with version and timestamp), lead classification (label and confidence, never auto-moving stages without approval).
- **Later:** intent detection, scoring, sentiment, assignment suggestions, knowledge-base retrieval (slice 1 built, see 3b), AI sales agent, natural-language workflow builder (generates a draft definition that the user reviews).

## 3b. Knowledge base (slice 1 built, 2026-11-16, branch `feat/ai-knowledge-base`)
- **What exists:** `knowledge_sources` (text, file, url; status pending, ready, failed; soft delete) and `knowledge_chunks` (migration 0031, forced RLS, composite FK on `(workspace_id, source_id)`). Pure logic in `packages/knowledge` (normaliser, deterministic chunker, HTML to text, extractor registry, SSRF-safe fetcher). API under `/v1/workspaces/:id/knowledge/*`, Settings > Knowledge on web. No AI provider is called.
- **Retrieval:** `searchKnowledge(db, {workspaceId, userId}, query, {limit})` in `apps/api/src/knowledge/search.ts` is the function an agent tool will call. Postgres full-text search, `to_tsvector('simple', content)` as a generated column with a GIN index, `websearch_to_tsquery('simple', ...)`, `ts_rank_cd`. It runs under the caller's RLS context and also filters on the workspace id. Returns `{sourceId, title, sourceRef, position, snippet, score}`.
- **Why 'simple':** no language is assumed, so Bangla, Arabic, English and mixed text work the same. Cost: no stemming (refund does not match refunds), no stop words (a plain question rarely has all its words in one chunk; a no-hit query is retried as "any of the longer words"), and Chinese, Japanese or Thai text without spaces is one token (substring search fails).
- **Chunking:** about 800 characters, 100 overlap, hard max 1200, split at paragraph, then sentence (Latin, danda, CJK full stops), then space, then code point. Same input gives the same chunks.
- **Ingestion is synchronous** in the request (no queue, no worker role access yet). A URL is fetched before any transaction opens. Limits: 200 sources, 1,000,000 characters and 2000 chunks per source, 10,000,000 characters per workspace, 2 MB per file or page.
- **URL safety:** http(s) only, no credentials, ports 80/443/8080/8443, every resolved address must be public (one private answer blocks the name), the socket connects to the checked address, every redirect (max 3) is rechecked, 10 s, 2 MB, content type text/html, text/plain or text/markdown. Single page only, no crawling.
- **Extractors:** `.txt .md .csv .html`. `extractors` in `packages/knowledge/src/extract.ts` is the plug-in point for PDF, DOCX, OCR and audio (next slices); other types return `unsupported_type`.
- **Next (not built):** (1) embeddings and a vector index. The decision (pgvector on Neon vs an external store) is deferred until the FTS limits above are measured on real customer documents: look at no-hit rate on natural questions, wrong-language misses, and CJK/Thai customers. (2) PDF/DOCX/OCR/audio extractors. (3) asynchronous ingestion on the existing queue, with worker grants. (4) agents calling `searchKnowledge` as a tool with citations. (5) crawling a site, scheduled refresh of URL sources.

## 3a. Evaluation
Each AI feature has a small fixture set and a repeatable evaluation run so prompt or model changes are compared, not guessed. Prompts are versioned and linked from `ai_runs`.

## 4. Failure handling
Provider timeouts and rate limits retry with backoff and fall back to a configured secondary model only when the workspace allows it. AI errors never block message receipt or CRM operations; features degrade to "suggestion unavailable".

## 5. Mobile
Mobile shows AI suggestions inline in the composer, summaries at the top of a conversation, lead insights on lead detail, and approval requests as actionable notifications. It calls the same API; no AI keys or prompts live on the device.

## 3c. Agent builder and tool registry, slice 1 (2026-11-16, decisions D110 to D119)
- **Status:** built on `feat/ai-agent-builder` (not merged). Agents (`ai_agents`, append-only `ai_agent_versions`), tool grants per version (`auto` or `approval`), pending approvals (`ai_agent_actions`), per-agent run log (`ai_runs.agent_id`).
- **Flow:** API loads the active version, composes the system prompt (safety preamble, instructions, personality, language, style, granted tool catalog, JSON output format), calls `runAi` once with no transaction open, parses `{reply, actions}` against the registry and the grants, then applies it in one transaction as the requesting user. Customer text is fenced as data; grants never come from model text.
- **Tools:** one file per tool in `apps/api/src/ai/tools` plus one registry line. Read tools run, auto write tools run once, approval-granted and sensitive tools are queued for owner/admin approval. Max 3 actions per run. Drafts only: nothing is sent.
- **Automation:** action `run_ai_agent` makes the model call before the action transaction, then records a draft note and pending approvals. The kill switch, approvals and idempotency of the automation engine apply. Delays are not available.
- **Not built:** multi-turn tool loops, auto-send, approval expiry, inbox agent picker, evaluation fixtures. Real providers are UNVERIFIED.

## 3d. Multimodal foundation, slice 1 (2026-11-16, decisions D120 to D128, mock-first)
- **Status:** built on `feat/ai-multimodal` (not merged). Industry-independent and provider-agnostic; no new infrastructure and no migration.
- **Port:** `AiProvider` gained optional `vision`, `document` (PDF or image text) and `transcribe`. The catalog carries `capabilities` per model (`text`, `vision`, `document`, `transcription`) and `transcriptionMicroPerMinute`. `supports()` and `pickModel()` choose a model; `invokeMedia()` throws `AiError("unsupported_capability")` instead of crashing. Mock implements all four deterministically (output from mime, size and hash only, labelled `[MOCK ...]`). Anthropic: image and PDF as base64 content blocks. OpenAI-compatible: `image_url` data URI and multipart `/audio/transcriptions`. All adapters are UNVERIFIED (fake fetch only); catalog capability flags are from memory and UNVERIFIED.
- **Service:** `apps/api/src/ai/media.ts` (`describeImage`, `askAboutImage`, `extractDocumentText`, `transcribeAudio`) calls `runAi` with a `media` input (capability labels `vision`, `ocr`, `transcription`). Rate limit, allowlist, size cap and magic-byte check run first; then the same budget hard stop, retries and run log as text. The run row keeps kind, mime, size, a hash and output length, never bytes or output text.
- **API:** `POST /ai/media/{describe,ask,extract,transcribe}` (JSON base64 plus mime, permission `ai.use`) and `GET /ai/capabilities` (enabled providers and models with flags, `unverified`, `mock`, and what is available now).
- **Knowledge:** `extractFile(file, extra)` takes extractors from the API for `.pdf`, images and audio; extracted text is chunked and stored as a `file` source. A failure leaves a `failed` source with a code. No capable provider answers `capability_not_configured`.
- **UI:** Settings > AI shows Capabilities (badges, MOCK and UNVERIFIED labels) and a Media playground; the Knowledge add-source dialog accepts the new types and shows the capability error.
- **Agent tools:** not built. There are no stored attachments to reference (`messages.attachments` holds platform references only). Next slice: inbox attachments (download, store, reference by id) feeding agents (`media.describe_image`, `media.extract_text`) and the knowledge base.
- **Not built:** streaming, voice agents, video, real-time audio, per-model capability overrides for custom model ids, a worker queue for large files, a vision provider choice per call. Real providers are UNVERIFIED.
