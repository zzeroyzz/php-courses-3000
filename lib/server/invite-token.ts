import 'server-only';
import { createHash, randomBytes } from 'node:crypto';

// Invite tokens are bearer credentials: whoever holds the link can create an
// account. Only sha256(token) is stored.
//
// Why SHA-256 and not bcrypt/argon2: password hashing is deliberately slow
// because passwords are low-entropy and guessable. These tokens are 32 bytes
// (256 bits) from a CSPRNG, so there is nothing to brute-force — a fast hash
// loses no security. And validation has to look the token up by its hash
// through a unique index, which needs a deterministic hash; salted bcrypt would
// force a scan comparing against every row.

export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

// Rejects obvious junk before it reaches the database.
export function isWellFormedToken(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}
