import React from "react";
import { Composition, Still } from "remotion";
import { Demo, demoFrames, type DemoProps } from "./Demo";
import { SHOT, Screenshot } from "./Screenshot";

/** Until render.mjs passes a demo's script and frames (--props). */
const NONE: DemoProps = {
  script: { name: "", repository: "", title: { title: "", line: "" }, parts: [], end: { title: "", lines: [] }, stills: {}, loop: { from: 0, length: 1 } },
  scenes: { scale: 2, frames: [] },
};

export function Root() {
  return (
    <>
      <Composition
        id="Demo"
        component={Demo}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={NONE}
        calculateMetadata={({ props }) => ({ durationInFrames: demoFrames(props.script) })}
      />
      <Still id="Screenshot" component={Screenshot} width={SHOT.width} height={SHOT.height} defaultProps={{ id: "", scenes: NONE.scenes }} />
    </>
  );
}
