// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserSha256 } from "../src/security/browserSha256";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browserSha256", () => {
  it("keeps verified workspace integrity checks available without Web Crypto", async () => {
    vi.stubGlobal("crypto", undefined);

    await expect(browserSha256("")).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    await expect(browserSha256("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    await expect(browserSha256("Saltanat · Сәлем · привет")).resolves.toBe(
      "d31a557cac83178610c19e65e5a6155383a151a73b82195cee52666217b17ec7"
    );
  });

  it("handles multiple SHA-256 blocks in the public-HTTP fallback", async () => {
    vi.stubGlobal("crypto", undefined);

    await expect(browserSha256("a".repeat(1_000))).resolves.toBe(
      "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3"
    );
  });
});
