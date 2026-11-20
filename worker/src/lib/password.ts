import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Password hashing with the runtime's native scrypt (node:crypto via nodejs_compat).
 * Better Auth's default falls back to a pure-JS scrypt on Workers, which costs far more CPU.
 * Parameters match Better Auth's defaults (N=16384, r=16, p=1, 64-byte key).
 * Stored format: "scrypt:N:r:p:saltHex:keyHex" so parameters can rise later without breaking old hashes.
 */
const N = 16384;
const R = 16;
const P = 1;
const KEYLEN = 64;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEYLEN, { N: n, r, p, maxmem: 256 * n * r * p }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return ["scrypt", N, R, P, salt.toString("hex"), key.toString("hex")].join(":");
}

export async function verifyPassword({ hash, password }: { hash: string; password: string }): Promise<boolean> {
  const parts = hash.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![n, r, p].every((v) => Number.isInteger(v) && v > 0) || n > 1 << 20 || r > 32 || p > 4) return false;
  const salt = Buffer.from(parts[4]!, "hex");
  const expected = Buffer.from(parts[5]!, "hex");
  if (salt.length !== 16 || expected.length !== KEYLEN) return false;
  const actual = await derive(password, salt, n, r, p);
  return timingSafeEqual(actual, expected);
}
