# Built and run from the repo root (`docker build -f apps/web/Dockerfile .`), for the
# same reason as apps/api's: this app resolves `@themaithil/region` and
# `@themaithil/contracts` to their SOURCE (next.config.mjs), so a build context scoped
# to apps/web cannot see the code it compiles.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

# ---- deps: from the lockfile, before any source is copied, so an unrelated source
# change never invalidates this layer. ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/region/package.json packages/region/package.json
RUN pnpm install --frozen-lockfile --filter @themaithil/web...

# ---- build ----
FROM deps AS build
COPY . .

# WHERE THE BROWSER WILL FIND THE API, and why it is a build ARG rather than a
# runtime variable.
#
# `NEXT_PUBLIC_*` is INLINED INTO THE JAVASCRIPT at build time — that is what the
# prefix means. Setting it in the container's environment at run time does nothing
# at all: the string is already baked into the chunks a browser downloads, and the
# app would quietly keep calling http://localhost:3000 (lib/api.ts's fallback) from
# every production browser, which fails in a way that looks like the API being down.
#
# So it has to be supplied here, and an image is therefore specific to the API it
# was built against. Fly passes it with `--build-arg`; see the deploy workflow.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# `next build` sets NODE_ENV=production itself, which is what selects `.next-build`
# over `.next` (see distDir in next.config.mjs).
RUN pnpm --filter @themaithil/web build

# ---- runtime ----
# Three directories, no package install. `output: 'standalone'` traced what the
# server actually imports and emitted a real node_modules beside it, so there is
# nothing left to resolve — which is the whole reason a pnpm workspace can be
# containerised at all without shipping the .pnpm symlink forest.
FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3001
ENV HOSTNAME=0.0.0.0

RUN addgroup -S app && adduser -S app -G app

# The standalone tree mirrors the repo layout, so the server lands at
# apps/web/server.js and resolves everything else relative to itself.
#
# STATIC GOES TO `.next-build/static`, NOT `.next/static`. Next's own documentation
# says `.next/static`, which is true only for the default distDir — this app sets
# `distDir: '.next-build'` in production, and the generated server.js references
# `.next-build` accordingly. Copying to the documented path builds an image that
# starts, serves HTML, and then 404s every stylesheet and chunk: a completely
# unstyled site with no obvious error anywhere. Verified against the real output
# rather than the docs.
COPY --from=build --chown=app:app /repo/apps/web/.next-build/standalone ./
COPY --from=build --chown=app:app /repo/apps/web/.next-build/static ./apps/web/.next-build/static
COPY --from=build --chown=app:app /repo/apps/web/public ./apps/web/public

USER app
EXPOSE 3001

# Next's standalone server reads PORT and HOSTNAME from the environment. HOSTNAME
# must be 0.0.0.0 rather than the default localhost, or the container listens on an
# interface nothing outside it can reach and every health check times out.
CMD ["node", "apps/web/server.js"]
