# supagloo-nodejs-dbos

Tools for Creators, Built on Gloo AI & YouVersion Platform.

The Supagloo **DBOS worker**: statically-registered durable workflows + queues.
Workers do all git operations, all LLM/media-model calls, and Remotion rendering;
they write job progress to Postgres via the shared `@supagloo/database-lib` client
and upload outputs to S3. Work arrives via `DBOSClient` enqueue from the API — no
HTTP between them.

## Stack

- **DBOS Transact (TypeScript)** — durable workflows + queues.
  **Zero dynamic workflow registration**: every workflow is registered at module
  load via `DBOS.registerWorkflow(fn, { name })`, before `DBOS.launch()`. The
  queue set + concurrency is a frozen table in `src/dbos/registry.ts`
  (`git-ops` ~4, `ai-generation` ~8, `render` 1/worker).
- **Two databases**: the app db (`supagloo`, `DATABASE_URL`) for domain rows, and
  the DBOS system db (`supagloo_dbos`, `DBOS_DATABASE_URL`) for checkpoints/queues.
  DBOS creates its own system tables on launch — there is **no `migrate` service**
  here (only the API runs `prisma migrate deploy`).
- **Zod-validated env loader** (fail-fast at boot).
- **Prisma 7**, pinned to the exact version `@supagloo/database-lib` ships and
  enforced by a `postinstall` check (`check-prisma-version`).
- **CommonJS** + `tsc` build (`node dist/main.js`).

## Development

`@supagloo/database-lib` is vendored as the git submodule `supagloo-database-lib`
and consumed via `"@supagloo/database-lib": "file:./supagloo-database-lib"`. Its
compiled `dist/` is **gitignored**, so you must build the submodule **before**
installing this package's dependencies:

```sh
# 1. Ensure submodules are checked out
git submodule update --init --recursive

# 2. Build database-lib's dist/ (prisma generate + tsc) — required by the file: dep
npm --prefix supagloo-database-lib ci
npm --prefix supagloo-database-lib run build

# 3. Install the worker's dependencies (runs the Prisma pin check via postinstall)
npm install
```

Requires `DATABASE_URL` and `DBOS_DATABASE_URL` (both `postgres://` /
`postgresql://` connection strings); see `.env.example`.

### Scripts

| Script             | What it does                                          |
| ------------------ | ----------------------------------------------------- |
| `npm run dev`      | Run the worker with reload (`tsx watch`).             |
| `npm run build`    | Compile TypeScript to `dist/`.                        |
| `npm start`        | Run the compiled worker (`node dist/main.js`).        |
| `npm run typecheck`| Type-check everything (incl. tests) with no emit.     |
| `npm run test`     | Unit tests (`vitest`).                                |
| `npm run test:e2e` | Non-UI e2e: launches the real DBOS runtime + Postgres.|

## Docker

The `Dockerfile` is a multi-stage `node:22-slim` build that clones + builds the
db-lib submodule (pinned via `ARG DATABASE_LIB_REF`, kept in lockstep with the
submodule by a guardrail test) and compiles the worker. The root repo's
`docker-compose.yml` runs it as the long-running `dbos` service (no exposed port),
depending on the one-shot `migrate` completing.
