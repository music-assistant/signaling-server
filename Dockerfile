# ---------- Base ----------
FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS base
WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Disable third-party install analytics (Scarf etc.) as defense-in-depth.
ENV DO_NOT_TRACK=1
ENV SCARF_ANALYTICS=false
# Node 26 images no longer bundle corepack, so install it from npm. Pin pnpm via
# the package.json "packageManager" field. Its "+sha512." suffix is what lets
# corepack verify the download; without it corepack trusts TLS only.
RUN npm install -g corepack@0.36.0 && corepack enable

# Copy manifests early for caching. No glob on the lockfile: a missing lockfile
# must fail the build here, not degrade into a fresh resolution further down.
COPY package.json pnpm-lock.yaml ./

# ---------- Deps ----------
# Frozen, with no fallback: the image must run exactly the dependency tree CI
# tested and Renovate's release-age cooldown vetted. A stale lockfile fails the
# build instead.
FROM base AS deps
RUN pnpm install --frozen-lockfile --ignore-scripts

# ---------- Build ----------
FROM deps AS builder
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build
RUN pnpm prune --prod --ignore-scripts

# ---------- Runtime ----------
FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS runner
WORKDIR /app
ENV NODE_ENV=production

# Reported by GET /health. The release workflow passes the built commit; a
# local build without it reports "dev".
ARG GIT_COMMIT=""
ENV GIT_COMMIT=$GIT_COMMIT

# Non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app
USER nodejs

# Only what we need
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Default port
ENV PORT=8787
EXPOSE 8787

# `wget --spider` is what busybox ships; it fails on non-2xx.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/health || exit 1

CMD ["node", "dist/standalone.js"]
