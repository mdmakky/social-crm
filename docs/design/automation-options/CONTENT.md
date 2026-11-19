# Shared content for the Automations design options (use exactly this)

Problem to solve: today's page uses jargon (Rules, Runs, trigger, conditions, kill switch, "Require approval for every run") and the New rule dialog asks for raw ids. A normal small-business owner must understand it without help. Plain words. A person always decides what AI does.

## Product facts (do not break)
- Automation = "when X happens, [only if Y], do Z". Triggers: "A lead is created", "A lead moves to another stage", "A lead gets an owner", "A lead record gets an owner" (a deal in a pipeline).
- Optional filters (pick by NAME, never type ids): Source (Instagram, Messenger, WhatsApp, Facebook lead ad, Web form, Referral, Added manually, CSV import), Lead name (contains), Lifecycle stage, Owner, Moved to / from stage, Outcome (Open, Won, Lost), Pipeline, Lead title (contains). Several filters: "all must match" or "any is enough" (max 5).
- Actions (1 to 5, run in order): Create a follow-up task (title, optional due in N hours or days); Add a tag to the lead (tag name); Assign an owner (a teammate); Ask an AI agent to draft a note (nothing is ever sent; the agent only drafts a note and proposes actions that a person approves).
- Each automation either "Asks you first" (recommended: every time it triggers it waits in Activity until a person approves or rejects) or "Runs on its own".
- Each automation can be On or Off. Master switch "Pause all automations" stops everything at once; when paused, nothing runs and approvals are blocked until "Resume automations".
- Only owners and admins manage automations (agents and viewers see a notice "Only owners and admins can manage automations").
- Activity list: each run shows automation name, status (Waiting for your approval, Queued, Running, Done, Failed, Rejected), what started it, when, what it does, Approve / Reject buttons when waiting, a plain error when failed, expandable Details (steps).
- AI and delivery honesty: AI never sends a message; say so.

## Scene: workspace "RenoDevs Team" (home renovation company in Dhaka). Today Thu 19 Nov 2026, 3:40 PM. Current user Tanvir Ahmed (Owner, avatar TA). Teammates: Sagor Hossen (Admin), Nusrat Jahan (Agent). Settings page has a left settings menu (Workspace: General, Notifications; CRM data: Lead fields, Lead stages; AI and automation: AI and automation; Channels: Integrations, Web chat, Ad measurement; Team and security: Members, Audit log) and the AI and automation page has tabs: Overview, Agents, Knowledge, Automations (active), Setup. Keep this frame.
Stages: New, Contacted, Qualified, Proposal, Negotiation, Won, Lost. Tags that exist: Hot, VIP, Renovation. AI agent available: "Reply drafter" (active).

## Existing automations (list screen)
1. "Follow up on new leads": When a lead is created: create the task "Follow up with the new lead" due in 1 day. Asks you first. On.
2. "Tag Instagram leads Hot": When a lead is created and source is Instagram: add the tag "Hot". Runs on its own. On.
3. "Hand Facebook leads to Sagor": When a lead is created and source is Facebook lead ad: make Sagor Hossen the owner. Asks you first. Off.

## Activity (newest first)
- Follow up on new leads: Waiting for your approval. A lead was created: Nusrat Jahan (Full home renovation). 12 min ago. Create the task "Follow up with the new lead" due in 1 day. [Approve] [Reject]
- Tag Instagram leads Hot: Done. A lead was created: Md. Arafatuzzaman. 40 min ago. Add the tag "Hot".
- Follow up on new leads: Done (you approved it). A lead was created: Rahim Uddin. Yesterday, 11:05 AM. Create the task "Follow up with the new lead".
- Hand Facebook leads to Sagor: Failed. A lead was created: Farhana Akter. Mon 16 Nov, 2:10 PM. Error: "Sagor Hossen could not be assigned: they no longer have access to this workspace." Details: 1 step.

## Ready-made starting points (for the empty state / gallery)
- Follow up on every new lead (creates a task due the next day so no lead is forgotten)
- Tag every new lead (adds a tag so you can find them later)
- Give Instagram leads to a teammate (assigns every lead from Instagram to one person)
- Ask an AI agent to draft a note (the agent reads each new lead and writes a note for you to review; nothing is sent)
- Celebrate a won deal (when a lead record moves to Won: create the task "Ask for a review" due in 3 days)
- Welcome Facebook leads (when a lead is created and source is Facebook lead ad: add the tag "Facebook" and create the task "Call within 1 hour")
