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
const HTTP_URL = /^https?:\/\/.+/;

/** The DBOS application name (DBOS.setConfig `name`). Fixed, not env-configured. */
export const DBOS_APP_NAME = "supagloo-dbos";

const postgresUrl = (label: string) =>
  z
    .string()
    .min(1)
    .refine((value) => POSTGRES_URL.test(value), {
      message: `${label} must be a postgres:// or postgresql:// connection string`,
    });

/**
 * A provider base URL: http(s), with the REAL provider URL as the default so
 * production needs zero config; the test Compose overlay overrides it to a stub
 * URL. Adopts supagloo-nodejs-api's identical `refine`-based check + var names
 * (Task #9 convention) so the two services agree.
 */
const providerBaseUrl = (label: string, defaultUrl: string) =>
  z
    .string()
    .min(1)
    .refine((value) => HTTP_URL.test(value), {
      message: `${label} must be an http:// or https:// base URL`,
    })
    .default(defaultUrl);

export const envSchema = z.object({
  // App database (`supagloo`) — the workflow's app-DB writes go here.
  DATABASE_URL: postgresUrl("DATABASE_URL"),
  // DBOS system database (`supagloo_dbos`) — DBOS checkpoints/queues.
  DBOS_DATABASE_URL: postgresUrl("DBOS_DATABASE_URL"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Task #17 GitHub App (design-delta §2.3/§7). App-LEVEL secrets — one pair per
  // app registration, shared by API and DBOS, NOT per-user — so they live in env
  // (bypassing §2.10's per-user encryption). The git-ops workflows sign short-lived
  // App JWTs (`GITHUB_APP_ID` issuer + `GITHUB_APP_PRIVATE_KEY`) to mint installation
  // tokens. Required — fail-fast at boot. Names copied verbatim from the API's loader.
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1),

  // GitHub REST API host (installation tokens, reachability, PRs). Verbatim from api.
  GITHUB_API_BASE_URL: providerBaseUrl("GITHUB_API_BASE_URL", "https://api.github.com"),
  // Git clone/push host. In prod this is github.com (same host as the OAuth flow);
  // in test it must point at the LOCAL git-server, NOT the REST stub, so it is its
  // OWN var (dbos is the only git client — the API never clones). Default matches
  // prod git-over-HTTPS: `https://github.com/<owner>/<repo>.git`.
  GITHUB_GIT_BASE_URL: providerBaseUrl("GITHUB_GIT_BASE_URL", "https://github.com"),
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
