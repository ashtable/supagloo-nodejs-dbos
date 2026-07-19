/**
 * Exact, cross-repo-sensitive version pins stamped into every generated Remotion
 * project's package.json — and cross-checked (src/remotion/versions.test.ts)
 * against the versions dbos itself installs, so the worker that runs bundle() and
 * the projects it generates can never drift apart. Same spirit as the Prisma pin.
 *
 * Why 4.0.490 (npm latest is 4.0.492 as of 2026-07-19): the sibling supagloo-nextjs
 * spike verified remotion + @remotion/player at 4.0.490. Remotion requires every
 * remotion/@remotion/* package be the SAME exact version, and the nextjs <Player>
 * renders the very compositions dbos bundles/renders — so keeping both repos
 * identical at 4.0.490 matters more than being two patch versions ahead. Bump in
 * lockstep across both repos when the time comes. Exact pins only (no ^ / ~).
 */
export const REMOTION_VERSION = "4.0.490";

/**
 * React 18.3.1 — the last stable 18.x, fully supported by Remotion 4.0.x (peer dep
 * react >=16.8.0) and the conservative/boring choice over React 19. Matches the
 * sibling nextjs anchor. Reversible if the Player later realigns on 19.
 */
export const REACT_VERSION = "18.3.1";
