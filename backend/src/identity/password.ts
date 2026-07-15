import { argon2, randomBytes, timingSafeEqual } from "node:crypto";

const algorithm = "argon2id" as const;
const memory = 65_536;
const passes = 3;
const parallelism = 2;
const tagLength = 32;

function derive(password: string, salt: Buffer, parameters = { memory, passes, parallelism, tagLength }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      algorithm,
      {
        message: Buffer.from(password, "utf8"),
        nonce: salt,
        parallelism: parameters.parallelism,
        tagLength: parameters.tagLength,
        memory: parameters.memory,
        passes: parameters.passes
      },
      (error, result) => (error ? reject(error) : resolve(result))
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const digest = await derive(password, salt);
  return `$argon2id$v=19$m=${memory},t=${passes},p=${parallelism}$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(encoded);
  if (!match) return false;
  const [, memoryText, passesText, parallelismText, saltText, digestText] = match;
  const expected = Buffer.from(digestText, "base64url");
  const parameters = {
    memory: Number(memoryText),
    passes: Number(passesText),
    parallelism: Number(parallelismText),
    tagLength: expected.length
  };
  if (
    !Number.isInteger(parameters.memory) || parameters.memory < 8_192 || parameters.memory > 1_048_576 ||
    !Number.isInteger(parameters.passes) || parameters.passes < 1 || parameters.passes > 10 ||
    !Number.isInteger(parameters.parallelism) || parameters.parallelism < 2 || parameters.parallelism > 16 ||
    parameters.tagLength < 16 || parameters.tagLength > 64
  ) return false;
  try {
    const actual = await derive(password, Buffer.from(saltText, "base64url"), parameters);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export const passwordPolicy = {
  minimumLength: 12,
  maximumLength: 256
} as const;

export function passwordPolicyError(password: string, login?: string): string | undefined {
  if (password.length < passwordPolicy.minimumLength) return `Password must contain at least ${passwordPolicy.minimumLength} characters.`;
  if (password.length > passwordPolicy.maximumLength) return `Password must contain at most ${passwordPolicy.maximumLength} characters.`;
  if (login && password.toLocaleLowerCase("en-US").includes(login.toLocaleLowerCase("en-US"))) return "Password must not contain the login.";
  return undefined;
}
