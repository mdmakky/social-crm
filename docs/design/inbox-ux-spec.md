# Inbox UX specification (web)

Date: 2026-11-13. Status: **design only. Nothing here is built or verified.** Source of truth for behaviour is `docs/architecture/meta-inbox-plan.md` (sections 2, 5, 6, 8, 10 slice 4); visual language is "Quiet precision" in `docs/design/design-system.md` (light-first, `#F6F7F9` canvas, white surfaces, subtle borders, charcoal text, one indigo accent, no gradients or glass, controls 32px fine / 44px coarse). Voice per `PRODUCT.md`: plain, precise, calm; controls name their action; errors name the problem and the recovery.

Anything beyond the plan is marked **(proposal)**. Mobile (Expo) is out of scope; "mobile" below means the web app at 375 px.

## 1. Principles
1. Truthful state: delivery and channel health are shown as they are ("Delivery unknown", never a fake "sent").
2. No dead buttons: an unavailable action is shown disabled with a visible reason.
3. Human decides ambiguity: unknown sends are never retried or failed silently.
4. Message bodies are personal data (section 12).
5. Reuse existing components; add only what the inbox needs (section 14).

## 2. Layout by breakpoint
Shell is unchanged: sidebar 248 px (lg+), icon rail 56 px (md), drawer below md, topbar 52 px. The inbox is a route `/w/[workspaceId]/inbox` and `/w/[workspaceId]/inbox/[conversationId]` (the URL carries the selected conversation so back, reload and deep links from notifications work). Inbox panels fill the content height (no 1120 px max width for this route **(proposal)**: the three-pane needs the room; other routes keep the cap).

### 2.1 Desktop 1440 (and 1280+): three panes
```
+--------+---------------------+--------------------------------+-------------------+
|Sidebar | Inbox   [Search...] | (A) Maria Lopez  [FB] Messenger | Contact           |
| 248    | [Open v][Anyone v]  |     Open v   Assign: Me v   ... |  Maria Lopez      |
|        |---------------------|--------------------------------|  maria@...        |
|        | (M) Maria Lopez  2m | Mon 9 Nov                      |  Lead: Spring...  |
|        |  [FB] Is the blue.. *| [in]  Hi, is the blue one      |  Stage: Qualified |
|        | (J) Jon Park    1h  |       available?               |  Tasks (2)        |
|        |  [IG] Thanks!       | [out] Yes, 3 in stock.   Sent  |  Open contact >   |
|        | ...                 | [note] Internal: VIP  (yellow  |  Open lead >      |
|        |  (load more sentinel)|        bar, lock icon)        |                   |
|        |                     |--------------------------------|                   |
|        | 340 px              | Composer (state banner + box)  | 300 px            |
+--------+---------------------+--------------------------------+-------------------+
```
List 340 px, thread flexible (min 480), context 300 px. Context pane is collapsible (button and `c`), collapsed state remembered per user in localStorage (try/catch; renders correctly without it).

### 2.2 Desktop 1024 and tablet 768: two panes
- 1024 (lg, sidebar 248): list 320 px + thread. Context pane becomes a right-side Dialog-style sheet opened by the "Contact" button in the thread header.
- 768 (md, rail 56): list 300 px + thread (about 410 px). Same sheet for context. Composer stays pinned to the bottom of the thread.
```
+----+---------------+------------------------+
|Rail| list 300      | thread  [Contact]      |
|    |  rows...      |  messages              |
|    |               |  composer              |
+----+---------------+------------------------+
```

