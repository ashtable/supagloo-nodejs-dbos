import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptSecret } from "@supagloo/database-lib";
import type { PrismaClient } from "@supagloo/database-lib";
import {
  GlooNotConnectedError,
  OpenRouterNotConnectedError,
} from "./errors";
import { loadGlooCredential, loadOpenRouterCredential } from "./credentials";

// The credential-load step decrypts a per-user provider secret at call time
// (design §7 "provider call patterns"). It REUSES db-lib's AES-256-GCM primitive
// (never reimplements crypto): a real key + a real `encryptSecret` ciphertext, a
// fake prisma returning the stored row. The point of these tests is that the
// PLAINTEXT (not the ciphertext) comes back, and a missing connection is a typed,
// non-retryable failure.

const KEY = randomBytes(32).toString("hex");

/** A prisma double exposing just the connection delegate a loader reads. */
function fakePrisma(overrides: Record<string, unknown>): PrismaClient {
  return {
    openRouterConnection: {
      findUnique: async () => overrides.openRouter ?? null,
    },
    glooConnection: {
      findUnique: async () => overrides.gloo ?? null,
    },
  } as unknown as PrismaClient;
}

describe("loadOpenRouterCredential", () => {
  it("decrypts the stored ciphertext back to the plaintext API key", async () => {
    const apiKey = "sk-or-v1-realsecret-abcd";
    const prisma = fakePrisma({
      openRouter: {
        userId: "user-1",
        apiKeyCiphertext: encryptSecret(apiKey, KEY),
        keyLast4: apiKey.slice(-4),
        status: "connected",
      },
    });

    const cred = await loadOpenRouterCredential({
      prisma,
      userId: "user-1",
      encryptionKey: KEY,
    });

    expect(cred.apiKey).toBe(apiKey);
  });

  it("throws OpenRouterNotConnectedError when there is no connection row", async () => {
    const prisma = fakePrisma({});
    await expect(
      loadOpenRouterCredential({ prisma, userId: "user-1", encryptionKey: KEY }),
    ).rejects.toBeInstanceOf(OpenRouterNotConnectedError);
  });
});

describe("loadGlooCredential", () => {
  it("returns the plaintext clientId + decrypted clientSecret", async () => {
    const clientSecret = "gloo-super-secret-value";
    const prisma = fakePrisma({
      gloo: {
        userId: "user-1",
        clientId: "gloo-client-id-123",
        clientSecretCiphertext: encryptSecret(clientSecret, KEY),
        status: "connected",
      },
    });

    const cred = await loadGlooCredential({
      prisma,
      userId: "user-1",
      encryptionKey: KEY,
    });

    expect(cred.clientId).toBe("gloo-client-id-123");
    expect(cred.clientSecret).toBe(clientSecret);
  });

  it("throws GlooNotConnectedError when there is no connection row", async () => {
    const prisma = fakePrisma({});
    await expect(
      loadGlooCredential({ prisma, userId: "user-1", encryptionKey: KEY }),
    ).rejects.toBeInstanceOf(GlooNotConnectedError);
  });
});
