/** Strip XML-unsafe control characters and lone surrogates from compiler output text. */
export function sanitizeText(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || (code >= 0xd800 && code <= 0xdfff)) continue;
    out += ch;
  }
  return out.normalize("NFC").slice(0, 200);
}