### 2.3 Mobile 375: single pane with back
- `/inbox` shows only the list. Selecting a row navigates to `/inbox/[id]`, which shows only the thread with a header back button ("< Inbox", 44 px target) that returns to the list preserving scroll position, filters and search text (filters live in the URL query so Back restores them).
- Context opens as a full-height sheet from the header "Contact" button. Filters collapse behind one "Filters" button (sheet) with a count badge. Composer is sticky above the on-screen keyboard (`100dvh` layout, `env(safe-area-inset-bottom)`); inputs use 16 px text (no iOS zoom).
```
List view            Thread view
+----------------+   +----------------+
|Inbox  [Search] |   |<Inbox Maria [FB]|
|[Filters (1)]   |   |Open v  Me v  i  |
|(M) Maria   2m  |   |  messages       |
| [FB] Is the..* |   |                 |
|(J) Jon     1h  |   |[composer] [Send]|
+----------------+   +----------------+
```

## 3. Conversation list
Row (comfortable density ~64 px on all widths; compact 40 px is not offered **(proposal: skip density modes, design system says not done)**):
- Avatar (existing `Avatar`, initials) with the channel mark overlapping bottom-right (section 4).
- Line 1: contact name (semibold if unread), relative time at right (tabular numerals; `title`/`<time datetime>` gives the absolute time).
- Line 2: last message preview, one line, truncated; prefix "You: " for outbound; "Note: " never appears in preview (notes do not drive `last_message_at`, see 7). Delivery state glyph for outbound last message only when `failed` or `unknown` (danger/warning tone plus text "Failed" / "Unconfirmed"), so problems surface in the list.
- Right edge: unread count badge (accent `Badge`, numeric, "99+" cap), status chip only when not `open` ("Pending", "Resolved"), assignee avatar (16 px) or nothing when unassigned.
- Selected row: surface tint `accent-subtle` plus a 2 px left bar (not colour only; `aria-current="true"`).
- Whole row is one `<a>` (link to the conversation); list is `<ul>` with `role` list semantics, not a grid, so Tab order stays simple; arrow keys are an enhancement (section 11).

Order: `last_message_at` descending (server, cursor paginated). Unread is not a separate sort; it is a filter.

Pagination: cursor, 30 per page, infinite load via a "Load more" button plus an IntersectionObserver trigger (button remains for keyboard and failure retry). Budget: p95 under 300 ms at 10,000 conversations (plan section 8), measured in the slice-4 performance check with the same method as other lists. List responses carry no message bodies other than the 140-character preview.

## 4. Channel indicators (Messenger, Instagram)
Not colour-only. Each conversation shows a small badge combining **icon + text label + colour**:
- List row: 16 px circular mark on the avatar corner with the platform glyph; `aria-label` is not on the mark alone: the row's accessible name includes "Messenger" or "Instagram" as text (visually hidden `sr-only` span "via Messenger").
- Thread header and context pane: `Badge` with glyph and the word "Messenger" / "Instagram" plus the connected account name ("Acme Page").
- Glyphs differ in **shape** (speech bubble vs camera outline), so they are distinguishable in greyscale. Platform brand colour only on the small glyph, per design system ("platform brand colors only for small channel badges"). Mock mode adds a visible "Mock" badge in the header and list (plan section 3: mock is labelled).
- Channel filter (section 9) offers All, Messenger, Instagram.

## 5. Status, assignment, ownership, unread
### 5.1 Status (open, pending, resolved)
- Header control: `DropdownMenu` button showing the current status as text plus icon (open = circle, pending = clock, resolved = check). Items: Open, Pending, Resolved. Changing is optimistic with rollback and toast on failure; sends `version` for optimistic concurrency (plan: `conversations.version`); a version conflict shows "This conversation changed. Reloaded." and refreshes.
- Semantics (proposal wording): Open = needs a reply; Pending = waiting on the customer or someone else; Resolved = done.
- A new inbound message on a `resolved` conversation reopens it to `open` (proposal, server rule; state it in the UI as a system line "Reopened by new message"). Pending also returns to open on inbound (proposal).
- Permission: `conversation.reply` roles (owner, admin, agent) may change status; viewers see the status as plain text.

