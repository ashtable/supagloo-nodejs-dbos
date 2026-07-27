/**
 * Process-scoped configuration for `cleanupOrphanedAssetsWorkflow` (plan row 42),
 * injected at launch (`runtime.ts` → `setCleanupConfig`) from the validated env — the same
 * singleton discipline as `render/config.ts`, `providers/config.ts` and `db/app-db.ts`.
 * The workflow's steps read {@link getCleanupConfig}; they never touch `process.env`.
 */
export interface CleanupConfig {
  /**
   * How long a failed/canceled job's objects are kept before they may be swept.
   * D42.2: `CLEANUP_RETENTION_HOURS`, default 168 (7 days) — see `selection.ts`
   * `retentionCutoff` for why the default is a SAFETY property, not a preference.
   */
  retentionMs: number;
  /**
   * `CLEANUP_DRY_RUN` — plan the sweep and report it, mutate nothing. A real operator
   * mode (the row's "dry-run listing logic"), not a test hook: it defaults to `false`,
   * has no `NODE_ENV` branch, and changes no code path other than skipping the two
   * destructive steps.
   */
  dryRun: boolean;
}

let config: CleanupConfig | undefined;

export function setCleanupConfig(next: CleanupConfig): void {
  config = next;
}

/**
 * Throws rather than defaulting. This is the only S3 delete path in the design, so an
 * un-injected config must be a loud failure — a default here would mean "sweep with a
 * zero-length retention window", i.e. delete everything terminal.
 */
export function getCleanupConfig(): CleanupConfig {
  if (!config) {
    throw new Error(
      "cleanup config not initialized — launchDbos() must run setCleanupConfig() before " +
        "cleanupOrphanedAssetsWorkflow executes",
    );
  }
  return config;
}

export function clearCleanupConfig(): void {
  config = undefined;
}
