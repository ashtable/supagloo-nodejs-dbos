import { z } from "zod";
import { CLEANUP_RETENTION_HOURS_DEFAULT } from "../workflows/cleanup-orphaned-assets/selection";

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
// A 32-byte AES-256-GCM key, supplied as 64 hex chars (`openssl rand -hex 32`).
// Matches database-lib `secrets.ts`'s `KEY_HEX` and supagloo-nodejs-api's identical
// `SECRETS_KEY_HEX`; validated here so a misconfigured key fails fast at boot rather
// than on the first decrypt inside a generation workflow.
const SECRETS_KEY_HEX = /^[0-9a-fA-F]{64}$/;

/**
 * The all-zeros key: 64 hex characters, so it passes {@link SECRETS_KEY_HEX}, and a real
 * incident (design-delta §11.7:2309-2318) — `docker-compose.test.yml` overrode the API's
 * key to this value while dbos kept the Compose dev key, so every provider credential the
 * API ENCRYPTED failed `decryptSecret` in this worker. Row 62 deleted that override; plan
 * row 43 / D43.1 makes the value itself un-loadable so it cannot return by another door.
 *
 * WHY NOT the obvious `NODE_ENV === "production"` weak-key gate: `docker-compose.yml`
 * pins `NODE_ENV: production` on BOTH api and dbos AND hardcodes the well-known dev key, so
 * a production-gated rejection would refuse to boot the shipped stack in every lane. The
 * "distinct per environment" half of the row lives where it can actually be checked —
 * root's Compose/`.env.example` guard — and this in-process half rejects only the value
 * with a recorded history of breaking decryption.
 *
 * NOT a per-service rule. api and dbos must carry the IDENTICAL key within an environment
 * (current-design §2.2:99, root `compose-config.test.ts` PART V invariant 5); the message
 * below is byte-identical to the API's for exactly that reason.
 */
const WEAK_SECRETS_KEYS = new Set(["0".repeat(64)]);

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

/**
 * An OPTIONAL model id. Empty/whitespace is treated as absent (see the RENDER_*_MODEL
 * comment below); anything else must be a non-empty id.
 */
const optionalModelId = () =>
  z
    .preprocess(
      (value) =>
        typeof value === "string" && value.trim() === "" ? undefined : value,
      z.string().min(1).optional(),
    )
    .optional();


/**
 * An optional boolean env var. Compose substitutes `${FOO:-}` to the EMPTY STRING when the
 * operator has not defined it, so "" must mean the default rather than a parse failure —
 * the same normalization `optionalModelId` performs for model ids.
 */
const booleanFlag = (label: string) =>
  z
    .preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z
        .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
        .optional(),
    )
    .transform((v) => v === true || v === "true" || v === "1")
    .describe(label);

