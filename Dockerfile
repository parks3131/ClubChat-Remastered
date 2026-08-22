# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# One image, three roles. SPEC/TECH/21-deployment.md: `packages/server` has three
# entrypoints over one dependency graph, so a single image is built and the role is
# chosen by the start command. The image is built once and pushed once; all three Fly
# apps deploy the same digest, because the Fly registry is scoped per organization
# rather than per app. That is what keeps "one image, three roles" literally true
# instead of three builds that can drift.
#
# There is NO build step, and that is a decision rather than an omission.
# tsconfig.base.json's header states it: Node 24+ runs `.ts` by stripping types, held up
# by three settings that only work together - explicit `.ts` import extensions (771 of
# them in the server), `allowImportingTsExtensions`, and the `noEmit` it forces.
# `packages/server` has no `build` script, only `typecheck`. So this image ships SOURCE
# and runs it.
# ---------------------------------------------------------------------------

# Debian (glibc), not Alpine (musl), and pinned to a Debian codename rather than the
# floating `-slim` so a Debian major release cannot move under us on a rebuild.
#
# Node 24 because `engines.node` is ">=24" and .github/workflows/ci.yml pins
# node-version: 24. Rule 9 says every deploy is of a commit that passed CI, so the image
# must run the runtime CI proved it on. The founder's laptop runs 25.9.0; pinning here is
# what stops the laptop's version leaking into a deploy.
#
# glibc over musl for two reasons that point the same way:
#   - Node rates GNU/Linux x64 glibc >= 2.28 as Tier 1 and x64 musl as Experimental
#     ("may not compile or test suite may not pass") - nodejs/node BUILDING.md.
#   - sharp 0.35.3 ships prebuilds for BOTH (@img/sharp-linux-x64 needs glibc >= 2.28,
#     @img/sharp-linuxmusl-x64 needs musl >= 1.2.5), so musl buys nothing on the one
#     native dependency that made the base image a question at all.
ARG NODE_IMAGE=node:24-trixie-slim

# ===========================================================================
# Stage 1: dependencies
# ===========================================================================
FROM ${NODE_IMAGE} AS deps
WORKDIR /app

# Manifests only, before any source, so `npm ci` re-runs on a dependency change and is a
# cache hit on every commit that only touches code.
#
# Three of the four packages/* manifests are copied, including client-core's, because npm
# ci reconciles the declared workspace set against package-lock.json before installing
# anything. Only two of the three are then installed, and only two reach the runtime stage.
#
# The fourth, packages/cdn-worker, is deliberately absent, and it is absent the same way
# apps/mobile is: the `packages/*` glob is evaluated against this filesystem, so a manifest
# that was never copied is a workspace npm never sees, even though package-lock.json holds
# an entry for it. Proved by building this stage rather than reasoned about, on 2026-08-21,
# when the Worker became the fourth workspace. The image carries no cdn-worker manifest, no
# source, and no node_modules symlink.
#
# It stays absent on purpose. The Worker is deployed by wrangler to Cloudflare's edge and
# has nothing to do with this image, and wrangler alone is roughly 80MB of devDependency.
COPY package.json package-lock.json ./
COPY packages/server/package.json      packages/server/
COPY packages/shared/package.json      packages/shared/
COPY packages/client-core/package.json packages/client-core/

# --workspace=@clubchat/server installs that workspace's tree and nothing else, which is
# what keeps Expo, React Native and @sentry/react-native out of a server image.
# apps/mobile/package.json is deliberately NOT copied above and does not need to be: npm
# resolves the workspace graph from package-lock.json and the `apps/*` glob matches nothing.
# --include-workspace-root picks up the root manifest so npm treats this as a real root
# install rather than a partial one.
#
# --omit=dev drops testcontainers and @clubchat/client-core (a devDependency imported only
# by src/test/phase0-exit-drill.test.ts). With those gone, nothing left in the tree has a
# native install script, so this install compiles nothing and needs no build toolchain.
#
# It does NOT drop vitest, drizzle-kit, esbuild or typescript, and that is npm behaviour
# rather than a mistake here: better-auth declares vitest and drizzle-kit as OPTIONAL
# peerDependencies, so the lockfile marks them `devOptional` and --omit=dev only removes
# `dev`. That is roughly 80MB. `--omit=peer` was measured and made the image larger, not
# smaller. It is accepted rather than fought.
#
# Optional dependencies are deliberately NOT omitted. sharp's prebuilt binaries ARE its
# optionalDependencies, so `--omit=optional` would install sharp with no binary and turn a
# build-time miss into a boot-time crash.
#
# The trailing rm drops the workspace symlink npm creates for every workspace including
# dev-only ones. packages/client-core never reaches the runtime stage, so leaving the link
# would put a dangling symlink in node_modules for a future reader to misdiagnose.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --workspace=@clubchat/server --include-workspace-root \
 && rm -f node_modules/@clubchat/client-core

