export class IdentityError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function normalizeLogin(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

export function validateLogin(
  value: string
): { login: string; normalized: string } {
  const login = value.trim().normalize("NFKC");
  const normalized = normalizeLogin(login);
  if (
    login.length < 3 ||
    login.length > 64 ||
    !/^[\p{L}\p{N}_.@-]+$/u.test(login)
  ) {
    throw new IdentityError(
      400,
      "invalid_login",
      "Login must contain 3–64 letters, digits, dots, dashes, underscores or @."
    );
  }
  return { login, normalized };
}

export function validateReason(reason: string): string {
  const value = reason.trim();
  if (
    value.length < 1 ||
    value.length > 500 ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw new IdentityError(
      400,
      "invalid_reason",
      "Reason must contain 1–500 printable characters."
    );
  }
  return value;
}

export function isUuid(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value
    )
  );
}

export function canonicalUuid(value: string): string {
  return value.toLowerCase();
}
