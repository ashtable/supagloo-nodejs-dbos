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
