# Competitor Analysis: Social CRM (Meta-first, web + mobile)

Retrieval date for all sources: 2026-11-13 (unless a source is noted otherwise).

## Method and confidence

Research used official pricing pages, vendor help centers, the Apple iTunes Search and customer-review feeds, and a few third-party reviews. Rules applied:

- Every claim carries a source URL. Where a claim comes from a third party it is labelled "(third party)".
- "Unverified" means I could not confirm the point from a source I could read. It is not evidence the feature is absent.
- Several vendor sites blocked automated fetching (Manychat pricing and help center returned HTTP 403). Manychat figures therefore come only from third-party pages and are marked.
- Google Play ratings could not be retrieved (Play pages returned no rating data to the fetcher). All Google Play ratings are unverified. Apple App Store figures were pulled from Apple's own search API, as of 2026-11-13.
- Marketing-comparison pages written by competing vendors (respond.io, Kommo, SleekFlow) are biased and were used only for channel lists.
- Information architecture, dashboard and onboarding detail for several products could not be verified from official pages; those gaps are stated per product rather than filled in.

Apple data source: https://itunes.apple.com/search?entity=software (query per product) and https://itunes.apple.com/us/rss/customerreviews/id=<id>/sortby=mostrecent/json.

---

## 1. Manychat

**Positioning.** Social-first DM automation, strongest on Instagram, Messenger, TikTok, WhatsApp. Source (third party): https://respond.io/blog/kommo-vs-manychat (vendor-biased; channel list only).

**Information architecture and navigation.** Automation tab > Flows > New Flow > add trigger (for example Instagram Comments) > Publish / "Set Live". Source: https://help.manychat.com/hc/en-us/articles/14281316989724 and https://manychat.freshdesk.com/support/solutions/articles/36000293707-instagram-comments-growth-tool (via search snippets; pages themselves not fully read). Full sidebar structure, dashboard content: unverified.

**Inbox.** "Live Chat" with a separate paid Inbox tier that adds auto-assignment and team groups (community reply, third party): https://community.manychat.com/general-q-a-43/manychat-inbox-pro-analytics-seats-label-workflow-a-few-questions-before-migrating-our-team-10721. Rule-based auto-assignment lives at Settings > Inbox > Auto-Assignment and needs an Inbox Rule; only members with Inbox seats are eligible. Source: https://help.manychat.com/hc/en-us/articles/14281072676764-Conversations-auto-assignment (as summarized by search; direct fetch returned 403).

**Contact management.** Contact tab behavior: unverified.

**Assignment.** Auto-assignment to agents or groups; an "Assign conversation" action exists in flows (Live Chat actions). Known limitation reported: no way to unassign automatically; no flow condition on assigned agent. Sources (third party/community): https://www.guideflow.com/tutorial/how-to-add-an-assign-conversation-action-in-manychat, https://community.manychat.com/ideas/conditions-based-on-assigned-team-member-6034.

**Automation builder.** Visual Flow Builder; community threads show frequent failure modes: flow must be set live, comment triggers need a private-reply/DM step, dark-post ads not supported, permission refresh needed. Source: https://community.manychat.com/general-q-a-43/automation-does-not-activate-after-user-comments-on-a-specific-post-5715 and related threads.

**Integration management.** Integrations area exists; specifics unverified.

**Onboarding.** Unverified.

