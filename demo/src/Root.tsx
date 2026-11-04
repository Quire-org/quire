import React from "react";
import { Composition, Still } from "remotion";
import { DEMO_FRAMES, Demo } from "./Demo";
import { SHOT, Screenshot } from "./Screenshot";

export function Root() {
  return (
    <>
      <Composition id="Demo" component={Demo} durationInFrames={DEMO_FRAMES} fps={30} width={1920} height={1080} />
      <Still id="Screenshot" component={Screenshot} width={SHOT.width} height={SHOT.height} defaultProps={{ id: "home" }} />
    </>
  );
}
