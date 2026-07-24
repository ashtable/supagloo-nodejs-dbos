import { describe, it, expect } from "vitest";
import { isProviderJobIdStable } from "./provider-job-id-stability";

// Unit proof of the pure providerJobId-stability predicate (design-delta §10.5) — the second
// assertion of the flagship crash/replay proof (task 34-E7). "Stable" is NOT the tautology
// `before === after`: it requires the pre-crash capture to be a genuine non-empty id AND the
// post-recovery id to match it. A blank/missing capture (submit never committed an id) and a
// DIVERGED final id (a replay re-submitted and got a NEW job id — the exact failure §10.5 guards
// against) must both read as NOT stable.

describe("isProviderJobIdStable", () => {
  it("is stable when the captured and final ids are the same non-empty string", () => {
    expect(isProviderJobIdStable("job_abc123", "job_abc123")).toBe(true);
  });

  it("is NOT stable when the final id DIVERGED (a replay re-submitted → a new job id)", () => {
    expect(isProviderJobIdStable("job_abc123", "job_xyz789")).toBe(false);
  });

  it("is NOT stable when the capture is missing (submit never committed an id pre-crash)", () => {
    expect(isProviderJobIdStable(null, "job_abc123")).toBe(false);
    expect(isProviderJobIdStable(undefined, "job_abc123")).toBe(false);
  });

  it("is NOT stable when the capture is an empty string (no real id captured)", () => {
    expect(isProviderJobIdStable("", "")).toBe(false);
    expect(isProviderJobIdStable("", "job_abc123")).toBe(false);
  });

  it("is NOT stable when the final id is missing (the row lost its providerJobId)", () => {
    expect(isProviderJobIdStable("job_abc123", null)).toBe(false);
    expect(isProviderJobIdStable("job_abc123", undefined)).toBe(false);
  });
});
