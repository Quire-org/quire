import React from "react";
import { AppWindow, Backdrop, Screen, frame } from "./look";

/** A captured frame in the window on the backdrop, for the README. */
export const SHOT = { width: 1600, height: 1040, window: 1480 };

export function Screenshot({ id }: { id: string }) {
  return (
    <Backdrop>
      <div style={{ position: "absolute", left: (SHOT.width - SHOT.window) / 2, top: (SHOT.height - (SHOT.window / 1.6 + 30)) / 2 }}>
        <AppWindow width={SHOT.window}>
          <Screen f={frame(id)} />
        </AppWindow>
      </div>
    </Backdrop>
  );
}