**Pricing.** Official page blocked (HTTP 403 on https://manychat.com/pricing). A third party reports a March 2026 restructure into Free (25 contacts), Essential, Pro, Business, Advanced, with Pro about $39 monthly or $29 annually for 2,500 contacts and Business $99 monthly. Source (third party, not confirmed against official page): https://www.blotato.com/blog/manychat-pricing. Other sites still show legacy "$15 for 500 contacts". Treat all Manychat prices as unverified.

**Mobile.** See section 11.

---

## 2. respond.io

**Positioning.** Multi-agent, multi-channel messaging for B2C teams; broadest channel list (WhatsApp, Messenger, LINE, Viber, Telegram, SMS) per its own comparison page: https://respond.io/blog/kommo-vs-manychat. G2 rating 4.8 across 512 reviews (third party, search snippet): https://www.g2.com/compare/whatsapp-business-platform-vs-respond-io.

**Information architecture.** Web app sections referenced by the mobile help article as web-only: Dashboard, Contacts, AI Agents, Broadcasts, Workflows, Reports, plus Organization/Workspace settings, Channels, Billing and usage. Source: https://respond.io/help/mobile-app/mobile-app-overview. Inbox views include All, Mine, Unassigned, Blocked Contacts and Team/Custom inboxes (same source).

**Dashboard.** Exists (web only); contents unverified.

**Inbox.** Filters by Open, Closed, Snoozed, Unreplied; closing notes; snippets; voice messages; contact panel details. Source: same mobile-app overview. Desktop inbox layout page returned 404; desktop detail unverified.

**Assignment.** Handled in Workflows via the "Assign To" step. Default is pick-and-assign. Two documented strategies: Round Robin + Online Only, and Least Open Contacts. Source: https://respond.io/help/convert-leads/assignment-strategy-automatic-contact-distribution-load-balancing.md.

**Automation builder.** Canvas with Top Bar, zoom/undo tools, Configuration Drawer. Trigger plus steps: Send Message, Ask a Question (7-day default timeout), Assign To, Branch with Else, Update Contact Field, Date & Time, Add Comment, Add Google Sheets Row, AI Objective. Test mode via QR/chat link; edit requires stopping, which ejects enrolled contacts. Template library groups assignment, routing, welcome, chat menus, CSAT. Source: https://respond.io/help/workflows/workflows-overview.md. Workflow caps per plan reported on an older roadmap changelog (Free 1, Pro 3, Business 15): https://roadmap.respond.io/changelog/v80-workflows-aka-automation-20-whatsapp-message-template-api-and-more. Current caps unverified.

**Integration management.** Zapier, Make, developer API on Growth; HTTP requests, webhooks, SSO, custom channels on Advanced. Source: https://respond.io/pricing.

**Onboarding.** Unverified (no official source read).

**Pricing** (https://respond.io/pricing, USD, billed yearly):

| Plan | Price | Users | Notes |
|---|---|---|---|
| Starter | $79/mo (structured data lists $99 monthly) | 5, extra $12 | Team/custom inboxes, mobile app, basic reports |
| Growth | $159/mo ($199 monthly) | 10, extra $20 | Adds broadcasts, workflows, AI Agents, Zapier/Make, API |
| Advanced | $279/mo ($349 monthly) | 10, extra $24 | Adds masking, multiple workspaces, HTTP in workflows, webhooks, SSO, custom channels |
| Enterprise | Custom | Unlimited | Higher limits |

Contact overage billed per 100 ($12 Growth, $15 Advanced). 7-day trial gives Growth features.

**Mobile.** See section 11.

---

## 3. Kommo

**Positioning.** CRM-first messaging (pipelines plus chat). Source (vendor-biased): https://respond.io/blog/kommo-vs-manychat.

**Information architecture and navigation.** Left menu with seven sections: Pipelines (board/list), Communication (shared inbox), Tasks (day/week/month), Lists (Contacts, Companies, Media, Products), AI & Automations (bots, templates, broadcasting, AI agent, knowledge sources), Insights, Settings (including integration marketplace). Source: https://support.kommo.com/docs/kommo-interface.

**Dashboard.** Lives in Insights; customizable widgets and time period; other reports include Win-Loss, Consolidated, Activity Log, Call, Goal, ROI. Same source.

**Inbox.** Shared inbox across WhatsApp, Instagram, Telegram and others with internal notes and mentions; conversation history sits on the lead. Sources: https://support.kommo.com/docs/kommo-interface, https://support.kommo.com/docs/app-overview.md.

**Contact management.** Lists > Contacts; duplicate merging exists on desktop (mobile cannot merge). Same sources.

**Assignment.** Assignments via Salesbot/automation described in Kommo's help (https://www.kommo.com/support/crm). Specific strategies unverified.

**Automation builder.** Salesbot (chat flows, follow-ups, assignments, lead updates) and pipeline automation on Advanced and above. Pricing page: https://kommo.com/pricing/. Builder UI details unverified.

**Integration management.** Marketplace under Settings; WhatsApp Business and channel connection are desktop-only. Sources: https://support.kommo.com/docs/kommo-interface, https://support.kommo.com/docs/app-overview.md.

**Onboarding.** Unverified.

**Pricing** (https://kommo.com/pricing/, USD, per user per month, minimum 6 months, no monthly billing):

| Plan | Price | Leads per user | Highlights |
|---|---|---|---|
| Base | $25 | 2,500 | Pipelines, unified inbox, dashboard, basic AI |
| Advanced | $35 | 5,000 | Pipeline automation, broadcasting, no-code bots, up to 3 AI agents |
| Pro | $45 | 10,000 | Booking, analytics, up to 50 AI agents, unlimited channels |
| Enterprise | Custom | Custom | SSO, SLA, backups |

All users must be on the same plan; AI credits scale per seat and do not roll over. Channel count tied to seats on lower tiers.

**Mobile.** See section 11.

---

## 4. HubSpot CRM

**Information architecture and inbox.** Conversations inbox with left-sidebar views: Unassigned, Assigned to me, All open, Chat; under More: Bots, Email, Messenger, Forms, Calls, All closed, Sent, Spam, Trash. Filters by status, channel, contact, assignee, date. Assignment via an Owner dropdown; availability toggle with working hours. The article does not mention Instagram. Source: https://knowledge.hubspot.com/inbox/use-the-conversations-inbox.

**Dashboard, contact management, automation builder, integration marketplace, onboarding.** Not read from official sources in this pass: unverified.

**Pricing** (https://www.hubspot.com/pricing/crm): Free for up to 2 users (1,000 contacts, no email/chat support). Starter from $7 per seat per month annual, $10 month-to-month for new customers, normally $20 per seat per month. Professional and Enterprise prices were not on the fetched page: unverified. Starter adds automation, AI agents, payments, and removes HubSpot branding.

**Mobile.** See section 11.

---

## 5. GoHighLevel (HighLevel)

**Positioning.** Agency all-in-one with white-label and SaaS resale. Source: https://www.gohighlevel.com/pricing.

**Information architecture and navigation.** Left menu includes Automations, per a third party: https://www.ghlexperts.com/features/workflow-builder. Conversations, Contacts, Opportunities menu items: unverified from official docs. Conversation Views are saved filter sets in the inbox, combinable with AND/OR (third party, March 2026): https://gohighlevelassist.freshdesk.com/support/solutions/articles/155000007311-how-to-create-and-share-conversation-views.

**Dashboard, contact management, assignment rules, onboarding.** Unverified.

**Automation builder.** Node-based workflow builder; drag-and-drop for triggers and actions reported Feb 2026; counts of triggers disagree across third parties (30+, 40+, 50+), so unverified. Sources: https://www.ghlexperts.com/blog/highlevel-updates-feb-4-10-2026--openrouter-brings-300-ai-models-to-workflows, https://ecosire.com/blog/ghl-workflow-automation-guide.

**Integration management.** Marketplace and OpenRouter AI actions reported (third party). Depth unverified.

**Pricing** (https://www.gohighlevel.com/pricing):

| Plan | Monthly | Notes |
|---|---|---|
| Starter | $97 | Workflow/campaign builders, SMS/email; FAQ says 3 sub-accounts |
| Unlimited | $297 | Unlimited sub-accounts, white-label desktop app, API |
| Founder (called "Pro" in FAQ) | $497 | SaaS mode, resale, project management |
| Enterprise | Custom | White-label mobile app, HIPAA, premium support |

Usage charges for telecom and AI apply on top. 14-day trial on non-Enterprise plans. Annual prices were shown inconsistently on the page (for example $4,970 and $2,970); consult the page before quoting.

**Mobile.** See section 11.

---

## 6. Intercom

**Inbox and navigation.** Default views All and Unassigned; views do not reassign, the conversation stays in the teammate or team inbox. Custom views and folders exist. Sources: https://www.intercom.com/help/en/articles/6258745-the-inbox-explained, https://www.intercom.com/help/en/articles/6588834-organize-your-inbox-with-custom-views-and-folders (snippets via search).

**Channels.** Facebook and Instagram DMs can arrive in the inbox; Workflows can triage them. Source: https://intercom.com/help/en/articles/9955432-channels-explained.

**Assignment.** Assignment Workflows: trigger, conditions, assign action. Always include an explicit assign step or conversations fall back to the default assignee. Only one customer-facing workflow runs per conversation, so priority order matters. Round Robin assigns only once, when first entering a team inbox; per-team "Ignore activity status" toggle; teammate and team limits. Source: https://www.intercom.com/help/en/articles/11961281-manage-and-troubleshoot-assignment-workflows.

**Dashboard, contact management, onboarding, integration management.** Unverified in this pass.

**Pricing** (https://www.intercom.com/pricing):

| Plan | Seat price | Notes |
|---|---|---|
| Essential | $19 per seat per month (new customers) | Core inbox, Messenger, shared inbox, reports |
| Advanced | $85 | Multiple team inboxes, workflow builder, round robin, 20 free Lite seats |
| Expert | $132 | SSO, HIPAA, SLAs, multibrand, 50 free Lite seats |

Fin AI Agent: $0.99 per resolved outcome, no seat cost. Usage charges for WhatsApp/SMS/email. Add-ons: Copilot $29 per agent per month.

**Mobile.** See section 11.

---

## 7. SleekFlow

**Positioning.** WhatsApp-led omnichannel with strong Asia presence (positioning unverified).

**Automation builder.** Advanced Flow Builder with triggers across messaging, contacts (including lifecycle stage), social media comments/story replies/live comments, time-based, integrations (Shopify, Salesforce, HubSpot, Zoho, Google Sheets, TikTok Ads), webhooks. Actions: send message, internal note, create/update contact, labels, change status, assign agent, add collaborators, HTTP request. Logic: condition branching, time delay, wait for event. Prebuilt templates. Source: https://help.sleekflow.io/en_US/advanced-flow-builder.

**Inbox.** Mobile inbox has "You" and "@Mentions" tabs; assignment as contact owner, collaborators, or to a team. Source: https://help.sleekflow.io/sleekflow-mobile-app/features-available-on-the-mobile-app (snippet).

**Dashboard, contact mgmt, onboarding.** Unverified, except that Premium includes 60-day dedicated onboarding (below).

**Pricing** (https://sleekflow.io/pricing, USD, billed yearly): Essential $49 (3 seats, 500 contacts, no AI agents or broadcast; "rolling out by country"), Pro $109 (10 seats, AI agents, broadcast, Flow Builder, Shopify/Stripe/Zapier/Make/API), Premium $279 (RBAC, multiple workspaces, HubSpot/Zoho, external-system AI agents), Enterprise custom (Salesforce, PII masking). Seat add-ons $15 to $29. Active flow caps 50/100/200.

**Mobile.** See section 11.

---

## 8. Front

**Positioning.** Shared inbox for email-led teams, extended to SMS and social.

**Information architecture.** Shared inboxes (can be empty inboxes without a channel) with channels feeding them; assignment does not move a conversation out of the shared inbox. A "Social Media" inbox combining Facebook and Instagram is documented as a pattern. Sources: https://help.front.com/t/q5249n, https://help.front.com/en/articles/2206.

**Meta channels.** Facebook: connect Pages, manage DMs, posts, comments. Instagram: needs Business account linked to a Page, Creator accounts unsupported, edited messages do not sync, replies only within 7 days of the customer message. Sources: https://help.front.com/en/articles/2067, https://help.front.com/en/articles/2021.

**Automation.** Rules: trigger, condition, action. Rule limits per plan (10 Starter, 20 Professional, unlimited Enterprise per pricing page: https://front.com/pricing).

**Dashboard, contact management, onboarding.** Unverified.

**Pricing** (https://front.com/pricing, per seat per month, billed annually): Starter $25 (up to 10 seats, single channel type), Professional $65 (up to 50, omnichannel, SSO/SCIM), Enterprise $105 (AI routing, unlimited rules, custom roles). Autopilot AI from $0.39 per conversation; Copilot $20 per seat on lower tiers.

**Mobile.** See section 11.

---

## 9. Chatwoot

**Positioning.** Open-source support inbox, cloud or self-hosted. Source: https://www.chatwoot.com/pricing.

**Information architecture.** Conversations live in inboxes; each inbox has its own agents, business hours, greetings, pre-chat form and routing rules. Setup path Settings > Inboxes > Add Inbox. Instagram is its own channel using Instagram Business Login with no Facebook Page dependency; self-hosted Facebook/Instagram needs your own Meta app and app approval. Sources: https://chatwoot.com/docs/user-guide/add-inbox-settings, https://www.chatwoot.com/hc/user-guide/articles/1677778588-how-to-setup-a-facebook-channel, https://developers.chatwoot.com/self-hosted/configuration/features/integrations/instagram-channel-setup.md.

**Automation.** No-code rules (trigger, conditions, actions) on Business and Enterprise; agent bots via webhook. Source: https://www.chatwoot.com/use-cases/automation-routing.

**Dashboard, contact management, onboarding.** Unverified.

**Pricing** (https://www.chatwoot.com/pricing, cloud, per agent per month): Hacker $0 (2 agents, 500 conversations, live chat only), Startups $19, Business $39 (adds Teams, automation, voice), Enterprise $99 (SSO, audit logs). Captain AI credits extra at $20 per 1,000. 15-day trial. Self-hosted pricing: unverified.

**Mobile.** See section 11.

---

## 10. Comparison matrix

"Entry" is the cheapest paid or usable tier found. "n/v" means not verified.

| Product | Core focus | Entry price (USD) | Pricing unit | Meta DMs | Visual automation | Auto-assign | Mobile app (iOS rating, count) |
|---|---|---|---|---|---|---|---|
| Manychat | Social DM automation | n/v (third party: ~$14 to $17 Essential) | Active contacts | Yes (IG, Messenger) | Flow Builder | Paid Inbox tier | 4.25 (2,185) |
| respond.io | Multi-channel team inbox | $79/mo yearly | Plan plus users plus contacts | Yes (channel list) | Workflows | Round robin, least open | 4.29 (17) |
| Kommo | Pipeline-first CRM plus chat | $25 per user | Per seat | Yes | Salesbot, pipeline automation (Advanced+) | n/v | 4.0 (13) |
| HubSpot | General CRM plus service | $0 (2 users); Starter $7 to $20 per seat | Per seat | Messenger yes; Instagram not in article | Workflows (details n/v) | Owner dropdown, rules n/v | 4.74 (15,898) |
| GoHighLevel | Agency suite, white-label | $97/mo | Flat plus usage | n/v | Node-based workflows | n/v | 4.46 (3,694) |
| Intercom | Support helpdesk plus AI | $19 per seat (new) | Seat plus per outcome | Yes (FB, IG) | Workflows (Advanced+) | Round robin, limits | 2.13 (173) |
| SleekFlow | WhatsApp-led omnichannel | $49/mo yearly | Plan plus seats | Social comments, IG | Advanced Flow Builder | Via flow action | 4.36 (11) |
| Front | Shared inbox, email-led | $25 per seat | Per seat | Yes (FB, IG with limits) | Rules (capped) | Manual, rules, AI routing (Enterprise) | 3.30 (209) |
| Chatwoot | Open-source support inbox | $0 (2 agents); $19 per agent | Per agent | Yes | Rules (Business+) | Per-inbox routing | 3.93 (15) |

Apple ratings from iTunes search API, 2026-11-13. Intercom's app listed is "Intercom Conversations" (seller Intercom, Incorporated); which Intercom app is current is unverified. GoHighLevel also publishes a second app, "Lead Connector" (4.53, 4,013), so the count above is for the "HighLevel" app only.

---

## 11. Mobile competitor section

### Per-app findings

| App | Navigation and inbox | Push | Offline | Store signals |
|---|---|---|---|---|
| Manychat | Mobile can open and edit web-built flows but not create new ones, except Instagram flows (Story replies, comment auto-replies, Quick DM). Advanced config, workspace, integrations on web. Source: https://help.manychat.com/hc/en-us/articles/19858378137756-Manychat-Mobile-App (via search; direct fetch 403) | n/v | n/v | iOS 4.25 from 2,185 ratings. Recent 1 to 2 star reviews cite comment automations not firing and a recurring error after "preview + post" (2026-10-23 to 10-27). |
| respond.io | Four tabs: Notifications, Inbox, Calls, Settings. Inbox views All, Mine, Unassigned; long-press quick actions; swipe-free search after 3 characters. Dashboard, Contacts, AI Agents, Broadcasts, Workflows, Reports are web-only; cannot create Team/Custom inboxes. Source: https://respond.io/help/mobile-app/mobile-app-overview | Instant notifications plus call alerts; iOS needs Background App Refresh; Android needs battery optimization off | Offline messages queued and retried | iOS 4.29 (17). Min Android 7, iOS 15.1. |
| Kommo | Pipelines, lead cards, tasks, inbox; admin role needed for full access. Channel connection, pipeline structure, automations, email integration, duplicate merge are desktop-only. Source: https://support.kommo.com/docs/app-overview.md | Alerts for messages, tasks, mentions; types set on desktop | Not stated | iOS 4.0 (13); 1-star reviews: crashes (2025-05), Meta CAPI stopped sending events (2026-03). |
| HubSpot | Conversations inbox: filter, reply, comment/mention, reassign, close, move inbox, edit contact, see SLA labels, set Away. Android-only ticket management; migrated knowledge base articles cannot be shared from mobile. Source: https://knowledge.hubspot.com/inbox/use-conversations-on-the-hubspot-mobile-app | Notification settings configured on desktop (community answer): https://community.hubspot.com/t5/Mobile-Application/Shared-Inbox-in-Android-app/m-p/440532 | Inbox offline: unverified. Service Hub offline ticket mode mentioned by HubSpot blog: https://blog.hubspot.com/service/mobile-customer-service-software | iOS 4.74 (15,898). Recent 1-star: "CRM of a thousand clicks", update broke functions. |
| HighLevel | Fewer features than desktop; building workflows needs desktop; "+" menu adds SMS, email, contact, opportunity, appointment per tab. Source: https://help.gohighlevel.com/en/support/solutions/articles/155000001702 (via search snippet) | Needs enabling in GHL and at OS level (third party); community request that notifications go only to assigned user: https://ideas.gohighlevel.com/conversations/p/conversation-notifications-should-only-go-to-assigned-user-for-mobile-app | n/v (third party: weak connection delays updates) | iOS 4.46 (3,694). Reviews: multi-account switching limit (2026-11-05), extra tap to clear notifications after an update (2026-10-01). Task created on mobile not appearing in desktop task dashboard (community): https://highlevel.canny.io/mobile-app/p/critical-mobile-tasks-issue-tasks-created-in-the-mobile-app-do-not-appear-in-the |
| Intercom | Reply, notes, mentions, reassign, snooze, close, tags, macros (content only), tickets (customer only). No assignment-rule editing, reports, file attach, dark mode, Copilot. App is in maintenance mode. Source: https://www.intercom.com/help/en/articles/447-respond-to-users-and-visitors-on-the-go-with-the-intercom-conversations-app | Mobile push settings in app; tapping a push can switch workspace and persist | n/v | iOS 2.13 (173), the lowest in the set. Last release 2026-09-11. |
| SleekFlow | App 2.0 mirrors web for contacts, inbox, catalog, payment links, settings. Native file sharing, AI Smart Reply, writing assistant, WhatsApp quick reply and list messages, swipe-to-reply. Source: https://sleekflow.io/blog/sleekflow-mobile-app (page last modified 2026-05-06) | Not covered by that article: unverified | Offline: view history and contacts, compose and send, create contacts; syncs on reconnect | iOS 4.36 (11). |
| Front | Bottom bar: inbox, calendar, compose, settings; sidebar mirrors desktop; multi-select; Send & Archive, Send Later, Send & Snooze. No templates, rules, inbox, or full contact management on mobile. Source: https://help.front.com/en/articles/4907072 | Actions in push (Comment, Mark as Read, Archive); DND and quiet schedule; which pushes to receive is set on desktop/web | Download open conversations from past 30 days; offline drafts send on reconnect | iOS 3.30 (209). Reviews 2026-11-03/10: inbox stops updating until app force-closed, update nags, old UX preferred. |
| Chatwoot | Marketing page claims instant push, sync, assign, notes, canned responses, macros, file sharing, self-hosted URLs. Source: https://chatwoot.com/mobile-apps. Needs server 3.13.0 or higher, React Native/Expo. Source: https://developers.chatwoot.com/contributing-guide/mobile-app | Official relay for official apps; custom builds need Firebase; deep link into the conversation | n/v | iOS 3.93 (15). 1-star reviews: slow, limited, cannot edit/delete messages (2026-03, 2026-10). |

### Cross-cutting observations

1. Nearly every competitor treats mobile as a reply-and-triage client. Configuration (automation, channels, billing, inbox creation) is desktop-only. Sources above, strongest in respond.io, Kommo, Front, Manychat, Intercom.
2. Notification preferences are frequently desktop-configured (Front, Kommo, HubSpot), which is a small but real friction.
3. Offline support is rare and shallow: only Front (30-day download plus drafts), SleekFlow 2.0, and respond.io (queued messages) document it.
4. Higher-rated apps from larger vendors (HubSpot 4.74) still draw complaints about update-driven regressions; the lowest-rated (Intercom 2.13, Front 3.30) are in maintenance or have reliability issues.
5. Meta-specific reliability (comment automations not firing, CAPI events dropping) is the dominant complaint category for the Meta-first tools (Manychat, Kommo).
6. Review sample is small (most reviews retrieved were the latest few 1 to 2 star ones from the RSS feed) and Google Play data is unverified, so these are signals, not statistics.

---

## 12. Patterns worth adopting

1. Default inbox views of Mine, Unassigned, All with filters by status, channel, assignee, and saved custom views (respond.io, HubSpot, Intercom, Front). Sources in sections 2, 4, 6, 8.
2. Assignment as an explicit, inspectable step with two strategies at launch: round robin with online-only, and least open conversations (respond.io). Add per-agent caps (Intercom). Source: respond.io assignment article; Intercom assignment article.
3. Assignment is a label on a shared inbox rather than a move (Front, Intercom views), so teammates keep visibility.
4. Canvas workflow builder with a test mode (QR or chat link), a template library, and a required-error gate before save (respond.io). Source: https://respond.io/help/workflows/workflows-overview.md.
5. Per-conversation "one automation at a time" with visible priority (Intercom) to stop collisions.
6. Mobile app with offline outbox and quiet-hours and push quick actions (Front, respond.io, SleekFlow). Sources in section 11.
7. Pipeline-style CRM view tied to the chat thread (Kommo) for sales use.
8. Instagram Business Login without requiring a Facebook Page link (Chatwoot's direction) to reduce setup friction. Source: Chatwoot channel docs above.

## 13. Patterns to avoid

1. Gating assignment and teams behind a separate paid Inbox tier or seat type (Manychat community thread; Kommo AI credits per seat). Creates pricing confusion.
2. Contact-based pricing that jumps on restructure (Manychat third-party reports of conflicting current prices): unpredictable cost for creators.
3. Six-month minimum with no monthly billing (Kommo): hostile to solo and trial-stage users. Source: https://kommo.com/pricing/.
4. "Round robin only once" (Intercom): conversations that become unassigned are not redistributed. Source: Intercom assignment article.
5. Edit-requires-stop on published workflows that ejects active contacts (respond.io). Source: respond.io workflows overview.
6. Mobile apps that cannot receive context or settings (desktop-only notification prefs, no contact management) and that diverge from web UX after rewrites (Front reviews).
7. Silent failure of Meta triggers (Manychat community and reviews: flows not live, permissions stale, dark posts unsupported). Surface health status instead.
8. Hard feature cliffs by plan for basics such as AI agents, broadcast or automation (SleekFlow Essential lacks them; Chatwoot automation only Business+).

## 14. Differentiation opportunities for a solo-founder product

These are inferences from the gaps above, not verified market demand.

1. Meta-first reliability and transparency: a per-channel health panel (token expiry, permission status, webhook last received, 24-hour/7-day window state). Competitor complaints concentrate on silent failure (Manychat reviews, Kommo CAPI review). Front documents a 7-day Instagram reply window; showing the window per conversation is cheap to build.
2. Mobile as a first-class client rather than a triage-only companion: offline outbox, quick-action pushes, configuration of notification prefs in-app (which Front, Kommo, HubSpot leave to desktop), and basic automation toggling (pause/resume) from phone. Manychat and GoHighLevel explicitly send automation building to desktop.
3. Predictable flat pricing with monthly billing and clear limits, undercutting seat-heavy products (Intercom Advanced $85, Front Professional $65 per seat) and avoiding Kommo's six-month lock. Prices of competitors in this document are the basis.
4. Simple assignment built in at the free level (round robin online-only, least-open, per-agent cap) since competitors gate it.
5. A narrow ICP (for example SMBs and creators using Instagram/WhatsApp who need a light CRM) instead of the agency or enterprise breadth of GoHighLevel and HubSpot.
6. Solo-founder constraint: skip voice, email, help center, AI-agent resale, and white-label at launch; competitors bundle these and charge for them.

Risks: Meta app review and Business verification lead time (unverified durations), and Instagram messaging restrictions (7-day window, Business accounts only per Front docs). Verify against Meta's own documentation before committing a roadmap.

---

## 15. Source list (all retrieved 2026-11-13)

Pricing: https://respond.io/pricing, https://kommo.com/pricing/, https://www.hubspot.com/pricing/crm, https://www.gohighlevel.com/pricing, https://www.intercom.com/pricing, https://sleekflow.io/pricing, https://front.com/pricing, https://www.chatwoot.com/pricing. Manychat: https://www.blotato.com/blog/manychat-pricing (third party; official page 403).

Docs: https://respond.io/help/workflows/workflows-overview.md, https://respond.io/help/convert-leads/assignment-strategy-automatic-contact-distribution-load-balancing.md, https://respond.io/help/mobile-app/mobile-app-overview, https://support.kommo.com/docs/kommo-interface, https://support.kommo.com/docs/app-overview.md, https://knowledge.hubspot.com/inbox/use-the-conversations-inbox, https://knowledge.hubspot.com/inbox/use-conversations-on-the-hubspot-mobile-app, https://www.intercom.com/help/en/articles/11961281-manage-and-troubleshoot-assignment-workflows, https://www.intercom.com/help/en/articles/447-respond-to-users-and-visitors-on-the-go-with-the-intercom-conversations-app, https://help.sleekflow.io/en_US/advanced-flow-builder, https://sleekflow.io/blog/sleekflow-mobile-app, https://help.front.com/en/articles/4907072, https://help.front.com/en/articles/2067, https://help.front.com/en/articles/2021, https://chatwoot.com/mobile-apps, https://developers.chatwoot.com/contributing-guide/mobile-app, https://help.gohighlevel.com/en/support/solutions/articles/155000001702.

Store data: Apple iTunes search and review RSS (see Method), app pages e.g. https://apps.apple.com/us/app/manychat/id1460129210, https://apps.apple.com/us/app/hubspot/id1107711722, https://apps.apple.com/us/app/frontapp/id983808769.
