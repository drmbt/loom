import type { ProjectDocument } from "../../../domain/types/graph.ts";
import type { StoredParameter } from "../../../domain/types/parameters.ts";
import { DOF_WGSL } from "../../furnace/screen-space.ts";
import { MIRROR_WGSL } from "../fx.ts";
import type { OnNothingFacts } from "../scene-facts.ts";
import { Plate, cycKey, knob, soleCycFigure, vectorKnobs, wobble } from "./plate.ts";
import { handUpPose } from "./poses.ts";

/**
 * T1407b (mirror) — BILATERAL MIRROR SYMMETRY, the reference's 1:23.13–1:23.55 (11 frames).
 *
 * Measured from the reference, frame by frame:
 *
 *  - The mirror axis is EXACTLY the frame centre (best axis 960/961 px of 1920 in every frame,
 *    mean |left − mirrored right| ≈ 1 grey level): the left half is the plate, the right half
 *    its flip. No blend at the seam — two fingertips meet there over a sliver of white.
 *  - The plate: a right hand raised in front of the face, the back of the hand to the lens,
 *    fingers up and in toward the seam; a big ring (a black square pyramid in a pavé frame) on
 *    it at x ≈ 0.19, y ≈ 0.35, ~0.1 of the frame wide, the only sharp thing. The face behind
 *    (nose, mouth, the sunglasses at the top) is a heavy blur; black tee and chain at the bottom.
 *  - High key: the background rgb 218,224,219 (a faint green-cyan), skin desaturated to
 *    rgb 122,112,110 lit and 58,50,50 in shade, blacks at 8. Luma p5 = 20, p50 = 113, p95 = 225.
 *  - Motion: the hand breathes (a few pixels), the fingertips open away from the seam and
 *    close again; short streaks rise off the ring's diamonds.
 */

/** The cut's length in seconds: 11 frames at 23.976. */
export const MIRROR_SECONDS = 11 / 23.976;

type Builder = (facts: OnNothingFacts, options: { shot: "cyc"; width?: number; height?: number; audio?: boolean; crt?: boolean }) => ProjectDocument;

export interface MirrorOptions {
  readonly width?: number;
  readonly height?: number;
  readonly audio?: boolean;
  readonly crt?: boolean;
}

export function mirrorDocument(facts: OnNothingFacts, build: Builder, options: MirrorOptions): ProjectDocument {
  const document = build(facts, { ...options, shot: "cyc" });
  // the depth of field is in pixels: scale it with the frame (--final renders at 2x)
  const scale = (options.width ?? 1920) / 1920;
  // the white limbo (shots/cyc.ts): its room, its finish, its cyan cast; none of its trail
  const plate = new Plate(document);
  plate.bypass("trail");
  // The curled-hand body (tools/blender/on-nothing/jewels.py): the fingers baked half-closed,
  // the pyramid ring on the left middle finger. The loom rig has no finger bones.
  const hand = facts.areas.get("fighand");
  if (hand === undefined) throw new Error("mirrorDocument: the GLB has no fighand area — rebuild it (tools/blender/on-nothing/jewels.py).");
  plate.set("fig", { select: hand.select, vertices: hand.vertices, triangles: hand.triangles, parts: hand.parts, joints: hand.joints });
  // the figure at the origin, facing the lens, the left hand up before the face
  const skin = soleCycFigure(plate);
  plate.set(skin, { capacity: hand.vertices, place: [0, 0, 0], yaw: 0, ...handUpPose(facts) });
  // The camera: a long lens from the figure's left, level with the fist. Seen from there the
  // face falls to the fist's right and the thumb to its left, so the plate's RIGHT half holds
  // the thumb (at the plate's centre), the ring and, blurred behind, the face — mirrored below
  // (thumbs meeting at the seam, rings either side, the face at both edges, as the reference).
  const eye = [0.29, 1.53, 0.93] as const;
  const look = [-0.02, 1.518, 0.311] as const;
  plate.clearSlots("cam", "eye");
  plate.clearSlots("cam", "lookAt");
  plate.set("cam", {
    ...vectorKnobs("eye", [`${eye[0]} + ${wobble(11, 0.003)}`, `${eye[1]} + ${wobble(12, 0.003)}`, `${eye[2]} - abstime * 0.012`], [eye[0], eye[1], eye[2]]),
    ...vectorKnobs("lookAt", [`${look[0]} + ${wobble(13, 0.004)}`, `${look[1]} + ${wobble(14, 0.004)}`, `${look[2]}`], [look[0], look[1], look[2]]),
    fov: 12,
    // the reference's frame is tilted: the face leans into the seam
    roll: knob(`10 + abstime * 1.5 + ${wobble(15, 0.8)}`, 10),
  });
  // depth of field: the ring sharp, the face behind it a heavy blur
  const cameraParams = Object.fromEntries(Object.entries(plate.node("occlusion").parameters).filter(([key]) => /^(eye|aim|fov|far|roll)(\.|$)/.test(key)));
  plate.add("lens_dof", "customWgslMulti", { source: DOF_WGSL, ...cameraParams, focusDistance: 0.6, aperture: 8 * scale, maxRadius: 32 * scale } as Record<string, StoredParameter>, { label: "lens_dof1", resolution: { mode: "project" } });
  plate.spliceAfter("occlusion", "lens_dof", [["shot", "depth"]]);
  // BACKLIT, as the reference: the white room glows behind, the key comes from behind the
  // figure toward the lens, so the back of the hand facing us sits in soft shade (skin at
  // luma 60-120 against a 222 background) and only the ring's edges catch it
  cycKey(plate, { intensity: 3, direction: [0.25, -0.45, 0.86] });
  plate.set("shot", { ambientIntensity: 0.55 });
  // the streak glass (the stock Streak, image-space, so it turns with the camera's roll):
  // short columns off the pave's glints, as the reference's
  plate.add("streak", "streak", { threshold: 2.5, knee: 0.5, length: 0.18, falloff: 1.2, gain: 0.8, striation: 0.4 }, { label: "streak1" });
  plate.spliceAfter("lens", "streak");
  // high key: the room near white (the reference's 218,224,219), the skin a warm grey
  plate.set("finish", { exposure: 0.4, saturation: 0.6, redGamma: 1.1 });
  // the mirror: the plate's right half on the right, its flip on the left, meeting at the centre
  plate.add("mirror", "customWgsl", { source: MIRROR_WGSL, tiles: 2, crop: 0.5, centre: 0.75, flip: 1, phase: 1, seam: 0 }, { label: "mirror1", resolution: { mode: "project" } });
  plate.spliceAfter("finish", "mirror");
  return {
    ...document,
    projectId: "project-on-nothing-mirror",
    name: "On Nothing · mirror",
    graph: { ...document.graph, nodes: Object.fromEntries(plate.nodes), edges: Object.fromEntries(plate.edges) },
  };
}
