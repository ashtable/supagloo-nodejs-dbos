/**
 * The worker's launch/readiness log line, as a CONSTANT (task 62 / D23).
 *
 * Why this is not just an inline string in `main.ts`: the nextjs render-lane
 * globalSetup (`tests/e2e/global-setup.render.ts`) brings the containerised `dbos`
 * service up and gates on the worker having actually booted by scraping
 * `docker compose logs --no-color dbos` for this exact line. That is the gate that
 * catches the real failure mode — a worker crash-looping at boot on a bad
 * `GITHUB_APP_PRIVATE_KEY` or a missing `SECRETS_ENCRYPTION_KEY` — instead of letting
 * it surface four minutes later as an opaque wizard timeout.
 *
 * A cross-repo grep-for-a-string gate is silently rename-fragile: reword the log and
 * the nextjs gate starts timing out with a message that blames the wrong thing. So the
 * string lives here, `main.ts` logs THIS value, and `worker-log.test.ts` pins it. A
 * future reword then fails loudly in the dbos unit suite, which is where the person
 * doing the renaming is already looking.
 *
 * Keep it single-line, prefixed `[supagloo-dbos] ` (so it is attributable in a merged
 * `docker compose logs` stream), and free of anything run-specific — the gate does a
 * plain substring match.
 */
export const WORKER_READY_LOG =
  "[supagloo-dbos] worker launched — static queues registered, polling for work";

/**
 * The failure counterpart. `main.ts` prefixes its fatal handler with this, and the
 * nextjs gate treats its presence in the log tail as a HARD failure (rather than
 * waiting out the readiness timeout) so a crash-looping worker is reported as a crash,
 * with the tail attached, not as a timeout.
 */
export const WORKER_FAILED_LOG = "[supagloo-dbos] failed to launch:";