### 5.2 Assignment and ownership
- Header "Assign" control uses the existing `Select`/`DropdownMenu` pattern from the leads Owner filter (Anyone / Me / members).
- **Per the matrix (plan section 5.6): owner and admin may assign to anyone; agents may assign only to themselves** (take it, or release it back to unassigned **(proposal: unassign own conversation is allowed; confirm with permissions matrix)**). For an agent the member list is not offered; the control is a single button "Assign to me" / "Unassign me", never a disabled long list. Viewers: read-only text "Assigned to X".
- Server enforces `conversation.assign`; a 403 shows a toast "You can only assign conversations to yourself" and restores the previous value.
- Assignment fires `conversation.assigned` notification to the assignee (plan section 8). Assignment change appears in the thread as a centered system line ("Assigned to Sam by Alex", with time).
- "Ownership" for permission checks stays as in `docs/architecture/permissions.md` ("own" = assigned to the actor); replying is allowed on any visible conversation.

### 5.3 Unread
- Per user via `conversation_reads (conversation_id, user_id, last_read_message_id)`. List unread badge and bold name come from the unread count for the current user. **Note (flagged gap)**: the plan's `conversations.unread_count` is one number on the conversation row, while `conversation_reads` is per user; for multi-agent teams the badge must be derived per user. Resolve in Slice 4 API design; until then, single-owner behaviour is the target. **(proposal)**
- Marking read: when the thread is open, the tab is visible and the user has scrolled to the newest message (or it is within the viewport), post the watermark (debounced 500 ms). Not on mere list selection when the tab is hidden.
- "Mark as unread" action in the header menu (keyboard `u`) (proposal; implies moving the watermark backwards).
- Document title shows "(n) Inbox" total unread; the existing notification bell is unchanged.
- A "New messages" divider line (not colour only: text label) separates already-read from unread messages on open and stays until the thread is left.

## 6. Thread panel
Header: back (mobile), avatar, contact name (link to contact), channel badge, status control, assign control, "Contact" (sheet on md/lg), overflow menu (mark unread, copy link, open lead / create lead (links to existing Leads dialog)).

Body: scroll container, `role="log"` with `aria-live="polite"` and `aria-relevant="additions"`, `aria-label="Conversation with Maria Lopez"`. Day separators ("Mon 9 Nov"). Messages grouped by sender within 5 minutes (avatar shown once per group). Inbound left, outbound right, using white vs `accent-subtle` bubbles with a 1 px border; direction is also given by an `sr-only` prefix "Maria said" / "You said" / "Sam said" and the sender label above groups. Attachments render as link rows (type icon, file type text, "Open attachment", opens in new tab with `rel="noopener noreferrer"`); no inline fetching of platform URLs on our server; links may have expired ("Attachment unavailable, link expired" if it fails) (plan: URLs only, expire at the platform).

Older history: cursor pagination upward ("Load earlier messages" button at the top; position is preserved after prepend). Ordering is by platform `sent_at` then `created_at`, so late messages slot in place without jumping the viewport (anchor to the first visible message).

Scroll rule: if the user is within 80 px of the bottom, new messages scroll into view; otherwise show a "N new messages" pill (button, announces via the live region) that scrolls to the bottom. Never steal scroll.

### 6.1 Internal notes (proposal, later slice)
The plan has **no internal-note concept**; the `messages` table models only `in`/`out` with a platform id, so storing a note as a message would risk it being sent. Proposal for a later slice, not Slice 4:
- Separate table **`conversation_notes`** (`id`, `workspace_id`, `conversation_id`, `author_user_id`, `body`, `created_at`, `edited_at`, `deleted_at`), forced RLS, composite FK to conversations. Notes have no `delivery_state`, no `client_msg_id`, are never read by the sender worker, and the sender has no grant on the table. This makes "never sent to the platform" structural rather than a flag. Interleaved with messages by `created_at` in the API response as a distinct item type.
- Visual: full-width (not a bubble), warning-subtle background, dashed 1 px border, lock icon and the text label "Internal note, not sent" in every note header; `sr-only` "Internal note by Sam". Author name and time shown. The composer has a clear mode switch (tabs "Reply" and "Note", not just a toggle colour) and in Note mode the send button reads "Add note" and the platform window banner is hidden (notes work when the window is closed).
- Body is personal data: erased with the contact (same anonymisation).
- Permission: `conversation.note` for owner/admin/agent; viewers do not see notes **(proposal; confirm)**.
- Until built: no Note tab, no mention in the UI.

