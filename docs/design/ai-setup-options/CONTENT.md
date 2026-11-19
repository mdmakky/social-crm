# Shared content: AI "Setup" page redesign (use exactly this)

Problem: Setup today shows ONE provider and ONE model plus a checkbox "Use for reply suggestions (default)"; Prompt, Budget, Usage, Capabilities and Media playground are collapsed panels. Nothing says WHICH model does WHICH job, what each job costs, or what the AI can and cannot do with the chosen model. The owner wants to see and control: connection, the model for each job, limits, and usage, in plain words, without opening hidden panels. (Design shows the target: a model chosen per job. A model that lacks a needed ability is shown as unable, never hidden.)

## Frame (fixed)
Settings page of workspace "RenoDevs Team" (home renovation company, Dhaka). Today Thu 19 Nov 2026. User Tanvir Ahmed (Owner). Settings left menu (Workspace: General, Notifications; CRM data: Lead fields, Lead stages; AI and automation: AI and automation (active); Channels: Integrations, Web chat, Ad measurement; Team and security: Members, Audit log). Page title "AI and automation", tab row: Overview, Agents, Knowledge, Automations, Setup (active). Only owners and admins can change AI setup (others see "Only owners and admins can manage AI").

## What exists today (keep all of it reachable, visible not buried)
- Provider connection: provider (Mock offline (labelled MOCK), OpenRouter, OpenAI-compatible server), API key (stored encrypted, shown only as "A key ending in cdef is stored", leave empty to keep, never displayed), optional Base URL (OpenAI-compatible servers only, public https), Enabled on/off, Connect provider / Test connection. Real providers are labelled "Not yet tested with a real request" until a test succeeds (honesty rule: never claim it works without a recorded real request). Mock is clearly labelled.
- Model per JOB (new, shown by the design). Jobs and the ability each needs:
  1. Reply suggestions in the inbox (text). A draft the person edits and sends; AI never sends.
  2. Agent notes and proposed actions (text). Used by AI agents and by the automation step "Ask an AI agent to draft a note". Nothing is sent without approval.
  3. Read images customers send (vision).
  4. Read PDFs and documents for Knowledge (document).
  5. Turn voice messages into text (transcription).
- Model catalog (sample, indicative prices per 1 million tokens in USD, input/output; transcription per minute): "Haiku 5.5 (fast, low cost)" text+vision $0.80 / $4.00; "Sonnet 5.5 (balanced)" text+vision+document $3.00 / $15.00; "Opus 5.5 (best quality)" text+vision+document $15.00 / $75.00; "Gemini Flash (low cost)" text+vision+document $0.10 / $0.40; "Whisper large" transcription $0.006 per minute; "Mock model (no cost)" text only. Label prices "indicative".
- Current assignment (normal demo state, provider OpenRouter, key ending cdef, enabled, not yet tested with a real request): Reply suggestions: Haiku 5.5. Agent notes: Sonnet 5.5. Read images: Sonnet 5.5. Read PDFs and documents: Gemini Flash. Voice to text: Whisper large.
- Prompt for reply suggestions: editable template with placeholders {{lead_name}}, {{last_messages}}, {{company_name}}, {{tone}}; every save makes a new version (Versions list: Version 3 active, Version 2, Version 1, Built-in prompt) with Use this version / Restore built-in.
- Monthly budget: limit USD (e.g. 25.00), "Hard stop: block AI calls when the limit is reached" checkbox on; "Leave empty for no limit". Month is UTC.
- Usage last 30 days: this month $4.62 of $25.00 (18%); by job: Reply suggestions 312 calls $1.10, Agent notes 64 calls $2.35, Read images 21 calls $0.74, Read PDFs 9 calls $0.31, Voice to text 6 calls (14 min) $0.12; 2 errors, 0 blocked. A small per-day sparkline-free bar list is fine (no decorative charts).
- Capabilities: per chosen model, what it can do with images, documents, audio (Yes / No / Not confirmed).
- Media playground (advanced): send one file to the provider to test a job; not stored.
- Estimated monthly cost for the current choices at current volume: about $5 (sample).

## Demo states (class demo-state control, bottom-left): normal / not connected (nothing configured yet) / mock mode / non-admin notice.
