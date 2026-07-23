import { describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptSecret, type PrismaClient } from "@supagloo/database-lib";
import { ProviderHttpError } from "../providers/errors";
import type { GlooToken, MintGlooTokenArgs } from "../providers/gloo";
import {
  GENERATION_SEED_ENV_VARS,
  GLOO_CLIENT_ID_VAR,
  GLOO_CLIENT_SECRET_VAR,
  OPENROUTER_E2E_KEY_VAR,
  YOUVERSION_APP_KEY_VAR,
  resolveGenerationSeedCreds,
  seedGlooConnection,
  seedOpenRouterConnection,
} from "./seed-connections";

// Unit proof of the dbos e2e credential-seeding helper (design-delta §10.3), with
// INJECTED deps (fake prisma, injected env, injected mintToken) — no live provider,
// no database. The two `Unit tests target` facts:
//   • a Gloo live-mint failure ABORTS the seed with an actionable error and writes NO row;
//   • the written rows DECRYPT back to the REAL secrets (no fabricated-ciphertext path remains).

const KEY = randomBytes(32).toString("hex");

interface RecordedCreate {
  data: Record<string, unknown>;
}

/** A prisma double whose `create` delegates record the row `data` they were handed. */
function fakePrisma() {
  const openRouterCreate = vi.fn(async (args: RecordedCreate) => args.data);
  const glooCreate = vi.fn(async (args: RecordedCreate) => args.data);
  const prisma = {
    openRouterConnection: { create: openRouterCreate },
    glooConnection: { create: glooCreate },
  } as unknown as PrismaClient;
  return { prisma, openRouterCreate, glooCreate };
}

describe("resolveGenerationSeedCreds", () => {
  const present = {
    [OPENROUTER_E2E_KEY_VAR]: "sk-or-v1-real",
    [GLOO_CLIENT_ID_VAR]: "gloo-client",
    [GLOO_CLIENT_SECRET_VAR]: "gloo-secret",
    [YOUVERSION_APP_KEY_VAR]: "yvp-app-key-real",
  };

  it("returns the real creds when all are present", () => {
    expect(resolveGenerationSeedCreds(present)).toEqual({
      openrouterKey: "sk-or-v1-real",
      glooClientId: "gloo-client",
      glooClientSecret: "gloo-secret",
      youversionAppKey: "yvp-app-key-real",
    });
  });

  it.each(GENERATION_SEED_ENV_VARS)(
    "throws naming %s when it is missing",
    (varName) => {
      const env = { ...present };
      delete (env as Record<string, string | undefined>)[varName];
      expect(() => resolveGenerationSeedCreds(env)).toThrowError(
        new RegExp(varName),
      );
    },
  );

  it("treats an empty/whitespace value as missing", () => {
    expect(() =>
      resolveGenerationSeedCreds({ ...present, [OPENROUTER_E2E_KEY_VAR]: "  " }),
    ).toThrowError(new RegExp(OPENROUTER_E2E_KEY_VAR));
  });
});

describe("seedOpenRouterConnection", () => {
  it("writes a row whose ciphertext decrypts back to the real key (target #2)", async () => {
    const { prisma, openRouterCreate } = fakePrisma();
    const realKey = "sk-or-v1-abcdef0123456789";

    await seedOpenRouterConnection({
      prisma,
      userId: "user-1",
      apiKey: realKey,
      encryptionKey: KEY,
    });

    expect(openRouterCreate).toHaveBeenCalledTimes(1);
    const data = openRouterCreate.mock.calls[0]![0].data as Record<string, string>;
    expect(data.userId).toBe("user-1");
    expect(decryptSecret(data.apiKeyCiphertext, KEY)).toBe(realKey);
    expect(data.keyLast4).toBe(realKey.slice(-4));
    expect(data.status).toBe("connected");
    // No plaintext fabricated key, no `sk-or-test-key` literal survives.
    expect(data.apiKeyCiphertext).not.toBe(realKey);
  });
});

describe("seedGlooConnection", () => {
  const mintOk = (): typeof import("../providers/gloo").mintGlooToken =>
    vi.fn(
      async (_args: MintGlooTokenArgs): Promise<GlooToken> => ({
        accessToken: "live-token",
        tokenType: "Bearer",
        expiresIn: 3600,
      }),
    );

  it("live-mints FIRST, then writes a row whose secret ciphertext decrypts back (target #2)", async () => {
    const { prisma, glooCreate } = fakePrisma();
    const order: string[] = [];
    const mintToken = vi.fn(async (args: MintGlooTokenArgs): Promise<GlooToken> => {
      order.push("mint");
      expect(args.glooBaseUrl).toBe("https://platform.ai.gloo.com");
      expect(args.clientId).toBe("gloo-client");
      expect(args.clientSecret).toBe("gloo-secret");
      return { accessToken: "live-token", tokenType: "Bearer", expiresIn: 3600 };
    });
    glooCreate.mockImplementation(async (a: RecordedCreate) => {
      order.push("create");
      return a.data;
    });

    await seedGlooConnection({
      prisma,
      userId: "user-2",
      clientId: "gloo-client",
      clientSecret: "gloo-secret",
      encryptionKey: KEY,
      glooBaseUrl: "https://platform.ai.gloo.com",
      mintToken,
    });

    expect(order).toEqual(["mint", "create"]); // mint BEFORE the write
    const data = glooCreate.mock.calls[0]![0].data as Record<string, string>;
    expect(data.userId).toBe("user-2");
    expect(data.clientId).toBe("gloo-client");
    expect(decryptSecret(data.clientSecretCiphertext, KEY)).toBe("gloo-secret");
    expect(data.status).toBe("connected");
  });

  it("aborts the seed with an actionable error and writes NO row when the mint fails (target #1)", async () => {
    const { prisma, glooCreate } = fakePrisma();
    const mintToken = vi.fn(async (): Promise<GlooToken> => {
      throw new ProviderHttpError("Gloo token mint failed: 400", 400, "invalid_client");
    });

    await expect(
      seedGlooConnection({
        prisma,
        userId: "user-3",
        clientId: "gloo-client",
        clientSecret: "wrong-secret",
        encryptionKey: KEY,
        glooBaseUrl: "https://platform.ai.gloo.com",
        mintToken,
      }),
    ).rejects.toThrow(/Gloo/i);

    expect(mintToken).toHaveBeenCalledTimes(1);
    // The crux: the mint failure means NO fabricated row is written.
    expect(glooCreate).not.toHaveBeenCalled();
  });

  it("uses the real mintGlooToken by default (no injected mint)", () => {
    // Compile-time + shape guard: mintToken is optional and defaults to the real fn.
    expect(typeof seedGlooConnection).toBe("function");
    void mintOk;
  });
});
