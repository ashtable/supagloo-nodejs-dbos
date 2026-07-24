/**
 * Pure providerJobId-stability predicate (design-delta §10.5) — the second assertion of the
 * flagship crash/replay proof (task 34-E7), a companion to the {@link countStepExecutions}
 * system-DB probe in `step-introspection.ts`. Kept pure + test-only (dist-excluded via
 * `tsconfig.build.json`'s `src/testing/**`) so it is unit-tested docker-free.
 *
 * `captured` is the `providerJobId` read from the `AiGeneration` row right after the `submitVideoJob`
 * step committed (pre-crash); `final` is the `providerJobId` on the row after DBOS recovery ran the
 * workflow to completion. Stability holds IFF BOTH are non-empty strings AND they are IDENTICAL —
 * i.e. the memoized submit step replayed and the job id was never re-issued/overwritten.
 *
 * This is deliberately NOT the tautology `captured === final`: a blank/missing capture (submit never
 * committed an id before the crash) and any divergence (a replay re-submitted and got a NEW id — the
 * exact failure §10.5 guards against) must BOTH read as not stable.
 */
export function isProviderJobIdStable(
  captured: string | null | undefined,
  final: string | null | undefined,
): boolean {
  return typeof captured === "string" && captured.length > 0 && captured === final;
}
