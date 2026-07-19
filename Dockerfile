# syntax=docker/dockerfile:1

# Multi-stage build for the Supagloo DBOS worker. Uses node:22-slim (Debian)
# rather than alpine because building database-lib's Prisma client runs
# `prisma generate`, whose engines are best-supported on glibc. Node 22 matches
# the monorepo convention. This mirrors supagloo-nodejs-api's Dockerfile, MINUS
# the migrate concern: dbos has NO `migrate` service and never runs `prisma
# migrate deploy` (only the API applies migrations) — so there is no
# prisma.config.ts and no runtime prisma CLI.

# ---- deps: build the vendored database-lib, then install worker deps ----------
FROM node:22-slim AS deps
WORKDIR /app

# Prisma's engines need libssl present to select the correct openssl-3.0.x binary
# (bookworm-slim omits it) so @prisma/engines' postinstall detects the right
# target during `prisma generate`; git + ca-certificates clone database-lib below.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# database-lib is a git submodule of this repo, but we do NOT copy it from the
# build context. Railway (our deploy target) does not initialize git submodules
# and does not copy the outer repo's .git into the Dockerfile build context, so
# `COPY supagloo-database-lib/...` there resolves to an EMPTY directory and the
# build fails on the missing package.json. Instead we clone database-lib from its
# public GitHub URL at build time, pinned to an exact commit so the image is as
# reproducible as the submodule pin. Keep DATABASE_LIB_REF in lockstep with the
# submodule: whenever a "Bump supagloo-database-lib submodule to <sha>" commit
# lands, update this default to that same SHA in the same commit (the
# dockerfile-database-lib-pin test enforces this).
# DO NOT "simplify" this back to a COPY of the submodule dir — it breaks Railway.
ARG DATABASE_LIB_REF=5b541dd4cef459c925c41ee8b6fb724f38aa4ea0
RUN git clone https://github.com/ashtable/supagloo-database-lib.git supagloo-database-lib \
  && git -C supagloo-database-lib checkout "${DATABASE_LIB_REF}" \
  && rm -rf supagloo-database-lib/.git

# database-lib ships no dist/ in git (it is gitignored); build it here so the
# file:./supagloo-database-lib dependency resolves to a real compiled client. npm
# installs it as a symlink into node_modules — the builder and runner stages copy
# the built submodule so that relative symlink (../../supagloo-database-lib)
# resolves.
RUN npm --prefix supagloo-database-lib ci --no-audit --no-fund
RUN npm --prefix supagloo-database-lib run build

# Install the worker's own deps. Resolves the file: db-lib dependency and runs the
# `postinstall` (check-prisma-version) — a Prisma pin drift fails the build here.
COPY package.json package-lock.json ./
RUN npm install --no-audit --no-fund

# ---- builder: compile the worker TypeScript to dist/ ------------------------
FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/supagloo-database-lib ./supagloo-database-lib
COPY package.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runner -----------------------------------------------------------------
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# libssl is present for Prisma's engine even though the worker uses the driver-
# adapter (pg) client at runtime — precautionary parity with the deps stage; harmless.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

# node_modules carries the db-lib symlink; the copied submodule is what that
# symlink points at; dist/ is the compiled worker. No prisma.config.ts (no migrate).
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/supagloo-database-lib ./supagloo-database-lib
COPY --from=builder /app/dist ./dist
COPY package.json ./

# No EXPOSE: the worker has no public HTTP surface. It connects out to Postgres
# (system + app dbs) and picks up enqueued work.
CMD ["node", "dist/main.js"]
