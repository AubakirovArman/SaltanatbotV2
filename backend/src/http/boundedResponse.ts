/** Reads at most maxBytes from a Fetch response without allocating an oversized chunked body. */
export async function readBoundedText(response: Response, maxBytes: number, tooLarge: () => Error): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive safe integer");
  const declaredHeader = response.headers.get("content-length");
  if (declaredHeader !== null) {
    const declared = Number(declaredHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await cancelBody(response);
      throw tooLarge();
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function cancelBody(response: Response) {
  await response.body?.cancel().catch(() => undefined);
}
