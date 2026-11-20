# Shared content: Settings > Notifications redesign (use exactly this)

Problem: today the page is a plain list of five checkboxes ("Lead assigned to you", "Lead record assigned to you", "Task assigned to you", "Task reminders", "Import finished") with a one-line description each, titled "Notification preferences: Choose which alerts you receive. Personal to you." It does not show what a notification looks like, does not separate reminders (time-based, need action) from updates (things that happened), and gives no sense of channels. Redesign it to be friendly and clear, without inventing features that do not exist.

## Product facts (do not break)
- Preferences are PERSONAL to the signed-in person (not workspace-wide). Every role can change their own.
- Today only IN-APP notifications exist (the bell panel). Each type has one on/off switch, saved the moment it changes, with a visible "Saved" confirmation and a plain error with recovery if it fails (state "Could not save. Try again.").
- Email and push are NOT built. If shown, they must be visibly unavailable with a reason ("Not available yet"), never a working-looking switch. Same for anything else not built (quiet hours, digests: do not show them).
- The bell opens a panel with two groups: REMINDERS (time-based, need you: task or follow-up due soon) and UPDATES (things that happened). Updates have filters All, Leads, Inbox, System.
- Notification types (exact labels and descriptions):
  Reminders: "Task reminders": "A task or follow-up you own is about to be due." (on)
  Updates: "Lead assigned to you": "Someone makes you the owner of a lead." (on); "Lead record assigned to you": "Someone makes you the owner of a lead record." (on); "Task assigned to you": "Someone assigns a task to you." (on); "Import finished": "A lead import you started has completed." (off in the demo, to show an off state)
- Sample notification texts for previews (what the panel shows): Reminder: "Follow up: Md. Arafatuzzaman. Due in 15 min." and "Overdue: Send quotation to Rahim Uddin. 2 h ago." Updates: "New lead assigned to you: Nusrat Jahan (Full home renovation)", "Sagor Hossen assigned you the task Prepare renewal deck", "Import finished: 124 leads imported, 3 skipped".
- Presets are allowed ONLY as shortcuts that set the same switches: "Everything", "Only what needs me" (Task reminders + Task assigned + Lead assigned on, others off), "Nothing" is NOT offered (a person should not silently lose reminders): turning the last reminder off asks "Turn off task reminders? You will not be told when a follow-up is due." with Turn off / Keep on.

## Frame (fixed)
Settings of workspace "RenoDevs Team" (home renovation company, Dhaka). Today Fri 20 Nov 2026. User Tanvir Ahmed (Owner). Settings left menu: Workspace: General, Notifications (active); CRM data: Lead fields, Lead stages; AI and automation: AI and automation; Channels: Integrations, Web chat, Ad measurement; Team and security: Members, Audit log. Page title "Notifications" with one plain sentence under it. States to show via the demo-state control: normal / loading skeleton / save error (a toggle fails and rolls back with the message) / all off warning (reminders off).
