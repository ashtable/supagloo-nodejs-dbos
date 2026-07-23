import { encryptSecret, type PrismaClient } from "@supagloo/database-lib";
import { mintGlooToken, type MintGlooTokenArgs, type GlooToken } from "../providers/gloo";

/**
 * E2E provider-connection seeding helper (design-delta §10.3), the dbos analogue of the
 * api-side `src/testing/seed-connections.ts` from task 34-E3 — same SHAPE, different
 * mechanism. dbos is deliberately self-contained (no calls to the API container / its
 * connect routes — §10.3 rejected-alternative, §9-Q9 addendum), so this seeds by writing
 * the connection rows DIRECTLY with db-lib's Prisma client, encrypting the REAL secret:
 *
 *   • OpenRouter — write the row with `encryptSecret(OPENROUTER_E2E_TEST_API_KEY)`. NO
 *     provider-side verify (faithful to the real route: a browser-PKCE-obtained key is
 *     stored without a round-trip). The ciphertext is nonetheless live-valid because the
 *     key is the real dedicated test key.
 *   • Gloo — FIRST mint a live client-credentials token against the real Gloo host (reuse
 *     dbos's own `mintGlooToken`, the exact call the API's `verifyClientCredentials`
 *     makes) and FAIL the setup if it doesn't succeed; ONLY THEN write the row with
 *     `encryptSecret(GLOO_CLIENT_SECRET)`. A mint failure aborts — never a fabricated row.
 *
 * Net effect: no fabricated ciphertexts or dummy keys anywhere in the dbos e2e.
 *
 * TEST-ONLY infrastructure (imported by the generate-*.e2e.ts specs), excluded from the
 * shipped `dist/` build (tsconfig.build.json excludes `src/testing/**`). The failure-mode
 * logic is factored out here — not inlined in a spec — so it unit-tests with an INJECTED
 * prisma + env + `mintToken` without a live provider (`seed-connections.test.ts`).
 */

export const OPENROUTER_E2E_KEY_VAR = "OPENROUTER_E2E_TEST_API_KEY";
export const GLOO_CLIENT_ID_VAR = "GLOO_CLIENT_ID";
export const GLOO_CLIENT_SECRET_VAR = "GLOO_CLIENT_SECRET";
export const YOUVERSION_APP_KEY_VAR = "YOUVERSION_APP_KEY";

/**
 * The environment variables the real-provider e2e seeding requires, in a stable order.
 * Single source of truth for the fail-fast validation.
 *
 * `YOUVERSION_APP_KEY` (task 34-E5) is required here too: the reintroduced passage-kind
 * generate-script e2e hits the LIVE YouVersion Data Exchange host (both endpoints 401
 * without it), so a missing key must fail e2e setup loudly rather than silently degrade —
 * per plan.md's global "a missing secret fails e2e setup fast" policy.
 */
export const GENERATION_SEED_ENV_VARS = [
  OPENROUTER_E2E_KEY_VAR,
  GLOO_CLIENT_ID_VAR,
  GLOO_CLIENT_SECRET_VAR,
  YOUVERSION_APP_KEY_VAR,
] as const;

type EnvSource = Record<string, string | undefined>;

export interface GenerationSeedCreds {
  /** Real OpenRouter API key (`OPENROUTER_E2E_TEST_API_KEY`) — dedicated low-balance (§10.9). */
  openrouterKey: string;
  /** Real, live-verifiable Gloo OAuth2 client id (`GLOO_CLIENT_ID`). */
  glooClientId: string;
  /** Real, live-verifiable Gloo OAuth2 client secret (`GLOO_CLIENT_SECRET`). */
  glooClientSecret: string;
  /** Real YouVersion Platform app key (`YOUVERSION_APP_KEY`) — the live `x-yvp-app-key`. */
  youversionAppKey: string;
}

/**
 * Resolve the four real provider credentials from the environment, failing FAST with an
 * actionable message naming any missing/empty var (empty/whitespace === missing). Pure +
 * env-injectable for unit testing. These vars are NOT part of the validated `Env` schema —
 * read directly (api-side precedent).
 */
