import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { compileFittedMedia, MEDIA_IMAGE_FIT_PARAMETERS } from "./media.ts";

export const SCREEN_IN_TYPE = "screenIn";

/** Capture permission and the selected surface belong to the live session, not the document. */
export const screenInNode: NodeDefinition = {
  type: SCREEN_IN_TYPE,
  version: 1,
  title: "Screen In",
  category: "input",
  description:
    "Live browser tab, window or screen capture. Click Share in the inspector to choose a surface; Stop ends sharing. Loading a project never starts capture. The selected surface and permission are session-only. Live input is not deterministic replay.",
  tags: ["screen", "capture", "display", "window", "tab", "live"],
  inputs: [],
  outputs: [{ id: "out", label: "Picture", type: RGBA_TEXTURE }],
  parameters: { ...MEDIA_IMAGE_FIT_PARAMETERS },
  resolutionPolicy: { kind: "project" },
  compile: compileFittedMedia,
};
