import React from "react";
import { AppWindow, Backdrop, Screen, ScenesContext, useFrames, type Scenes } from "./look";

/** A captured frame in the window on the backdrop, for a README. */
export const SHOT = { width: 1600, height: 1040, window: 1480 };

function Framed({ id }: { id: string }) {
  const frameOf = useFrames();
  return (
    <div style={{ position: "absolute", left: (SHOT.width - SHOT.window) / 2, top: (SHOT.height - (SHOT.window / 1.6 + 30)) / 2 }}>
      <AppWindow width={SHOT.window}>
        <Screen f={frameOf(id)} />
      </AppWindow>
    </div>
  );
}

export function Screenshot({ id, scenes }: { id: string; scenes: Scenes }) {
  return (
    <ScenesContext.Provider value={scenes}>
      <Backdrop>
        <Framed id={id} />
      </Backdrop>
    </ScenesContext.Provider>
  );
}
