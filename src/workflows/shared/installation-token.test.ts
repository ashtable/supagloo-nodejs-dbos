import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SecretCryptoError } from "@supagloo/database-lib";
import { TEST_SECRETS_ENCRYPTION_KEY } from "../../testing/secrets-fixture";
import { clearProviderConfig, setProviderConfig } from "../../providers/config";
import {
  mintEncryptedInstallationToken,
  openInstallationToken,
} from "./installation-token";

/**
 * Plan row 48 — the sealed installation token, unit half.
 *
 * A token-SHAPED sentinel (design-delta §11.8:2467's technique): the assertion is that
 * this exact string never appears in the value the step hands back to DBOS, so it must
 * be distinctive enough that an accidental substring match is impossible.
 */
const SENTINEL = "ghs_SUPAGLOOsentinelTOKEN0123456789abcd";

const h = vi.hoisted(() => ({ mint: vi.fn() }));

vi.mock("@supagloo/database-lib", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  mintInstallationToken: h.mint,
}));

const MINT_ARGS = {
  appId: "12345",
  privateKey: "-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----",
  installationId: "999",
  apiBaseUrl: "https://api.github.com",
};

function configure(secretsEncryptionKey = TEST_SECRETS_ENCRYPTION_KEY): void {
  setProviderConfig({
    openrouterBaseUrl: "https://openrouter.invalid",
    glooBaseUrl: "https://gloo.invalid",
    youversionBaseUrl: "https://youversion.invalid",
    secretsEncryptionKey,
  });
}

beforeEach(() => {
  h.mint.mockReset();
  h.mint.mockResolvedValue({ token: SENTINEL, expiresAt: "2026-01-01T00:00:00Z" });
  configure();
});

afterEach(() => {
  clearProviderConfig();
});

describe("mintEncryptedInstallationToken", () => {
  it("U-IT1: returns a value that is not the token and contains no substring of it", async () => {
    const sealed = await mintEncryptedInstallationToken(MINT_ARGS);

    expect(sealed).not.toBe(SENTINEL);
    expect(sealed).not.toContain(SENTINEL);
    // Not merely "not equal": no recognizable fragment survives either. `ghs_` is the
    // shape a leak-scanner greps for, and the sentinel's distinctive middle is what a
    // naive base64-of-plaintext would preserve.
    expect(sealed).not.toContain("ghs_");
    expect(sealed).not.toContain("SUPAGLOOsentinel");
  });

  it("U-IT2: still mints exactly once per call, with the caller's args untouched", async () => {
    await mintEncryptedInstallationToken(MINT_ARGS);

    expect(h.mint).toHaveBeenCalledTimes(1);
    expect(h.mint).toHaveBeenCalledWith(MINT_ARGS);
  });

  it("U-IT3: a fresh nonce per call — two seals differ, both open to the same token", async () => {
    const a = await mintEncryptedInstallationToken(MINT_ARGS);
    const b = await mintEncryptedInstallationToken(MINT_ARGS);

    expect(a).not.toBe(b);
    expect(openInstallationToken(a)).toBe(SENTINEL);
    expect(openInstallationToken(b)).toBe(SENTINEL);
  });

  it("U-IT4: propagates the mint failure unchanged (no swallow, no empty token)", async () => {
    const boom = new Error("token exchange 401");
    h.mint.mockRejectedValueOnce(boom);

    await expect(mintEncryptedInstallationToken(MINT_ARGS)).rejects.toBe(boom);
  });
});

describe("openInstallationToken", () => {
  it("U-IT5: round-trips the sealed value back to exactly the minted token", async () => {
    const sealed = await mintEncryptedInstallationToken(MINT_ARGS);

    expect(openInstallationToken(sealed)).toBe(SENTINEL);
  });

  it("U-IT6: a DIFFERENT key fails loudly rather than yielding an empty token", async () => {
    const sealed = await mintEncryptedInstallationToken(MINT_ARGS);
    configure("f".repeat(64));

    // AES-GCM's auth tag is what makes this loud: a wrong key cannot silently decrypt to
    // garbage (which a workflow would then push into a clone URL as a broken credential).
    expect(() => openInstallationToken(sealed)).toThrow(SecretCryptoError);
    try {
      openInstallationToken(sealed);
    } catch (err) {
      expect((err as SecretCryptoError).code).toBe("AUTH_FAILED");
    }
  });

  it("U-IT7: a tampered payload fails loudly", async () => {
    const sealed = await mintEncryptedInstallationToken(MINT_ARGS);
    const bytes = Buffer.from(sealed, "base64");
    bytes[bytes.length - 1] ^= 0xff;

    expect(() => openInstallationToken(bytes.toString("base64"))).toThrow(SecretCryptoError);
  });

  it("U-IT8: without provider config it throws the named launch error, not an undefined key", () => {
    clearProviderConfig();

    expect(() => openInstallationToken("anything")).toThrow(/provider config not initialized/);
  });

  /**
   * Step-11 item 36 (R4850-6) — the KEY-ROTATION residual row 48 introduced must be STATED.
   *
   * U-IT6 above already proves the loudness. What it cannot show is the operational
   * consequence: because the decrypt happens in the workflow BODY and the ciphertext is what
   * `operation_outputs` holds, a rotation between the checkpointing execution and any later
   * replay (`recoverPendingWorkflows`, an operator `resumeWorkflow`, or the `forkWorkflow` the
   * publish e2e relies on) fails on the auth tag OUTSIDE any step — no retry budget, no
   * classifier, and the workflow fails on every subsequent replay.
   *
   * Doc-only, so this is a PRESENCE pin, in the same spirit as U-IT6/U-IT7's loudness pins: a
   * stated residual that a later edit silently deletes was never a residual, it was a comment.
   */
  it("U-IT14: the file states the key-rotation replay hazard AND its forkWorkflow recovery", () => {
    const source = readFileSync(join(__dirname, "installation-token.ts"), "utf8");
    // The hazard.
    expect(source).toMatch(/SECRETS_ENCRYPTION_KEY.*ROTATION/i);
    expect(source).toContain("recoverPendingWorkflows");
    expect(source).toContain("resumeWorkflow");
    // The recovery, named precisely enough to follow.
    expect(source).toContain("forkWorkflow");
    expect(source).toContain("mintInstallationToken");
    // And it must not be recorded as fixed.
    expect(source).toMatch(/Not fixed in code/i);
  });
});
