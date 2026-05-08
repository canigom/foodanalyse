// Password hashing helper.
//
// Why this file exists: bcrypt silently truncates inputs to 72 bytes. Two
// passwords that share the first 72 bytes hash to the SAME value, which is
// a real-world bypass. We avoid the bug by SHA-256-pre-hashing the password
// (32 raw bytes -> 44 base64 chars, safely under bcrypt's 72-byte limit) and
// passing the digest to bcrypt. Same approach Dropbox/Auth0 use.

import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";

const COST = 10;

function preHash(password: string): string {
  return createHash("sha256").update(password, "utf8").digest("base64");
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(preHash(password), COST);
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  if (await bcrypt.compare(preHash(password), hash)) return true;
  // Backward compat for accounts created before the SHA-256 pre-hash change
  // (would be plain bcrypt(password)). Lets older users sign in seamlessly.
  if (await bcrypt.compare(password, hash)) return true;
  return false;
}