# ===========================================================================
# Stage 2: runtime
# ===========================================================================
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

# Note what this switches on besides logging: `assertProductionMailer` (mail.ts) refuses to
# boot the api role when NODE_ENV=production and no real mail transport is configured, so
# RESEND_API_KEY is required from the first deploy even though config.ts marks it optional.
# ADR-0019 argues that is the honest failure: booting on the logging mailer would tell a
# member to check their inbox while the working reset link sat in a log stream.
ENV NODE_ENV=production

# sharp's own install docs: "The default memory allocator on most glibc-based Linux systems
# is unsuitable for long-running, multi-threaded processes that involve lots of small memory
# allocations... the use of an alternative memory allocator such as jemalloc is recommended."
# That describes the worker exactly - it derives image variants continuously and never exits.
# Without this, glibc arena fragmentation shows up as RSS that only climbs, which reads like
# a leak in application code and gets diagnosed as one.
#
# The library path is multiarch-dependent (x86_64-linux-gnu on Fly, aarch64-linux-gnu on an
# Apple Silicon laptop), so it is discovered and symlinked to a fixed path rather than
# hardcoded. Hardcoding it makes LD_PRELOAD silently point at nothing on one of the two.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libjemalloc2 \
 && rm -rf /var/lib/apt/lists/* \
 && ln -s "$(find /usr/lib -name 'libjemalloc.so.2' -print -quit)" /usr/local/lib/libjemalloc.so.2
ENV LD_PRELOAD=/usr/local/lib/libjemalloc.so.2

# `node` (uid 1000) ships in the official image. Nothing here writes to disk - media goes to
# R2, state to Postgres and Redis - so the runtime needs no write access to its own
# filesystem and should not run as root.
USER node

# node_modules carries the workspace symlinks npm created
# (node_modules/@clubchat/shared -> ../../packages/shared). Those must survive the copy.
# Node refuses to type-strip .ts files under a node_modules path, so `@clubchat/shared`
# resolving to node_modules/@clubchat/shared/src/index.ts would be fatal at boot for all
# three roles. It is not, because ESM resolution realpaths symlinks by default, so the file
# actually loaded is /app/packages/shared/src/index.ts. COPY preserves symlinks.
# Do not "flatten" or rsync-through this; it breaks every role at boot, not at build.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules

# Source last, so a code-only commit rebuilds only these layers. Only the two workspaces the
# server needs at runtime: @clubchat/shared is a runtime dependency, @clubchat/client-core
# is not.
COPY --chown=node:node package.json ./
COPY --chown=node:node packages/shared/package.json ./packages/shared/
COPY --chown=node:node packages/shared/src          ./packages/shared/src
COPY --chown=node:node packages/server/package.json ./packages/server/
COPY --chown=node:node packages/server/src          ./packages/server/src

# The commit this build came from, so a production stack trace maps to a source. config.ts
# reads SENTRY_RELEASE and records that it is set by the deploy rather than by hand.
ARG SENTRY_RELEASE=""
ENV SENTRY_RELEASE=${SENTRY_RELEASE}

# HEALTHCHECK is DELIBERATELY ABSENT, and belongs in fly.toml instead.
#
# Docker's HEALTHCHECK is invisible to Fly's proxy: it does not gate traffic routing and it
# does not gate deploy success. Expressing readiness here would produce a check that looks
# authoritative and decides nothing. The real checks live in fly/<role>.toml, where the
# platform that knows about draining and rolling owns them, and they point at `/ready`
# rather than `/health`. `/health` answers from memory and cannot fail, so it can never
# gate anything; `/ready` actually reaches Postgres. The worker has no ingress and so has
# no HTTP check by design.

# No --watch (dev only) and no --env-file. The dev scripts use
# `node --env-file=../../.env --watch src/<role>/main.ts`; in production Fly supplies the
# environment directly and there is no .env in the image at all - .dockerignore keeps it out,
# and a value baked into a layer stays in that layer for the life of the image.
#
# Exec form so node is PID 1 and receives SIGTERM directly. All three entrypoints register
# their own SIGTERM handler, which is what rule 11's drain depends on: a rolling deploy
# redelivers, and an effect only idempotent in theory fails on an ordinary Tuesday.
#
# This is a default, not the contract. Each fly/<role>.toml sets its own start command:
#   api      node packages/server/src/api/main.ts
#   gateway  node packages/server/src/gateway/main.ts
#   worker   node packages/server/src/worker/main.ts
CMD ["node", "packages/server/src/api/main.ts"]
