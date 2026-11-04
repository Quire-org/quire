import { useState } from "react";
import { create } from "zustand";
import { Plus } from "@phosphor-icons/react";
import { Modal } from "./Modal";
import { useScrapbook } from "../scrapbook/store";
import { BOARD_SIZES } from "../scrapbook/model";

/** A new board: its name and a size to begin with (changed at will in its editor). */
export function NewBoard({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [size, setSize] = useState(BOARD_SIZES[0]);
  const make = () => {
    onClose();
    void useScrapbook.getState().newBoard(name || "Board", { w: size.w, h: size.h });
  };
  return (
    <Modal title="New board" onClose={onClose}>
      <div className="new-cover">
        <input className="input" autoFocus placeholder="Its name: Poses, Lighting, Character…" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && make()} />
        <div className="label">Size</div>
        <div className="chips">
          {BOARD_SIZES.map((s) => (
            <button key={s.name} className={`chip ${s === size ? "active" : ""}`} onClick={() => setSize(s)} title={`${s.w} × ${s.h} pixels`}>
              {s.name}
            </button>
          ))}
        </div>
        <div className="dim small">Any size can be set later in the board's editor, where what is on it keeps its place.</div>
        <div className="row">
          <span className="grow" />
          <button className="btn primary" onClick={make}>
            <Plus /> Make the board
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** A new board asked for from outside the Scrapbook (the Home's Boards block, its key): one dialog, wherever it was asked. */
const useAsked = create<{ open: boolean }>(() => ({ open: false }));
export const askNewBoard = () => useAsked.setState({ open: true });

export function NewBoardAsked() {
  const open = useAsked((x) => x.open);
  return open ? <NewBoard onClose={() => useAsked.setState({ open: false })} /> : null;
}
