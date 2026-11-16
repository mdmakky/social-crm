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
- **Later:** intent detection, scoring, sentiment, assignment suggestions, knowledge-base retrieval (`knowledge_sources`), AI sales agent, natural-language workflow builder (generates a draft definition that the user reviews).

## 3a. Evaluation
Each AI feature has a small fixture set and a repeatable evaluation run so prompt or model changes are compared, not guessed. Prompts are versioned and linked from `ai_runs`.

## 4. Failure handling
Provider timeouts and rate limits retry with backoff and fall back to a configured secondary model only when the workspace allows it. AI errors never block message receipt or CRM operations; features degrade to "suggestion unavailable".

## 5. Mobile
Mobile shows AI suggestions inline in the composer, summaries at the top of a conversation, lead insights on lead detail, and approval requests as actionable notifications. It calls the same API; no AI keys or prompts live on the device.
