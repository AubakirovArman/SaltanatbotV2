import { describe, expect, it, vi } from "vitest";
import { readBoundedText } from "../src/http/boundedResponse.js";

describe("bounded Fetch response reader", () => {
  it("reads chunked UTF-8 within the byte limit", async () => {
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"ok":'));
        controller.enqueue(encoder.encode("true}"));
        controller.close();
      }
    }));
    await expect(readBoundedText(response, 32, () => new Error("too large"))).resolves.toBe('{"ok":true}');
  });

  it("cancels an undeclared chunked body as soon as the streamed limit is crossed", async () => {
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(8));
        controller.enqueue(new Uint8Array(8));
      },
      cancel: cancelled
    }));
    await expect(readBoundedText(response, 10, () => new Error("too large"))).rejects.toThrow("too large");
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("rejects a declared oversized response before reading it", async () => {
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream({ cancel: cancelled }), { headers: { "Content-Length": "100" } });
    await expect(readBoundedText(response, 10, () => new Error("too large"))).rejects.toThrow("too large");
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
