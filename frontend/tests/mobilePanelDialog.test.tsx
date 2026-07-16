// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobilePanelDialog } from "../src/components/MobilePanelDialog";

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    }
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    }
  });
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value(callback: FrameRequestCallback) {
      callback(0);
      return 1;
    }
  });
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  document.body.innerHTML = "";
});

describe("MobilePanelDialog lifecycle", () => {
  it("does not mount expensive content while closed and unmounts it on close", async () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();
    const onClose = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(<DialogHarness open={false} mounted={mounted} unmounted={unmounted} onClose={onClose} />));
    expect(mounted).not.toHaveBeenCalled();
    expect(container.querySelector(".expensive-content")).toBeNull();

    await act(async () => root.render(<DialogHarness open mounted={mounted} unmounted={unmounted} onClose={onClose} />));
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".expensive-content")).not.toBeNull();
    expect(container.querySelector("dialog")?.hasAttribute("open")).toBe(true);

    await act(async () => root.render(<DialogHarness open={false} mounted={mounted} unmounted={unmounted} onClose={onClose} />));
    expect(unmounted).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".expensive-content")).toBeNull();
    expect(container.querySelector("dialog")?.hasAttribute("open")).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});

function DialogHarness({
  mounted,
  onClose,
  open,
  unmounted
}: {
  mounted: () => void;
  onClose: () => void;
  open: boolean;
  unmounted: () => void;
}) {
  return (
    <MobilePanelDialog id="test-dialog" open={open} label="Test panel" closeLabel="Close" onClose={onClose}>
      <ExpensiveContent mounted={mounted} unmounted={unmounted} />
    </MobilePanelDialog>
  );
}

function ExpensiveContent({ mounted, unmounted }: { mounted: () => void; unmounted: () => void }) {
  useEffect(() => {
    mounted();
    return () => {
      unmounted();
    };
  }, [mounted, unmounted]);
  return <div className="expensive-content">Expensive</div>;
}
