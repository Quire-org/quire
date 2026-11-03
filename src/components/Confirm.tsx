import { useEffect, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import { Modal } from "./Modal";

/**
 * The app's own "are you sure?". The webview's window.confirm doesn't wait for the answer (the
 * action went ahead whatever was pressed), so nothing uses it: `await ask({...})` instead, which
 * resolves true only when the confirm button is pressed. `askText` is the same for a name
 * (window.prompt has the same trouble).
 */
interface Ask {
  title: string;
  message: ReactNode;
  /** The confirm button's words ("Move to trash"). */
  confirm: string;
  /** Red confirm button: something is lost or moved away. */
  danger?: boolean;
  /** Start on Cancel (for what can't be undone), so Enter doesn't confirm by reflex. */
  safeDefault?: boolean;
  /** Asks for text: the field starts with this. */
  text?: string;
}

const useAsk = create<{ open: (Ask & { resolve: (answer: string | null) => void }) | null }>(() => ({ open: null }));

function open(a: Ask): Promise<string | null> {
  // A question still open is answered "no" before the next one shows.
  useAsk.getState().open?.resolve(null);
  return new Promise((resolve) => useAsk.setState({ open: { ...a, resolve } }));
}

export async function ask(a: Ask): Promise<boolean> {
  return (await open({ ...a, text: undefined })) !== null;
}

/** A name or other short text; null when cancelled or left empty. */
export async function askText(a: Omit<Ask, "safeDefault" | "text"> & { initial: string }): Promise<string | null> {
  const got = await open({ ...a, text: a.initial });
  return got?.trim() ? got.trim() : null;
}

/** Mounted once (App): shows the question asked, if any. */
export function ConfirmHost() {
  const q = useAsk((s) => s.open);
  const yes = useRef<HTMLButtonElement>(null);
  const no = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  useEffect(() => {
    if (!q) return;
    setText(q.text ?? "");
    if (q.text != null) setTimeout(() => field.current?.select(), 0);
    else (q.safeDefault ? no : yes).current?.focus();
  }, [q]);
  if (!q) return null;
  const answer = (v: string | null) => {
    useAsk.setState({ open: null });
    q.resolve(v);
  };
  const confirm = () => answer(q.text != null ? text : "yes");
  return (
    <Modal title={q.title} onClose={() => answer(null)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          confirm();
        }}
      >
        <div className="confirm-body">{q.message}</div>
        {q.text != null && <input ref={field} className="input confirm-field" value={text} onChange={(e) => setText(e.target.value)} />}
        <div className="row pop-actions confirm-actions">
          <span className="grow" />
          <button ref={no} type="button" className="btn ghost" onClick={() => answer(null)}>
            Cancel
          </button>
          <button ref={yes} type="submit" className={`btn ${q.danger ? "danger" : "primary"}`} disabled={q.text != null && !text.trim()}>
            {q.confirm}
          </button>
        </div>
      </form>
    </Modal>
  );
}
