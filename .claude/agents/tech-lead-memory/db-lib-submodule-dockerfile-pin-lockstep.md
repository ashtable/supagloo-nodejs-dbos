---
name: db-lib-submodule-dockerfile-pin-lockstep
description: How to bump the supagloo-database-lib submodule — must keep Dockerfile ARG DATABASE_LIB_REF in lockstep; the pin test enforces it
metadata:
  type: convention
---

`supagloo-database-lib` is a git submodule of this repo, consumed via
`"@supagloo/database-lib": "file:./supagloo-database-lib"` (a symlink in
`node_modules/@supagloo/database-lib` -> `../../supagloo-database-lib`).

**Two pins must always match, in the SAME commit:**
1. The submodule gitlink (`git ls-files -s supagloo-database-lib`).
2. `ARG DATABASE_LIB_REF=<sha>` in the `Dockerfile` (~line 33).

**Why:** Railway does NOT init git submodules and does not copy the outer `.git`
into the Docker build context, so the Dockerfile `COPY` of the submodule dir
would be empty. Instead the deps stage `git clone`s db-lib from GitHub and
`git checkout`s `DATABASE_LIB_REF`. A stale ARG silently ships the wrong db-lib.

`src/dockerfile-database-lib-pin.test.ts` is the guardrail — it asserts the
Dockerfile ARG equals the submodule gitlink and fails the build if they drift.

**Bump procedure (matches commits e7fbd8a / 98f892e / 90abfd0):**
1. `cd supagloo-database-lib && git fetch origin && git checkout <sha>`
2. `npm run build` inside the submodule (prisma generate + tsc) so the
   gitignored `dist/` matches the checked-out source — the symlinked consumer
   resolves to `dist/`.
3. Edit `Dockerfile` `ARG DATABASE_LIB_REF=<sha>`.
4. `git add supagloo-database-lib Dockerfile` — **staging matters**: the pin
   test reads `git ls-files -s` (the INDEX gitlink), so it only sees the new SHA
   after you stage the submodule bump.
5. Commit both together: `chore: bump database-lib submodule + Dockerfile pin to <shortsha> (Task #NN ...)`.

**Breaking-change check:** db-lib bumps are almost always additive (new
Prisma models / zod wire DTOs in `src/schemas.ts`). Verify with
`git -C <db-lib> diff --stat <old>..<new>` (expect insertions only) and grep
this repo's `src/` for `@supagloo/database-lib` imports before assuming safe.

Sibling `supagloo-nodejs-api` pins its own db-lib submodule; the canonical
up-to-date checkout lives at `/Users/ash/code/supagloo-database-lib`. Bump dbos
to whatever HEAD/main db-lib is on to stay in line with api.