### 6.2 Saved replies (proposal, later slice)
Workspace table `saved_replies` (`id`, `workspace_id`, `title`, `body`, `created_by`, `version`), picker opened by `/` in an empty composer inserting text into the draft (never sends automatically). Variables ({{first_name}}) are a further step. Not in Slice 4; do not render a button for it.

## 7. Composer and the 24-hour window
Server-side check at send time is authoritative (plan 5.5); the UI reflects `last_inbound_at` and integration status. States (one banner area above the textbox, `role="status"` for passive changes and `role="alert"` only for a newly blocking error):

| State | Trigger | Composer | Banner text |
|---|---|---|---|
| open | now < last_inbound_at + 24h, account `connected`, role may reply | enabled | none (small hint "Replies allowed until 14:32 tomorrow" under the box, shown only in the last 6 hours) |
| closing soon | under 2 hours left (proposal threshold; 2 h) | enabled | Warning: "The 24-hour reply window closes in 1 h 20 min (at 14:32). After that you can't reply until Maria writes again." Live countdown updates every minute, announced only at 2 h, 30 min, 5 min (not every tick) |
| closed | 24 h passed, or no inbound | textbox and Send disabled, reason in text; draft kept | "You can't reply: more than 24 hours have passed since Maria's last message. Meta only allows replies within 24 hours. You can reply as soon as she writes again." (HUMAN_AGENT 7-day option is not offered until D-C is decided) |
| reauth_required | integration_account `reauth_required` | disabled; drafts and `pending` messages stay | Danger Alert: "Reconnect Acme Page to send messages. Messages you write are kept and will send after you reconnect." plus a "Reconnect" button for owner/admin or text "Ask an owner or admin to reconnect" for others (see 10) |
| disabled account | `disabled` | disabled | "This Page was disconnected. History is kept; you can't send." |
| viewer | no `conversation.reply` | not rendered; read-only note | "You have read-only access." |
| delivery unknown | last outbound message is `unknown` | **still enabled** (decision: do not block new messages; **proposal**, but the banner warns that the earlier message may or may not have arrived, to reduce duplicates) | "Your previous message may not have been delivered. Check it before sending again." anchored in the message itself (section 8) |

Behaviour:
- Enter sends, Shift+Enter newline (setting-free default). IME composition (`isComposing`) never sends. On coarse pointers Enter inserts a newline and the Send button sends **(proposal)**.
- Text limit shown near the limit (Meta text limit 2000 characters; **unverified**, confirm in slice 6); over limit disables Send with text "Message is 214 characters too long".
- Drafts per conversation kept in memory and `localStorage` (try/catch, personal data caveat: cleared on sign-out **(proposal)**).
- Double click cannot double send: Send is disabled while the optimistic row is created; the `client_msg_id` is generated once per composed message and reused if the request is repeated (plan 5.1).
- Attachment upload is **not built** (plan non-goal): no paperclip button.

## 8. Delivery status per message
Outbound messages show a status line under the bubble (text plus icon, never colour alone):

