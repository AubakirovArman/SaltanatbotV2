// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoteEditor, sanitizeNoteText } from "../src/components/chartCanvas/NoteEditor";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  document.body.innerHTML = "";
});

async function renderEditor(props: Partial<Parameters<typeof NoteEditor>[0]> = {}) {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  await act(async () => root.render(<NoteEditor locale="en" onSave={onSave} onCancel={onCancel} {...props} />));
  const dialog = container.querySelector<HTMLElement>(".note-editor");
  const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
  expect(dialog).not.toBeNull();
  expect(textarea).not.toBeNull();
  return { dialog: dialog!, textarea: textarea!, onSave, onCancel };
}

async function typeText(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("text note inline editor", () => {
  it("opens as a labelled dialog with a focused, capped textarea and 44px actions", async () => {
    const { dialog, textarea } = await renderEditor({ initialText: "Support retest" });

    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const titleId = dialog.getAttribute("aria-labelledby");
    expect(titleId).toBeTruthy();
    expect(document.getElementById(titleId!)?.textContent).toBe("Edit text note");
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe("Support retest".length);
    expect(textarea.maxLength).toBe(500);
    expect(textarea.getAttribute("aria-label")).toBe("Note text");
    const labels = [...dialog.querySelectorAll("button")].map((button) => button.textContent);
    expect(labels).toEqual(["Cancel", "Save note"]);
  });

  it("saves typed text through the button and through Ctrl+Enter", async () => {
    const { dialog, textarea, onSave, onCancel } = await renderEditor();
    await typeText(textarea, "First line\nsecond line");

    const save = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Save note")!;
    await act(async () => save.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).toHaveBeenCalledWith("First line\nsecond line");

    await typeText(textarea, "Keyboard save");
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    });
    expect(onSave).toHaveBeenCalledWith("Keyboard save");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("cancels via Escape and the cancel button without saving", async () => {
    const { dialog, textarea, onSave, onCancel } = await renderEditor({ initialText: "Draft" });
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);

    const cancel = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Cancel")!;
    await act(async () => cancel.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows the informational author and creation-time metadata", async () => {
    const createdAt = Date.UTC(2026, 6, 17, 10, 30);
    const { dialog } = await renderEditor({ author: "owner-login", createdAt });
    const caption = dialog.querySelector("header small")?.textContent ?? "";
    expect(caption).toContain("owner-login");
    expect(caption).toContain(new Date(createdAt).toLocaleString("en"));
  });

  it("sanitizes note text to newline-only control characters within the shared cap", () => {
    expect(sanitizeNoteText("a\r\nb\rc")).toBe("a\nb\nc");
    expect(sanitizeNoteText("keep\nlines\ttabs")).toBe("keep\nlinestabs");
    expect(sanitizeNoteText("x".repeat(600))).toHaveLength(500);
    expect(sanitizeNoteText("")).toBe("");
  });
});
