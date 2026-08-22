import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number },
) => Promise<Buffer>;

/**
 * Password hashing with scrypt from node:crypto.
 *
 * No bcrypt/argon2 dependency: scrypt is memory-hard, in the standard library, needs
 * no native build step, and is what OWASP lists as acceptable when Argon2id is not
 * available. Parameters are stored in the hash string so they can be raised later
 * without invalidating existing passwords.
 */
const N = 16384, R = 8, P = 1, KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  try {
    const salt = Buffer.from(saltB64!, 'base64');
    const expected = Buffer.from(keyB64!, 'base64');
    const actual = await scrypt(password, salt, expected.length,
      { N: Number(n), r: Number(r), p: Number(p) });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Password policy. Length beats composition rules - NIST dropped the
 * uppercase/symbol requirements years ago because they push people towards
 * "Password1!" and nothing else.
 */
export function passwordProblem(password: string): string | null {
  if (password.length < 8) return 'Use at least 8 characters';
  if (password.length > 200) return 'That password is too long';
  const common = ['password', '12345678', 'qwerty123', 'iloveyou', 'admin123'];
  if (common.includes(password.toLowerCase())) return 'That password is too common';
  return null;
}
