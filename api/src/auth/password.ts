import bcrypt from "bcryptjs";

const ROUNDS = 10;

export function hashSecret(secret: string): Promise<string> {
  return bcrypt.hash(secret, ROUNDS);
}

export function verifySecret(secret: string, hash: string): Promise<boolean> {
  return bcrypt.compare(secret, hash);
}