| State | Label | Icon | Notes |
|---|---|---|---|
| pending | "Queued" | clock | Waiting for the worker, or for reconnect when the account is `reauth_required` ("Queued, waiting for reconnect") |
| sending | "Sending" | spinner (static dot under reduced motion) | |
| sent | "Sent" + time | check | `sent` is the platform acceptance; it does not claim "read" or "delivered" (receipts are separate and out of scope for the first UI **(proposal: omit read receipts)**) |
| failed | "Not sent: <reason>" | warning triangle | reason is the stored class mapped to copy (window closed, recipient unavailable, permission/token, rate limited). Actions: "Retry" (creates a new `client_msg_id`, plan 5) and "Copy text" |
| unknown | "Delivery unknown" | question circle, warning tone | see 8.1 |

Inbound messages show no state. `aria-label`s of the status line are the visible text.

### 8.1 Unknown-send UI (plan section 5.4, D-G)
Shown inside the message, as a bordered warning block under the bubble:
- Heading: "Delivery unknown"
- Before the reconciliation window ends (default 10 minutes from the message time; the value is the workspace setting, not hard-coded in copy): "We could not confirm that Meta received this message. We're checking for the confirmation until 14:42 (about 8 minutes left). Please don't resend yet." The plan shows the two actions after the window; **(proposal)** both buttons are rendered from the start but disabled, with the visible text "Available at 14:42", so the user knows what comes next.
- After the window with no echo: "We could not confirm this message was delivered. Check the conversation in the Facebook or Instagram app, then choose one:" with two buttons of equal weight (secondary, not primary, so neither is the default):
  - **"Mark as not sent"** : outcome becomes `failed` ("Marked as not sent by Sam") and "Retry" becomes available. Sub-hint: "Use this if the customer did not receive it."
  - **"It was delivered"** : outcome becomes `sent` ("Confirmed delivered by Sam"). Sub-hint: "Use this if the customer received it."
- No confirmation dialog (a human is already making an explicit choice); to avoid mis-clicks the buttons are separated by 12 px and each carries its hint. Result is a toast and an inline system line ("Marked as not sent by Sam at 14:44"). The choice is audited server-side (plan 5.4); the UI does not offer an undo.
- If an echo arrives while the block is visible, it flips to "Sent" and the block disappears with a live-region announcement "Message confirmed sent".
- Permission: `conversation.reply` roles. Viewers see the block as text with no buttons.
- The list row for the conversation shows "Unconfirmed" (section 3) so unresolved unknowns are findable; filter "Needs attention" (section 9) includes `failed` and `unknown` last-outbound **(proposal)**.

### 8.2 Optimistic send rules (consistent with the state graph)
- UI inserts the message locally as `pending` immediately with the client-generated `client_msg_id`; the API call creates/returns the row. The local row is replaced by the server row by `client_msg_id`, never duplicated.
- The UI never invents transitions the graph forbids: it shows only server-confirmed `sending/sent/failed/unknown`. Optimism is limited to the `pending` row and to status/assignment edits (with rollback).
- Network error on the create call: the row stays `pending` locally with "Not sent yet. Retrying..." and the same `client_msg_id` is replayed safely (idempotent create); after repeated failure it becomes a local "Couldn't reach the server. Retry" with the same id (no new id: nothing was accepted by the server). This is distinct from `failed -> pending` which uses a new `client_msg_id` after a server-confirmed failure.
- A `unknown` message is never auto-retried by any client logic.
- `failed -> Retry` creates a new message row (new `client_msg_id`), keeping the failed one in the thread as history.

