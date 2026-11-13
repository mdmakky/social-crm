# Roles and Permissions Matrix

Version 0.1 (2026-11-13). Responds to review finding B5. A single policy function `can(actor, action, resource)` in `packages/core` is used by every API handler and by UI gating; role tests iterate this matrix. Row level security protects tenant boundaries; this matrix protects privilege boundaries inside a workspace.

Roles: **owner** (one or more, billing and deletion), **admin**, **agent**, **viewer** (read only). "Own" means assigned to or created by the actor.

| Capability | Owner | Admin | Agent | Viewer |
|---|---|---|---|---|
| View contacts, leads, conversations | yes | yes | yes | yes |
| Create/edit contacts and leads | yes | yes | yes | no |
| Delete or merge contacts | yes | yes | no | no |
| Reply, change status, add internal notes | yes | yes | yes (all conversations in workspace for MVP; per-inbox restriction R2) | no |
| Assign conversations | yes | yes | self only | no |
| Leads: view | all | all | all | all |
| Leads: create/edit/move | all | all | all | no |
| Leads: delete (soft), reopen closed | all | all | no | no |
| Leads: deal value view/edit | all | all | only with an explicit per-lead grant | no |
| Tasks: edit | all | all | own | no |
| Import / export data | yes | yes | no | no |
| Manage custom fields, tags, pipelines | yes | yes | no | no |
| Connect or disconnect integrations | yes | yes | no | no |
| View integration status | yes | yes | yes | no |
| Manage CAPI datasets, mappings, consent policy | yes | yes | no | no |
| View CAPI delivery history | yes | yes | no | no |
| Manage workflows, enable/disable automation | yes | yes | no | no |
| Approve workflow approvals | yes | yes | if named approver | no |
| Configure AI providers, budgets | yes | yes | no | no |
| Use AI suggestions and summaries | yes | yes | yes | no |
| Invite, remove members, change roles | yes | yes (cannot change owners) | no | no |
| Transfer ownership, delete workspace | yes | no | no | no |
| View audit log | yes | yes | no | no |
| Record or change consent | yes | yes | yes | no |
| Data subject export / erasure | yes | yes | no | no |

Rules: the last owner cannot be removed or demoted; role changes and permission-sensitive actions are audited; a user removed from a workspace loses sessions and device push bindings for it immediately; credentials are never readable by any role through the API.
