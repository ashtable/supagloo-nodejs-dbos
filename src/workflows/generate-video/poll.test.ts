import { describe, it, expect, vi } from "vitest";
import {
  classifyVideoStatus,
  pollUntilComplete,
  DEFAULT_VIDEO_MAX_POLL_ATTEMPTS,
  DEFAULT_VIDEO_POLL_INTERVAL_SECONDS,
} from "./poll";
import { VideoJobFailedError, VideoJobTimedOutError } from "./errors";
import { getVideoJob } from "../../providers/media-client";

// The bounded durable-sleep polling state machine (design-delta §7 workflow 8 — "bounded loop
// with durable ~30s sleeps between GET {polling_url} calls, through pending → in_progress →
// completed"). This is the task's required "polling state machine — terminal states, bounded
// attempts" unit surface, extracted PURE so it runs without DBOS: the workflow passes
// DBOS.runStep / DBOS.sleep / its boundary hook as the injected poll / sleep / onBeforePoll.

describe("classifyVideoStatus — terminal-state mapping", () => {
  it("treats completed (and succeeded) as terminal success", () => {
    expect(classifyVideoStatus("completed")).toEqual({ kind: "completed" });
    expect(classifyVideoStatus("succeeded")).toEqual({ kind: "completed" });
    expect(classifyVideoStatus("COMPLETED")).toEqual({ kind: "completed" });
  });

  it("treats failed / error / cancelled as terminal failure (fail fast, no wasted polls)", () => {
    expect(classifyVideoStatus("failed")).toMatchObject({ kind: "failed" });
    expect(classifyVideoStatus("error")).toMatchObject({ kind: "failed" });
    expect(classifyVideoStatus("cancelled")).toMatchObject({ kind: "failed" });
    expect(classifyVideoStatus("canceled")).toMatchObject({ kind: "failed" });
  });

  it("treats pending / in_progress / queued / unknown as non-terminal (keep polling)", () => {
    expect(classifyVideoStatus("pending")).toEqual({ kind: "pending" });
    expect(classifyVideoStatus("in_progress")).toEqual({ kind: "pending" });
    expect(classifyVideoStatus("queued")).toEqual({ kind: "pending" });
    expect(classifyVideoStatus("processing")).toEqual({ kind: "pending" });
    // An unrecognized-but-possibly-transitional status is NOT failed — keep polling (bounded).
    expect(classifyVideoStatus("whatever")).toEqual({ kind: "pending" });
  });
});

describe("pollUntilComplete — bounded loop", () => {
  const sleepSpy = () => {
    const calls: number[] = [];
    return { calls, sleep: async (ms: number) => void calls.push(ms) };
  };

  it("returns after the first poll when already completed (no sleep)", async () => {
    const s = sleepSpy();
    const poll = vi.fn().mockResolvedValue("completed");
    const res = await pollUntilComplete({
      poll,
      sleep: s.sleep,
      intervalMs: 30_000,
      maxAttempts: 40,
    });
    expect(res).toEqual({ attempts: 1 });
    expect(poll).toHaveBeenCalledTimes(1);
    expect(s.calls).toHaveLength(0);
  });

  it("polls through pending → in_progress → completed, sleeping BETWEEN polls, firing onBeforePoll each time", async () => {
    const s = sleepSpy();
    const statuses = ["pending", "in_progress", "completed"];
    const poll = vi.fn().mockImplementation(async () => statuses.shift()!);
    const onBeforePoll = vi.fn();
    const res = await pollUntilComplete({
      poll,
      sleep: s.sleep,
      onBeforePoll,
      intervalMs: 30_000,
      maxAttempts: 40,
    });
    expect(res).toEqual({ attempts: 3 });
    expect(poll).toHaveBeenCalledTimes(3);
    // A sleep AFTER each non-terminal poll (2), not after the completing poll.
    expect(s.calls).toEqual([30_000, 30_000]);
    // The boundary hook fires before EVERY poll (the crash/replay parking point).
    expect(onBeforePoll).toHaveBeenCalledTimes(3);
  });

  it("throws VideoJobFailedError immediately on a failed status (no further polls or sleeps)", async () => {
    const s = sleepSpy();
    const poll = vi.fn().mockResolvedValueOnce("in_progress").mockResolvedValueOnce("failed");
    await expect(
      pollUntilComplete({ poll, sleep: s.sleep, intervalMs: 5, maxAttempts: 40, jobId: "vid_9" }),
    ).rejects.toBeInstanceOf(VideoJobFailedError);
    expect(poll).toHaveBeenCalledTimes(2);
    // One sleep (after the first in_progress); none after the failing poll.
    expect(s.calls).toEqual([5]);
  });

  it("throws VideoJobTimedOutError after exactly maxAttempts pending polls (maxAttempts-1 sleeps)", async () => {
    const s = sleepSpy();
    const poll = vi.fn().mockResolvedValue("pending");
    await expect(
      pollUntilComplete({ poll, sleep: s.sleep, intervalMs: 7, maxAttempts: 3, jobId: "vid_1" }),
    ).rejects.toBeInstanceOf(VideoJobTimedOutError);
    expect(poll).toHaveBeenCalledTimes(3);
    // Sleeps only BETWEEN polls: 3 polls → 2 sleeps (no sleep after the final attempt).
    expect(s.calls).toEqual([7, 7]);
  });

  it("passes the configured interval to sleep", async () => {
    const s = sleepSpy();
    const poll = vi.fn().mockResolvedValueOnce("pending").mockResolvedValueOnce("completed");
    await pollUntilComplete({ poll, sleep: s.sleep, intervalMs: 1234, maxAttempts: 40 });
    expect(s.calls).toEqual([1234]);
  });
});