## 9. Search and filters
- Filters reuse the leads-view pattern (`Select` with `aria-label`, URL query state, "Clear" ghost button with `FilterX`): Status (Open default, Pending, Resolved, All), Assignee (Anyone, Me, Unassigned, member names; agents see the same list for filtering, only assignment is restricted), Channel (All, Messenger, Instagram), Unread only (checkbox/toggle), Needs attention **(proposal)** (failed/unknown last outbound, `reauth_required` account).
- Text search in the list header filters by contact name and message body using the **existing global search provider registry** (`apps/api/src/search/registry.ts`, additive `conversations` provider, plan 8; respects `requires` and tenant scope). The same provider feeds the command menu (`CommandMenu` groups by `g.type`): result type "Conversation" with contact name, channel and snippet; selecting navigates to `/inbox/[id]`. Search is debounced 250 ms, minimum 2 characters, announces "N results" through a `role="status"` region (same as leads-view `announce`).
- Search snippets contain personal data: not written to client logs or analytics; never cached in localStorage.
- Pagination: cursor, 30 rows, filters and search are part of the cursor key; changing a filter resets the list and focus stays on the changed control. p95 budget under 300 ms at 10,000 conversations (plan 8), list payload excludes bodies beyond the preview; unread-only and status filters need supporting indexes (a Slice 1/4 DB concern, flagged not specified here).
- Mobile: filters behind a "Filters" sheet with Apply/Clear; search field always visible.

## 10. Reconnect banner and permissions
- Banner at the top of the inbox route (above list and thread), persistent while any connected account is `reauth_required` (also shown inside affected threads via the composer state). Danger `Alert`: "Acme Page needs to be reconnected. Incoming messages are still being saved, but you can't send replies." with button "Reconnect" (owner/admin; links to the settings integrations screen built in Slice 3) or text "Ask an owner or admin to reconnect it." for agents and viewers. Not dismissible; it disappears when status returns to `connected`. After reconnect, queued messages resume "in order" (plan 6) and rows flip from "Queued, waiting for reconnect" to Sending/Sent through the realtime channel.
- No integration connected at all: full-page empty state (section 13), not a banner.
- Permission-denied: role without inbox read (none expected now; viewers can read) sees the existing forbidden state component used elsewhere ("You don't have access to the inbox. Ask an owner to change your role."). Navigation item hidden by role as per nav policy, but a direct URL shows the forbidden state, never a blank screen. A conversation id from another workspace or non-existent: "This conversation isn't available" (same response for both; no existence leak).

## 11. Keyboard shortcuts and accessibility
Shortcuts are enabled only when focus is not inside a text input/textarea/contenteditable (except the ones marked "in composer"); a `?` help dialog lists them (`Kbd` component). They must never be the only way to do anything (design system: visible alternative control).

| Key | Action |
|---|---|
| `j` / `k` | Next / previous conversation in list (moves focus to the row, opens it on Enter) |
| `Enter` | Open focused conversation, move focus to the thread |
| `Esc` | From thread, return focus to the selected list row (on mobile = back); closes sheets |
| `r` | Focus the composer |
| `e` | Set status resolved (with toast "Resolved. Undo") **(proposal: undo)** |
| `a` | Assign to me |
| `u` | Mark as unread (proposal) |
| `c` | Toggle context pane |
| `/` | Focus list search (the command menu keeps its own shortcut) |
| `?` | Shortcut help |
| `Ctrl/Cmd+Enter` | Send, in composer (alongside Enter) |

### Accessibility targets (WCAG 2.2 AA; axe has zero serious/critical violations on every inbox state)
- Landmarks: list is `<nav aria-label="Conversations">` or `<section aria-label>`; thread `<main>`-nested `<section aria-label="Conversation with ...">`; composer `<form>`.
- Live regions: (1) thread `role="log"` polite for new messages (announce "Maria: <body>" only for inbound messages, truncated to 200 chars, never replayed on initial load or on prepend of older history); (2) one global polite `role="status"` for list changes ("3 new messages in Inbox", throttled to one announcement per 10 s); (3) `role="alert"` only for new send failures and `reauth_required`. Bodies are personal data but are the content the user is reading; they are not copied into the document title or notifications beyond what the notification settings already do.
- Focus management: opening a conversation from the list moves focus to the thread heading (`tabIndex=-1`) on Enter/click on desktop; on mobile after navigation focus goes to the thread heading, and Back restores focus to the originating row. After sending, focus stays in the composer. After "Retry", "Mark as not sent" and "It was delivered" focus moves to the resulting status line (it replaces the focused button, so focus must not be lost to `body`). Dialogs/sheets trap focus and restore it on close (existing `Dialog`).
- Targets: 44 px on coarse pointers (design system), 24x24 CSS px minimum on fine pointers (WCAG 2.2 target size). Focus ring from `@layer base`, not obscured by the sticky composer (WCAG 2.2 focus not obscured: scroll-padding-bottom equals composer height).
- Status icons and colour: every state has text; contrast checked by the existing token assertions (4.5:1 text, 3:1 UI); warning and danger tones use the `*-fg` on `*-bg` pairs.
- Reduced motion: no spinner animation, no smooth scroll; countdown updates are textual.
- Time: `<time datetime>` elements; relative times have absolute `title` and sr text.
- Drag/gesture: none required (WCAG 2.2 dragging). No swipe actions on web.
- Zoom/reflow: usable at 400% (single-pane layout) and with text spacing overrides.