export const envSchema = z.object({
  // App database (`supagloo`) — the workflow's app-DB writes go here.
  DATABASE_URL: postgresUrl("DATABASE_URL"),
  // DBOS system database (`supagloo_dbos`) — DBOS checkpoints/queues.
  DBOS_DATABASE_URL: postgresUrl("DBOS_DATABASE_URL"),
  // OPTIONAL. The SCHEMA inside that database holding DBOS's checkpoints/queues (the
  // SDK's `systemDatabaseSchemaName`; its default is "dbos"). Name and validation copied
  // VERBATIM from supagloo-nodejs-api's loader, because the two services MUST agree: a
  // schema set on one of them only would leave the api enqueueing into a namespace this
  // worker never polls. Unset in every Compose file — the SDK default is the shipped
  // configuration. It exists for the designed single-database deployment fallback, and
  // the e2e lane passes a per-lane value explicitly so the containerised worker and an
  // in-process runtime cannot race for the same rows.
  DBOS_SYSTEM_DATABASE_SCHEMA: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/, {
      message:
        "DBOS_SYSTEM_DATABASE_SCHEMA must be a lowercase Postgres identifier (letters, digits, underscore; not starting with a digit)",
    })
    .optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Task #17 GitHub App (design-delta §2.3/§7). App-LEVEL secrets — one pair per
  // app registration, shared by API and DBOS, NOT per-user — so they live in env
  // (bypassing §2.10's per-user encryption). The git-ops workflows sign short-lived
  // App JWTs (`GITHUB_APP_ID` issuer + `GITHUB_APP_PRIVATE_KEY`) to mint installation
  // tokens. Required — fail-fast at boot. Names copied verbatim from the API's loader.
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1),

  // GitHub REST API host (installation tokens, reachability, PRs). Verbatim from api.
  // Since task 62 (design-delta §11) this is NEVER overridden anywhere in the system: the
  // github-stub is deleted, `docker-compose.test.yml` overrides no GitHub var, and every
  // e2e spec reaches real api.github.com through this default. `providers.e2e.ts`'s
  // no-stub guard asserts exactly that, so the override path below survives only for a
  // future self-hosted (GitHub Enterprise) deployment.
  GITHUB_API_BASE_URL: providerBaseUrl("GITHUB_API_BASE_URL", "https://api.github.com"),
  // Git clone/push host — its OWN var because dbos is the only git client (the API never
  // clones), and because a self-hosted deployment splits the git host from the REST host.
  // It used to point at the LOCAL git-server in test; that fixture is deleted, so the
  // default IS the test value now: `https://github.com/<owner>/<repo>.git`, cloned with an
  // `x-access-token:<installation token>@` credential.
  GITHUB_GIT_BASE_URL: providerBaseUrl("GITHUB_GIT_BASE_URL", "https://github.com"),

  // Task #29 provider-call layer (design-delta §7). The outbound LLM/media provider
  // hosts + the application-secrets key. Names/defaults/validation copied VERBATIM
  // from supagloo-nodejs-api's env loader so the two services agree (memory
  // openrouter-gloo-connections-built). Real defaults ⇒ prod needs zero config; since
  // task 34-E8 (design-delta §10.7) these base URLs are NOT overridden in test — the
  // OpenRouter/Gloo providers are exercised for real by the e2e suites (the openrouter/
  // gloo/youversion stubs were deleted).
  OPENROUTER_BASE_URL: providerBaseUrl("OPENROUTER_BASE_URL", "https://openrouter.ai"),
  GLOO_BASE_URL: providerBaseUrl("GLOO_BASE_URL", "https://platform.ai.gloo.com"),
  // Task #30 YouVersion Data Exchange (design-delta §7 workflow 5 / §9-Q10). The base URL
  // fetchScripturePassage resolves the Bible collection + passages from (real host default ⇒
  // prod needs zero config; since task 34-E8 the e2e hits the LIVE host, no stub). The passage
  // e2e (34-E5) requires YOUVERSION_APP_KEY; it is the real API's `X-YVP-App-Key` — OPTIONAL at
  // the schema level (public-domain KJV/BSB fallback works without it), sent as a header when
  // present.
  YOUVERSION_BASE_URL: providerBaseUrl("YOUVERSION_BASE_URL", "https://api.youversion.com"),
  YOUVERSION_APP_KEY: z.string().min(1).optional(),
  // The single AES-256-GCM key that decrypts per-user provider secrets (OpenRouter
  // API key, Gloo client secret) via db-lib's decryptSecret inside the generation
  // workflows. A 64-hex-char (32-byte) value, distinct per environment. Required —
  // fail-fast at boot. NOT per-user data; one key per deployment, shared by API + DBOS.
  SECRETS_ENCRYPTION_KEY: z
    .string()
    .refine((value) => SECRETS_KEY_HEX.test(value), {
      message:
        "SECRETS_ENCRYPTION_KEY must be a 64-character hex string (32 bytes); " +
        "generate one with `openssl rand -hex 32`",
    })
    // Plan row 43 / D43.1 — see WEAK_SECRETS_KEYS. Keep this message byte-identical to
    // supagloo-nodejs-api's: the two services share one key, so they must reject the same
    // values with the same words or an operator will think only one of them is unhappy.
    .refine((value) => !WEAK_SECRETS_KEYS.has(value), {
      message:
        "SECRETS_ENCRYPTION_KEY must not be a placeholder key (all zeros); " +
        "generate a real one with `openssl rand -hex 32`",
    }),

  // Task #32 S3 (design-delta §4/§8). The asset-uploading workflows PUT generated media
  // against the INTERNAL endpoint. Names copied VERBATIM from supagloo-nodejs-api's loader so
  // the two services agree. dbos is a WRITER (internal role only), so it needs
  // S3_ENDPOINT + bucket + creds + region; S3_PUBLIC_ENDPOINT is accepted for name-parity with
  // the API but UNUSED here (dbos never presigns). Required (fail-fast) — a wrong/missing
  // endpoint or credential silently breaks uploads.
  S3_ENDPOINT: z
    .string()
    .min(1)
    .refine((value) => HTTP_URL.test(value), {
      message: "S3_ENDPOINT must be an http:// or https:// URL",
    }),
  // Accepted for parity with the API's env; dbos does not presign, so it is unused here.
  S3_PUBLIC_ENDPOINT: z
    .string()
    .refine((value) => HTTP_URL.test(value), {
      message: "S3_PUBLIC_ENDPOINT must be an http:// or https:// URL",
    })
    .optional(),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_REGION: z.string().min(1).default("us-east-1"),

  // Task #34 generateVideo poll tuning (design-delta §7 workflow 8, D4). The durable-sleep
  // interval between video-job polls (design "~30s") and the bounded-loop attempt ceiling
  // (40 × 30s = a 20-minute ceiling). Real defaults ⇒ prod needs zero config; the e2e drops the
  // interval to a fraction of a second (via env) so the poll loop runs fast. Coerced so a string
  // env var ("0.05", "40") parses to a number; both must be positive.
  VIDEO_POLL_INTERVAL_SECONDS: z.coerce
    .number()
    .positive("VIDEO_POLL_INTERVAL_SECONDS must be a positive number of seconds")
    .default(30),
  VIDEO_MAX_POLL_ATTEMPTS: z.coerce
    .number()
    .int("VIDEO_MAX_POLL_ATTEMPTS must be a positive integer")
    .positive("VIDEO_MAX_POLL_ATTEMPTS must be a positive integer")
    .default(40),

  // Task #36 renderWorkflow (design-delta §7 workflow 9). Three child-process kill
  // deadlines: DBOS has no per-step timeout (only workflow-level `timeoutMS`), so the
  // design's "generous step timeout" for renderMedia is implemented as the deadline after
  // which the render child is killed — which doubles as the bound on the untrusted user
  // code we execute. Deliberately generous; real tuning is the load-testing task 45
  // (§9-Q8), which is why they are env vars at all. Coerced so string env vars parse.
  RENDER_MEDIA_TIMEOUT_SECONDS: z.coerce
    .number()
    .positive("RENDER_MEDIA_TIMEOUT_SECONDS must be a positive number of seconds")
    .default(3600),
  RENDER_BUNDLE_TIMEOUT_SECONDS: z.coerce
    .number()
    .positive("RENDER_BUNDLE_TIMEOUT_SECONDS must be a positive number of seconds")
    .default(900),
  RENDER_INSTALL_TIMEOUT_SECONDS: z.coerce
    .number()
    .positive("RENDER_INSTALL_TIMEOUT_SECONDS must be a positive number of seconds")
    .default(900),
  // How often the long render/still steps poll their own DBOS workflow status so a
  // `DBOS.cancelWorkflow` can COOPERATIVELY abort the in-flight Chromium render. Without
  // this, DBOS's own cancellation (which preempts only at the NEXT step boundary) would
  // let a cancelled render burn CPU to completion.
  // Plan row 45 (§9-Q8). Remotion's frame concurrency inside ONE render. Optional with NO
  // default: Remotion defaults it to the CPU count, and each unit is a Chromium tab
  // holding decoded frames — the biggest unbounded memory lever in the pipeline. Unset
  // means "leave Remotion's default alone", because the sizing numbers are extrapolated
  // from Compose (api/dbos are not deployed to Railway), and shipping a guessed default
  // would change every render on the strength of a measurement not yet made.
  // NOT the same knob as QUEUE_CONFIG.render.workerConcurrency (renders per worker = 1,
  // firm since task 36).
  RENDER_MEDIA_CONCURRENCY: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce
      .number()
      .int("RENDER_MEDIA_CONCURRENCY must be a positive integer")
      .positive("RENDER_MEDIA_CONCURRENCY must be a positive integer")
      .optional(),
  ),
  RENDER_CANCEL_POLL_SECONDS: z.coerce
    .number()
    .positive("RENDER_CANCEL_POLL_SECONDS must be a positive number of seconds")
    .default(2),

  // The models the render workflow falls back to when the manifest carries NO cached
  // narration/music asset ref. OPTIONAL WITH NO DEFAULT, deliberately:
  //   - model ids are never hardcoded in source (design §7 / §10.9), so they arrive as
  //     configuration, exactly like the BFF injects provider/model for the studio's
  //     AI actions (task 35);
  //   - unset means the render simply proceeds WITHOUT that track rather than failing —
  //     the normal path is that the studio already generated + committed the refs, so
  //     render-time synthesis is a fallback, not a requirement.
  //
  // Empty string is normalized to `undefined` rather than rejected: Compose's
  // `${RENDER_NARRATION_MODEL:-}` substitution sets the key to "" when the operator has
  // not defined it, and an empty optional model must mean "no fallback", not "fail boot".
  RENDER_NARRATION_MODEL: optionalModelId(),
  RENDER_MUSIC_MODEL: optionalModelId(),

  // Plan row 42 — `cleanupOrphanedAssetsWorkflow`, the scheduled daily janitor.
  //
  // How long a FAILED/CANCELED job's S3 objects are kept before they may be swept.
  // OPTIONAL with a 7-day default, and the default is a SAFETY property rather than a
  // preference: the Compose `dbos` container runs this sweep nightly against the SAME app
  // database and the SAME `supagloo-dev` bucket that the in-process e2e lanes use, and
  // those lanes' fixtures are seconds old. Seven days puts every fixture out of reach by
  // days. (The other half of that safety argument is structural — the schedule is armed
  // only from `src/main.ts`, which no lane loads. See `src/dbos/scheduled-cleanup.ts`.)
  // Session purging is NOT governed by this: sessions go strictly on `expiresAt`.
  CLEANUP_RETENTION_HOURS: z.coerce
    .number()
    .positive("CLEANUP_RETENTION_HOURS must be a positive number of hours")
    .default(CLEANUP_RETENTION_HOURS_DEFAULT),

  // Plan the sweep and report it, mutate nothing. A real operator mode, not a test hook:
  // it defaults to off, carries no `NODE_ENV` branch, and the two destructive steps are
  // SKIPPED wholesale rather than a flag being checked inside a mutation helper.
  CLEANUP_DRY_RUN: booleanFlag("CLEANUP_DRY_RUN"),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Where this validator lives, named in the failure message.
 *
 * Plan row 43 (design-delta §8:1414-1418, §11.3:2034-2042, §11.8:2392-2396): a boot
 * refusal must name the VARIABLE **and** the FILE. "Invalid environment configuration —
 * S3_BUCKET: Required" tells an operator which knob; it does not tell them which of five
 * repos owns it, and `S3_BUCKET` is a name three of them use. Repo-qualified because the
 * message is read out of a merged `docker compose logs` stream.
 */
const ENV_SOURCE_FILE = "supagloo-nodejs-dbos/src/config/env.ts";

/**
 * Parse and validate the environment. Throws a single, actionable error listing
 * EVERY problem when validation fails (fail-fast at boot) — one restart per bad config,
 * not one per bad variable. Accepts an injected source for testing; defaults to
 * `process.env`.
 *
 * Every failure throws; none warns and continues (design-delta §8:1414-1418). The message
 * carries variable names and human remedies but never a VALUE, so it is safe to log as-is.
 */
export function loadEnv(
  source: Record<string, string | undefined> = process.env,
): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `Invalid environment configuration in ${ENV_SOURCE_FILE} — ${details}`,
    );
  }
  return result.data;
}
