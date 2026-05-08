// Prisma client singleton.
//
// In development, Next.js hot-reloads server modules. Each reload would
// otherwise create a new PrismaClient and quickly exhaust the Postgres
// connection pool. We pin the instance to globalThis so reloads reuse it.

import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