## 12. Realtime (SSE) and privacy
- Transport: SSE with resume (`Last-Event-ID`), same-origin through the existing proxy (the browser never sees platform tokens; only the session cookie). Fallback to polling every 15 s (list) and 5 s (open thread) when SSE fails, with backoff. **No SSE exists in the codebase today** (checked: no `EventSource` or `text/event-stream` use); plan slice 7 builds SSE, so Slice 4 UI ships with polling behind the same client hook and swaps transport later.
- Events: `message.created`, `message.delivery_state_changed`, `conversation.assigned`, `conversation.status_changed`, `conversation.read`, `integration.status_changed`. Event payloads carry ids and state only, **not message bodies**: the client refetches the affected resource (keeps bodies off the event stream and logs **(proposal)**).
- Connection state indicator: small status in the list header ("Live", "Reconnecting...", "Offline, updates paused") as text plus icon; announced politely on change. On reconnect, refetch list head and the open thread, then reconcile by ids (idempotent merge by `message.id` and `client_msg_id`, never duplicate).
- Out-of-order: apply events by `version`/`sent_at` monotonic rules; a stale event never regresses `delivery_state` (state graph moves forward only in the UI view except via explicit human actions).
- Multiple tabs: each tab has its own stream; the read watermark is sent only from the visible tab.
- Privacy: no tokens or secrets in any response, URL, DOM or client log (plan hard requirement 5); no message bodies in URLs, `localStorage` (except per-conversation drafts, cleared on sign-out) or error reports; no bodies in analytics; browser console logging of payloads forbidden; "Copy text" is explicit user action. The failure reason shown is a class, never a platform error excerpt. Search queries are not stored. Erasure of a contact renders as "[Erased contact]" with message bodies replaced by "[Message erased]" while counts/delivery metadata remain (plan 8). Platform user ids (PSID/IGSID) are not displayed in the UI (shown only in admin diagnostics, not built).

## 13. Empty, loading, error states
| Surface | Loading | Empty | Error |
|---|---|---|---|
| List | 6 `Skeleton` rows shaped like rows, `aria-busy` + `role="status"` "Loading conversations" | No integration: `EmptyState` "Connect a Facebook Page or Instagram account to start receiving messages" with action to the integrations settings (owner/admin) or "Ask an owner to connect one" (others). Connected, no conversations: "No conversations yet. New messages appear here as soon as customers write." Filtered: "No conversations match these filters" with Clear | `ErrorState` with Retry; a failed "load more" shows an inline row error with Retry while keeping loaded rows |
| Thread | Skeleton bubbles | Conversation with no messages (rare): "No messages yet"; no selection (desktop): "Select a conversation" placeholder | `ErrorState` "Couldn't load this conversation" with Retry; 404/forbidden as in section 10 |
| Context pane | Skeleton | "No lead linked" with "Create lead" (existing new-lead dialog) | Inline error, rest of the inbox unaffected |
| Send | n/a | n/a | Per section 8 (failed/unknown), never a silent failure |

