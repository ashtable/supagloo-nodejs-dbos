/**
 * Process-scoped provider configuration for the generation workflows, injected at
 * launch (`runtime.ts` → `setProviderConfig`) from the validated env — the same
 * pattern as `scaffold-project/config.ts` and `app-db.ts`. Step helpers read it via
 * {@link getProviderConfig} so they never touch `process.env` directly.
 *
 * Holds the two outbound provider base URLs (env-overridable — real hosts in prod,
 * stub URLs in test) and the single AES-256-GCM key the credential-load step decrypts
 * per-user provider secrets with (via db-lib's `decryptSecret`).
 */

export interface ProviderConfig {
  openrouterBaseUrl: string;
  glooBaseUrl: string;
  /** YouVersion Data Exchange base URL (task #30 fetchScripturePassage). */
  youversionBaseUrl: string;
  /**
   * The real YouVersion API's `x-yvp-app-key`, REQUIRED on both YouVersion endpoints.
   *
   * The "optional — the stub ignores it" note this replaced was doubly stale: the YouVersion
   * stub was DELETED in task 34-E8, and since 2026-07-30 `config/env.ts` refuses to boot
   * without `YOUVERSION_APP_KEY` (a missing key is a 401 on both endpoints, and
   * `generate-script.ts` calls `fetchPassage` unconditionally, so there is no working
   * key-free path).
   *
   * The TYPE stays optional on purpose. The boot gate already makes the runtime value
   * present, and four sites construct a `ProviderConfig` by hand (`providers/config.test.ts`
   * plus three workflow test mocks) — tightening it here would churn those for nothing the
   * gate does not already guarantee.
   */
  youversionAppKey?: string;
  /** 64-hex AES-256-GCM key, validated at boot; passed to db-lib decryptSecret. */
  secretsEncryptionKey: string;
}

let config: ProviderConfig | undefined;

export function setProviderConfig(next: ProviderConfig): void {
  config = next;
}

export function getProviderConfig(): ProviderConfig {
  if (!config) {
    throw new Error(
      "provider config not initialized — launchDbos() must run setProviderConfig() before generation workflows execute",
    );
  }
  return config;
}

export function clearProviderConfig(): void {
  config = undefined;
}
