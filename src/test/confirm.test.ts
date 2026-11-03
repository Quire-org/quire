import { describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ask, askText, ConfirmHost } from "../components/Confirm";

const button = (_scope: HTMLElement, text: string) => Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.includes(text)) as HTMLButtonElement;

describe("the app's own confirm", () => {
  it("waits for the answer: only the confirm button says yes", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(ConfirmHost)));

    let answer: boolean | undefined;
    await act(async () => void ask({ title: "Move album to the trash?", message: "Trip", confirm: "Move to trash", danger: true }).then((v) => (answer = v)));
    expect(document.body.textContent).toContain("Move album to the trash?");
    expect(answer).toBeUndefined(); // nothing happens until a button is pressed
    await act(async () => button(host, "Cancel").click());
    expect(answer).toBe(false);
    expect(document.body.textContent).toBe("");

    await act(async () => void ask({ title: "Sure?", message: "", confirm: "Move to trash" }).then((v) => (answer = v)));
    await act(async () => button(host, "Move to trash").click());
    expect(answer).toBe(true);

    // Escape is a no.
    await act(async () => void ask({ title: "Sure?", message: "", confirm: "Delete for good", safeDefault: true }).then((v) => (answer = v)));
    expect(document.activeElement?.textContent).toBe("Cancel"); // Enter wouldn't delete by reflex
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(answer).toBe(false);

    // A second question answers the first one no.
    let first: boolean | undefined;
    await act(async () => void ask({ title: "One", message: "", confirm: "OK" }).then((v) => (first = v)));
    await act(async () => void ask({ title: "Two", message: "", confirm: "OK" }));
    expect(first).toBe(false);
    expect(document.body.textContent).toContain("Two");
    await act(async () => button(host, "Cancel").click());
    root.unmount();
  });

  it("asks for a name, trimmed; empty or cancelled is null", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(ConfirmHost)));
    let got: string | null | undefined;
    await act(async () => void askText({ title: "Rename tag", message: "", initial: "cat", confirm: "Rename" }).then((v) => (got = v)));
    const input = document.body.querySelector("input")!;
    expect(input.value).toBe("cat");
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "  kitten  ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(host, "Rename").click());
    expect(got).toBe("kitten");
    await act(async () => void askText({ title: "Rename tag", message: "", initial: "cat", confirm: "Rename" }).then((v) => (got = v)));
    await act(async () => button(host, "Cancel").click());
    expect(got).toBeNull();
    root.unmount();
  });
});