## 14. Components mapped to existing code
Existing (reuse as is): `Button`, `Input`, `Select`, `Field`, `Badge`, `Avatar`, `Skeleton`, `EmptyState`, `ErrorState`, `Alert`, `Panel`, `PageHeader`, `DropdownMenu`, `Dialog`, `Tooltip`, `Kbd`, `useToast`/`ToastProvider`, `CommandMenu` (add a Conversation result group via the search registry), `NotificationBell` (existing unread plumbing; `conversation.assigned` uses it), leads-view filter/announce pattern, `ContactPicker` (link or change contact), `new-lead-dialog` (create lead from conversation), tasks view patterns for list+detail.

New (in `apps/web/components/inbox/`, proposal for file names; all built from the existing `ui` primitives, no new dependency):
- `ConversationList`, `ConversationRow`, `InboxFilters`
- `ChannelBadge` (icon + text, section 4)
- `ThreadHeader`, `StatusMenu`, `AssignControl`
- `MessageLog` (role=log, grouping, new-message pill), `MessageBubble`, `DeliveryStatus`, `UnknownSendBlock`
- `Composer`, `WindowBanner`
- `ReconnectBanner`, `ConnectionIndicator`
- `ContactPanel` (compose existing contact/lead data; sheet variant below lg)
- `useInboxStream` (SSE with polling fallback) and a small `useConversationQuery` cursor hook following leads-view

## 15. Responsive verification checklist (Playwright, plus axe on each)
For 375, 768, 1024, 1440, light theme, with fixtures covering each composer and delivery state:
1. Layout panes as in section 2; no horizontal page scroll; sticky composer not covered by keyboard (375 emulated viewport shrink).
2. Back button at 375 restores list scroll and filters; deep link to `/inbox/[id]` works.
3. Context pane is a sheet at 768/1024 and a column at 1440; focus trap and Esc work.
4. All states in sections 7, 8, 13: closing soon, closed, reauth_required, queued while reauth, unknown (before and after window), failed, empty, loading, error, forbidden.
5. Keyboard-only run: j/k/Enter/Esc/r/e/a, no focus loss after status or unknown actions.
6. Live-region test: inbound message during thread open announces once; history prepend announces nothing.
7. Target sizes 44 px (coarse emulation) and 24 px minimum (fine).
8. axe: zero serious/critical violations at every width and state; contrast assertions green.
9. Reduced motion and 200% zoom pass.
10. No tokens, bodies or PSIDs in network URLs, console, or stored data (grep the run).
Artifacts (screenshots per width and state) are recorded in `docs/project/testing-report.md` during Slice 4; this document does not claim any of it as done.

## 16. Must NOT be built yet
- Internal notes and saved replies (proposals only, later slices).
- Attachment upload, voice, emoji reactions, inline image previews fetched by our server, read-receipt display.
- AI suggested replies, auto-replies, automations, bulk actions, merge conversations.
- HUMAN_AGENT tag UI (D-C undecided), broadcast or marketing messages, comment threads, Lead Ads in the inbox.
- WhatsApp, TikTok, LinkedIn channel UI.
- Typing indicators, presence, and collision detection ("Sam is replying") **(proposal for later)**.
- Dark theme tuning, density modes, swipe gestures, the mobile (Expo) inbox.
- Any claim that Messenger or Instagram works: until slice 6 records real requests, every channel screen built on the mock adapter shows the "Mock" label.

## 17. Open questions for the owner (proposals pending)
1. Can an agent release (unassign) a conversation they own, or only owner/admin?
2. Reopen rule on inbound for `pending` and `resolved` (section 5.1).
3. Should viewers see internal notes (section 6.1)?
4. Per-user unread derivation from `conversation_reads` versus the single `conversations.unread_count` (section 5.3).
5. Is Meta's message length limit 2000 characters (unverified, confirm in slice 6)?
