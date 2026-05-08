// JWT helpers for the iOS bearer-token auth flow.
//
// We use `jose` (pure ESM, zero native deps) to sign and verify HS256
// tokens. NextAuth itself uses `jose` under the hood, so adding it here
// doesn't bloat the dependency tree — we'd be loading it anyway.
//
// Token shape: {sub: userId, email, iat, exp}. 30-day expiry per spec.

import { SignJWT, jwtVerify } from "jose";

const ALG = "HS256";
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export type SessionClaims = {
  userId: string;
  email: string;
};

function getSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "AUTH_SECRET is not set. Generate one with: " +
        `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  return new TextEncoder().encode(secret);
}

export async function signSessionToken(claims: SessionClaims): Promise<string> {
  return new SignJWT({ email: claims.email })
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .sign(getSecret());
}

export async function verifySessionToken(token: string): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, getSecret(), {
    algorithms: [ALG],
  });
  if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
    throw new Error("Token payload missing sub/email");
  }
  return { userId: payload.sub, email: payload.email };
}
