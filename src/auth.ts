// NextAuth v5 configuration.
//
// This app is API-first (the iOS client uses a custom Bearer-token flow on
// /api/auth/login + /api/auth/signup), so NextAuth here exists primarily
// for the optional Google OAuth flow when AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET
// are set. We still expose the credentials provider so a browser visitor
// can sign in via NextAuth's default UI if needed, but the iOS app should
// not use it.
//
// Two providers:
//   - Credentials (email + bcrypt password) — always on
//   - Google OAuth — added only when AUTH_GOOGLE_ID + AUTH_GOOGLE_SECRET are set
//
// JWT session strategy keeps things simple and lets the iOS app stay on
// the bearer-token path without touching NextAuth's session cookie.

import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { db } from "@/lib/db";
import { LIMITS } from "@/lib/limits";
import { verifyPassword } from "@/lib/password";

const providers: NextAuthConfig["providers"] = [
  Credentials({
    credentials: {
      email: { label: "Email", type: "email" },
      password: { label: "Password", type: "password" },
    },
    // Inputs are length-capped before reaching bcrypt to prevent CPU
    // DoS via huge passwords (CVE-2013-7459-style).
    async authorize(credentials) {
      const email = String(credentials?.email ?? "")
        .toLowerCase()
        .trim()
        .slice(0, LIMITS.email);
      const password = String(credentials?.password ?? "").slice(0, LIMITS.password);
      if (!email || !password) return null;

      const user = await db.user.findUnique({ where: { email } });
      if (!user || !user.passwordHash) return null;

      const ok = await verifyPassword(password, user.passwordHash);
      if (!ok) return null;

      return { id: user.id, email: user.email, name: user.name };
    },
  }),
];

if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
  providers.push(Google);
}

export const { auth, handlers, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  providers,

  callbacks: {
    // For Google sign-in we don't have a row in our User table yet —
    // upsert one and rewrite `user.id` so the rest of the auth flow
    // uses our DB id. Credentials sign-in already returns our DB user
    // from authorize(), so we leave it alone.
    //
    // Two safety guards on Google:
    //   1. Reject unverified Google emails — Workspace admins can suppress
    //      `email_verified`, which would otherwise let someone with a
    //      forged email sign in.
    //   2. Refuse to merge into an account that already has a credentials
    //      password set. Otherwise anyone who registers a Google account
    //      with the same email as an existing user could take over that
    //      user's saved recipes.
    async signIn({ user, account, profile }) {
      if (account?.provider === "google") {
        if (!user.email) return false;
        if (profile && profile.email_verified === false) return false;

        const existing = await db.user.findUnique({
          where: { email: user.email },
        });
        if (existing?.passwordHash) return false;

        const dbUser = await db.user.upsert({
          where: { email: user.email },
          create: { email: user.email, name: user.name ?? null },
          update: { name: user.name ?? undefined },
        });
        user.id = dbUser.id;
      }
      return true;
    },

    async jwt({ token, user }) {
      if (user) token.id = user.id;
      return token;
    },

    async session({ session, token }) {
      if (session.user && token.id) {
        session.user.id = String(token.id);
      }
      return session;
    },
  },
});
