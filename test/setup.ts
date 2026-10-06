// Applies Kestrel's schema to the isolated test D1 before each test file runs.
// TEST_MIGRATIONS is injected by vitest.config.ts (readD1Migrations).

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";

const migrations = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
await applyD1Migrations(env.DB, migrations);
