/**
 * Process-scoped GitHub configuration for the git-ops workflows, injected at launch
 * (`runtime.ts` → `setScaffoldConfig`) from the validated env — the same pattern as
 * `app-db.ts`'s Prisma client. Steps read it via {@link getScaffoldConfig} so they
 * never touch `process.env` directly. App-level (not per-user) secrets: the App id +
 * private key sign short-lived App JWTs; the base URLs are env-overridable (real
 * hosts in prod, stub URLs in test).
 */

export interface ScaffoldConfig {
  githubApiBaseUrl: string;
  githubGitBaseUrl: string;
  githubAppId: string;
  githubAppPrivateKey: string;
}

let config: ScaffoldConfig | undefined;

export function setScaffoldConfig(next: ScaffoldConfig): void {
  config = next;
}

export function getScaffoldConfig(): ScaffoldConfig {
  if (!config) {
    throw new Error(
      "scaffold config not initialized — launchDbos() must run setScaffoldConfig() before git-ops workflows execute",
    );
  }
  return config;
}

export function clearScaffoldConfig(): void {
  config = undefined;
}
