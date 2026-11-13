import { defineConfig } from "vitest/config";

// Under parallel turbo load the default 10 s hook timeout expired in the contacts-list beforeAll (60 sequential creates plus password hashing),
// vitest then closed the pool mid-hook ("Cannot use a pool after calling end"). Evidence: docs/project/track-b-flaky-report.md.
export default defineConfig({ test: { hookTimeout: 60_000, testTimeout: 30_000 } });
