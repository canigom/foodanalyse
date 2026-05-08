# syntax=docker/dockerfile:1.7
#
# Multi-stage Docker build for KochHeute.
#
#   deps     — install npm packages (cached aggressively)
#   builder  — generate Prisma client, run `next build`
#   runner   — slim runtime image with only the standalone output
#
# Build:
#   docker build -t kochheute-api:latest .

# ---- deps ----------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app

# libc6-compat: glibc shim some npm binaries need on Alpine.
# openssl: required by Prisma's query engine.
RUN apk add --no-cache libc6-compat openssl

COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./

# Prisma 6's prisma.config.ts validates DATABASE_URL at load time even for
# `prisma generate`, so we feed a throwaway URL here. Real value is injected
# at runtime by docker-compose from .env.production.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build?schema=public"

# `npm ci` is reproducible from the lockfile. The postinstall hook in
# package.json runs `prisma generate`, which needs the schema we copied above.
RUN npm ci


# ---- builder -------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Prisma reads DATABASE_URL at generate time but doesn't actually open the
# DB unless you run a query. A throwaway value is fine for the build.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build?schema=public"

RUN npm run build


# ---- runner --------------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app

RUN apk add --no-cache openssl

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Tells NextAuth it's safe to trust X-Forwarded-* headers from the reverse
# proxy (nginx, Traefik, etc.).
ENV AUTH_TRUST_HOST=true

# Run as a non-root user.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001 -G nodejs

# Copy the standalone bundle (server.js + minimal node_modules).
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Bring in the FULL node_modules from the builder so `prisma migrate deploy`
# at startup has all transitive dependencies (effect, @prisma/config, etc.).
# Trade-off: image size goes up ~300MB; acceptable for a hobby/dev VM.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/prisma.config.ts ./prisma.config.ts

COPY --chown=nextjs:nodejs --chmod=755 docker-entrypoint.sh /app/docker-entrypoint.sh

USER nextjs
EXPOSE 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
