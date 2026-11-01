# Built and run from the repo root (`docker build -f apps/api/Dockerfile .`) because
# apps/api depends on two workspace packages by source — see the "Workspace packages"
# note in CONTRIBUTING.md. A Dockerfile scoped to apps/api alone cannot see them.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

# ---- deps: installed from the lockfile before any source is copied, so an
# unrelated source change never invalidates this layer. ----
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/region/package.json packages/region/package.json
RUN pnpm install --frozen-lockfile

# ---- build: workspace packages first (apps/api resolves them by source at
# typecheck time but needs dist/ for the bundle - see build.mjs), then the API. ----
FROM deps AS build
COPY . .
RUN pnpm --filter @themaithil/region --filter @themaithil/contracts build \
 && pnpm --filter @themaithil/api build

# ---- runtime: production node_modules only, plus the two dist trees the
# bundle still resolves externally (drizzle-orm, postgres, etc. are marked
# `packages: external` in build.mjs). ----
FROM base AS runtime
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/region/package.json packages/region/package.json
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/packages/contracts/dist packages/contracts/dist
COPY --from=build /repo/packages/region/dist packages/region/dist

RUN addgroup -S app && adduser -S app -G app
USER app

EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
