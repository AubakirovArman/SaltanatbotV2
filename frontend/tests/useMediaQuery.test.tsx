// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMediaQuery } from "../src/hooks/useMediaQuery";

afterEach(() => vi.unstubAllGlobals());

describe("useMediaQuery", () => {
  it("tracks native media-query change events and removes its listener on unmount", async () => {
    const media = new EventTarget() as MediaQueryList & { matches: boolean };
    Object.assign(media, { matches: false, media: "(max-width: 760px)", onchange: null });
    const remove = vi.spyOn(media, "removeEventListener");
    vi.stubGlobal("matchMedia", vi.fn(() => media));
    const container = document.createElement("div");
    const root = createRoot(container);
    let mobile = false;

    function Harness() {
      mobile = useMediaQuery("(max-width: 760px)");
      return null;
    }

    await act(async () => root.render(<Harness />));
    expect(mobile).toBe(false);
    await act(async () => {
      media.matches = true;
      media.dispatchEvent(new Event("change"));
    });
    expect(mobile).toBe(true);
    await act(async () => root.unmount());
    expect(remove).toHaveBeenCalledWith("change", expect.any(Function));
  });
});