describe("documented defaults (design D4 judgment call)", () => {
  it("defaults to ~30s interval and a 40-attempt (20-minute) ceiling", () => {
    expect(DEFAULT_VIDEO_POLL_INTERVAL_SECONDS).toBe(30);
    expect(DEFAULT_VIDEO_MAX_POLL_ATTEMPTS).toBe(40);
  });
});

// §10.6 fidelity add (task 34-E1): the block above drives the loop with a string-returning
// callback (the loop-logic requirement — pending→in_progress→completed, terminal failure,
// bounded attempts — is already met there). Here we bind the REAL getVideoJob HTTP parse to
// pollUntilComplete over an INJECTED FETCH SEQUENCE, proving the provider JSON `{id,status}`
// actually feeds the state machine — the "controlled-timing video polling" case, reproduced
// at unit level with injected fetch (no stub, no DBOS) per the task's injected-fetch mandate.
describe("pollUntilComplete over the real getVideoJob HTTP parse (injected-fetch, §10.6)", () => {
  const CFG = { openrouterBaseUrl: "https://openrouter.ai", apiKey: "sk-or-test" };
  const POLL_URL = "https://openrouter.ai/api/v1/videos/vid_1";

  function statusResponse(status: string): Response {
    return new Response(JSON.stringify({ id: "vid_1", status }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  function sequenceFetch(statuses: string[]): {
    fetch: typeof fetch;
    count: () => number;
  } {
    let i = 0;
    const f = (async () => {
      const s = statuses[Math.min(i, statuses.length - 1)];
      i += 1;
      return statusResponse(s);
    }) as unknown as typeof fetch;
    return { fetch: f, count: () => i };
  }
  const sleepSpy = () => {
    const calls: number[] = [];
    return { calls, sleep: async (ms: number) => void calls.push(ms) };
  };

  it("walks pending → in_progress → completed via real getVideoJob JSON responses", async () => {
    const seq = sequenceFetch(["pending", "in_progress", "completed"]);
    const s = sleepSpy();
    const res = await pollUntilComplete({
      poll: async () =>
        (await getVideoJob({ ...CFG, fetchImpl: seq.fetch }, POLL_URL)).status,
      sleep: s.sleep,
      intervalMs: 30_000,
      maxAttempts: 40,
      jobId: "vid_1",
    });
    expect(res).toEqual({ attempts: 3 });
    expect(seq.count()).toBe(3);
    expect(s.calls).toEqual([30_000, 30_000]);
  });

  it("fails fast on a provider-reported terminal 'failed' status", async () => {
    const seq = sequenceFetch(["in_progress", "failed"]);
    const s = sleepSpy();
    await expect(
      pollUntilComplete({
        poll: async () =>
          (await getVideoJob({ ...CFG, fetchImpl: seq.fetch }, POLL_URL)).status,
        sleep: s.sleep,
        intervalMs: 5,
        maxAttempts: 40,
        jobId: "vid_1",
      }),
    ).rejects.toBeInstanceOf(VideoJobFailedError);
    expect(seq.count()).toBe(2);
  });

  it("times out after maxAttempts bounded pending polls", async () => {
    const seq = sequenceFetch(["pending"]);
    const s = sleepSpy();
    await expect(
      pollUntilComplete({
        poll: async () =>
          (await getVideoJob({ ...CFG, fetchImpl: seq.fetch }, POLL_URL)).status,
        sleep: s.sleep,
        intervalMs: 7,
        maxAttempts: 3,
        jobId: "vid_1",
      }),
    ).rejects.toBeInstanceOf(VideoJobTimedOutError);
    expect(seq.count()).toBe(3);
  });
});