export function resolveGenerationSeedCreds(
  env: EnvSource = process.env,
): GenerationSeedCreds {
  const read = (name: string): string => {
    const value = env[name];
    if (value === undefined || value.trim() === "") {
      throw new Error(
        `dbos real-provider e2e seeding requires the environment variable ${name} to be ` +
          `set to a live-valid provider credential (see .env.example / design-delta §10.8), ` +
          `but it is missing or empty. Export the e2e secrets before running the ` +
          `real-provider suite, e.g. \`set -a; . ./.env; set +a\`. The real-provider e2e ` +
          `must never silently skip — a green suite that skipped is a lie.`,
      );
    }
    return value;
  };
  return {
    openrouterKey: read(OPENROUTER_E2E_KEY_VAR),
    glooClientId: read(GLOO_CLIENT_ID_VAR),
    glooClientSecret: read(GLOO_CLIENT_SECRET_VAR),
    youversionAppKey: read(YOUVERSION_APP_KEY_VAR),
  };
}

export interface SeedOpenRouterConnectionArgs {
  prisma: PrismaClient;
  userId: string;
  /** The REAL OpenRouter API key to encrypt + store. */
  apiKey: string;
  /** 64-hex AES-256-GCM key (db-lib encryptSecret contract). */
  encryptionKey: string;
}

/**
 * Seed the user's OpenRouter connection by writing the row directly with the real key
 * encrypted at rest. No provider-side verify (matches the real route). The stored
 * ciphertext decrypts back to `apiKey`, which the generation workflow uses against live
 * OpenRouter.
 */
export async function seedOpenRouterConnection(
  args: SeedOpenRouterConnectionArgs,
): Promise<void> {
  await args.prisma.openRouterConnection.create({
    data: {
      userId: args.userId,
      apiKeyCiphertext: encryptSecret(args.apiKey, args.encryptionKey),
      keyLast4: args.apiKey.slice(-4),
      status: "connected",
    },
  });
}

export interface SeedGlooConnectionArgs {
  prisma: PrismaClient;
  userId: string;
  /** The REAL Gloo OAuth2 client id. */
  clientId: string;
  /** The REAL Gloo OAuth2 client secret to encrypt + store. */
  clientSecret: string;
  /** 64-hex AES-256-GCM key (db-lib encryptSecret contract). */
  encryptionKey: string;
  /** e.g. `https://platform.ai.gloo.com` — the live host to mint against. */
  glooBaseUrl: string;
  /** Injectable for unit tests; defaults to the real {@link mintGlooToken}. */
  mintToken?: (args: MintGlooTokenArgs) => Promise<GlooToken>;
  /** Injectable `fetch` threaded to the mint call (unit tests); defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Seed the user's Gloo connection. Mirrors the api's verify-then-store: FIRST mint a live
 * client-credentials token against the real Gloo host (the exact call
 * `verifyClientCredentials` makes) and FAIL the seed if it doesn't succeed — surfacing an
 * actionable error, never swallowing or retrying, and writing NO row. ONLY on a successful
 * mint is the row written, with the client secret encrypted at rest.
 */
export async function seedGlooConnection(
  args: SeedGlooConnectionArgs,
): Promise<void> {
  const mint = args.mintToken ?? mintGlooToken;
  try {
    await mint({
      glooBaseUrl: args.glooBaseUrl,
      clientId: args.clientId,
      clientSecret: args.clientSecret,
      fetchImpl: args.fetchImpl,
    });
  } catch (cause) {
    throw new Error(
      `dbos e2e Gloo seeding: the live Gloo client-credentials mint against ` +
        `${args.glooBaseUrl} FAILED, so NO connection row was written — aborting the seed ` +
        `rather than fabricating a row. Check that ${GLOO_CLIENT_ID_VAR}/` +
        `${GLOO_CLIENT_SECRET_VAR} are live-valid. Cause: ${(cause as Error).message}`,
      { cause },
    );
  }
  await args.prisma.glooConnection.create({
    data: {
      userId: args.userId,
      clientId: args.clientId,
      clientSecretCiphertext: encryptSecret(args.clientSecret, args.encryptionKey),
      status: "connected",
    },
  });
}
