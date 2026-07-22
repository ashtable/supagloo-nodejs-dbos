import { decryptSecret, type PrismaClient } from "@supagloo/database-lib";
import {
  GlooNotConnectedError,
  OpenRouterNotConnectedError,
} from "./errors";

/**
 * Credential-load step helpers (design-delta §7 "provider call patterns"). At call
 * time the generation workflow reads the user's connection row and decrypts the
 * at-rest secret with db-lib's AES-256-GCM primitive — REUSED, never reimplemented
 * (memory openrouter-gloo-connections-built). The plaintext is used for a single
 * provider call and never persisted.
 *
 * Pure functions with an injected `prisma` + `encryptionKey` (the DBOS step passes
 * `getAppDb()` + `getProviderConfig().secretsEncryptionKey`), so they unit-test in
 * isolation against a fake prisma with real crypto.
 */

export interface LoadCredentialArgs {
  prisma: PrismaClient;
  userId: string;
  /** 64-hex AES-256-GCM key (db-lib decryptSecret contract). */
  encryptionKey: string;
}

export interface OpenRouterCredential {
  apiKey: string;
}

export interface GlooCredential {
  clientId: string;
  clientSecret: string;
}

/** Load + decrypt the user's OpenRouter API key. Throws if not connected. */
export async function loadOpenRouterCredential(
  args: LoadCredentialArgs,
): Promise<OpenRouterCredential> {
  const row = await args.prisma.openRouterConnection.findUnique({
    where: { userId: args.userId },
  });
  if (!row) throw new OpenRouterNotConnectedError(args.userId);
  return { apiKey: decryptSecret(row.apiKeyCiphertext, args.encryptionKey) };
}

/** Load the user's Gloo clientId + decrypt the client secret. Throws if not connected. */
export async function loadGlooCredential(
  args: LoadCredentialArgs,
): Promise<GlooCredential> {
  const row = await args.prisma.glooConnection.findUnique({
    where: { userId: args.userId },
  });
  if (!row) throw new GlooNotConnectedError(args.userId);
  return {
    clientId: row.clientId,
    clientSecret: decryptSecret(row.clientSecretCiphertext, args.encryptionKey),
  };
}
