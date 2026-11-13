# Integration Conflict Report

Updated by the integrator as tracks merge. Status as of creation: no track has merged.

| Shared file | Tracks touching it | Expected conflict | Resolution plan | Status |
|---|---|---|---|---|
| `packages/db/drizzle/*` (journal, snapshots) | B, C, D (D likely none) | Numbering collision and snapshot chain | Discard track migration files, regenerate one combined migration from the merged schema, re-append each track's RLS SQL | pending |
| `packages/db/src/schema/index.ts` | B, C | adjacent export lines | manual merge | pending |
| `packages/contracts/src/index.ts` | B, C, D | endpoint spread line | manual merge | pending |
| `apps/api/src/routes/workspaces.ts` | B, C, D | route mount lines | manual merge | pending |
| `packages/core/src/permissions.ts` | B, C | MATRIX entries | manual merge, re-run matrix tests | pending |
| `apps/api/src/routes/contacts.ts` | A remediation, B (task handlers), D (query extraction) | overlapping edits | land A remediation first, then rebase D and B | pending |
| `apps/web/components/shell/app-shell.tsx`, `command-menu.tsx`, `lib/nav.ts` | C, D, B (one each) | none expected | none | pending |
