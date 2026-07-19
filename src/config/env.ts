import { z } from "zod";

/**
 * Zod-validated environment for the DBOS worker. Scope grows per task (same
 * convention as supagloo-nodejs-api's env loader). Task #15 needs exactly two
 * Postgres connection strings — the crux of "system DB vs app DB URLs":
 *
 *   - DATABASE_URL       → the APP database (`supagloo`). Workflows write domain
 *                          rows here via db-lib's Prisma client.
 *   - DBOS_DATABASE_URL  → the DBOS SYSTEM database (`supagloo_dbos`). DBOS's own
 *                          checkpoints/queues live here; DBOS.setConfig consumes it
 *                          as `systemDatabaseUrl`. DBOS auto-creates its tables here
 *                          on launch — no Prisma migration touches this database.
 *
 * Both names already exist in the root `.env.example` (documented for "tasks
 * api/dbos" to consume). Provider base URLs / secrets / S3 vars are added by the
 * later dbos tasks that use them (17, 29, 32…), adopting supagloo-nodejs-api's
 * identical names + defaults verbatim (api `config/env.ts` line 24).
 *
 * URL-shaped vars are validated with an explicit scheme check (not zod's `.url()`)
 * so the rejection message is precise and version-agnostic across zod releases.
 */
const POSTGRES_URL = /^postgres(?:ql)?:\/\/.+/;

/** The DBOS application name (DBOS.setConfig `name`). Fixed, not env-configured. */
export const DBOS_APP_NAME = "supagloo-dbos";

const postgresUrl = (label: string) =>
  z
    .string()
    .min(1)
    .refine((value) => POSTGRES_URL.test(value), {
      message: `${label} must be a postgres:// or postgresql:// connection string`,
    });

export const envSchema = z.object({
  // App database (`supagloo`) — the workflow's app-DB writes go here.
  DATABASE_URL: postgresUrl("DATABASE_URL"),
  // DBOS system database (`supagloo_dbos`) — DBOS checkpoints/queues.
  DBOS_DATABASE_URL: postgresUrl("DBOS_DATABASE_URL"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parse and validate the environment. Throws a single, actionable error listing
 * every problem when validation fails (fail-fast at boot). Accepts an injected
 * source for testing; defaults to `process.env`.
 */
export function loadEnv(
  source: Record<string, string | undefined> = process.env,
): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration — ${details}`);
  }
  return result.data;
}
