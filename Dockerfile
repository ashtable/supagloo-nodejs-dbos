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
ARG DATABASE_LIB_REF=e4be6148514bfe50feac6ad0f8ee987fca17cef7
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
# git is REQUIRED AT RUNTIME (Task #17): the scaffoldProject git-ops workflow shells
# out to the `git` CLI to clone/commit/push (house style — no npm git dep). git is in
# the deps stage (to clone database-lib at build time) but that stage is not copied
# into the runner, so it must be installed here or the workflow fails in production.
#
# Task #36 (renderWorkflow) adds the Chrome Headless Shell system libraries. The list is
# taken VERBATIM from Remotion's own Docker guide (remotion.dev/docs/docker) — without
# them Chromium fails to start and every render dies at frame 0. The two Noto font
# packages are Remotion's documented additions for emoji and CJK glyphs, which scene
# captions can easily contain. (Remotion's guide also explicitly warns AGAINST Alpine;
# node:22-slim/Debian is already what we use.)
#
# Remotion passes --no-sandbox/--disable-setuid-sandbox itself (verified in
# @remotion/renderer 4.0.490 open-browser.js), so running as root here needs no extra
# flag. The render child additionally executes `npm install` for the CLONED project, which
# is why `npm` (bundled with the node image) must remain on PATH at runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    openssl git ca-certificates \
    libnss3 \
    libdbus-1-3 \
    libatk1.0-0 \
    libgbm-dev \
    libasound2 \
    libxrandr2 \
    libxkbcommon-dev \
    libxfixes3 \
    libxcomposite1 \
    libxdamage1 \
    libatk-bridge2.0-0 \
    libpango-1.0-0 \
    libcairo2 \
    libcups2 \
    fonts-noto-color-emoji \
    fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

# node_modules carries the db-lib symlink; the copied submodule is what that
# symlink points at; dist/ is the compiled worker. No prisma.config.ts (no migrate).
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/supagloo-database-lib ./supagloo-database-lib
COPY --from=builder /app/dist ./dist
COPY package.json ./

# Download Chrome Headless Shell into the image so the FIRST render doesn't pay for it
# (and so a network-restricted runtime still works). This is the programmatic equivalent
# of `npx remotion browser ensure` from Remotion's Docker guide — we call the
# @remotion/renderer API directly because we deliberately do NOT install @remotion/cli in
# the worker. The render child calls ensureBrowser() too, so this is a warm cache, not a
# hard requirement.
RUN node -e "require('@remotion/renderer').ensureBrowser().then(s=>console.log('remotion browser:',s.type))"

# No EXPOSE: the worker has no public HTTP surface. It connects out to Postgres
# (system + app dbs) and picks up enqueued work.
CMD ["node", "dist/main.js"]
