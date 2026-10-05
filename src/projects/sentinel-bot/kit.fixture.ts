import type { KitFacts } from "./kit.ts";

/**
 * T1561b — the kit's facts as measured on 2026-10-05 (tools/blender/sentinel-bot/build.py over
 * the reference FBX), for tests of the rig. Joint frames are the kit's: +Z the tangent, +Y the normal. The kit itself is gitignored — it is cut from a
 * third-party asset — so a test cannot read it; the rig needs only these numbers, not the mesh.
 */
export const KIT_FIXTURE: KitFacts = {
  glbUrl: "media/sentinel-bot/sentinel.glb",
  // The rig never reads the meshes' selections; a test that draws them must load the kit.
  robot: { select: "", vertices: 0, triangles: 0, parts: "" },
  ring: { select: "", vertices: 0, triangles: 0, parts: "" },
  hub: { select: "", vertices: 0, triangles: 0, parts: "" },
  claw: { select: "", vertices: 0, triangles: 0, parts: "" },
  phalanxMeshes: [],
  sockets: [
    [0.37341, 0.17407, -0.37004],
    [-0.31631, 0.27334, -0.37004],
    [0.04589, 0.28548, -0.37004],
    [0.50918, -0.06339, -0.37004],
    [0.1854, -0.01679, -0.42806],
    [-0.16974, 0.03432, -0.42806],
    [-0.48252, 0.06333, -0.35957],
    [-0.36158, -0.18351, -0.35957],
    [0.33123, -0.26871, -0.35957],
    [-0.02248, -0.28645, -0.35957],
  ],
  ringCount: 54,
  ringPitch: 0.06,
  ringStart: 0,
  hubDistance: 3.18,
  fingers: 4,
  phalanges: [
    { finger: 0, link: 0, joint: [0.07282, -0.00033, 0.17068], rest: [0.00006, 0.43586, 0.00002, 0.90001], axis: [0.00372, 0.99994, -0.01059], range: [-0.9908, 0.92286] },
    { finger: 0, link: 1, joint: [0, 0, 0.16136], rest: [-0.00129, -0.18339, 0.00088, 0.98304], axis: [0.01271, -0.99991, -0.0039], range: [-0.43802, 1.66583] },
    { finger: 1, link: 0, joint: [-0.07987, 0.00075, 0.17073], rest: [0.43586, -0.00002, -0.90001, 0.00001], axis: [-0.00372, -0.99994, -0.01062], range: [-0.9908, 0.92285] },
    { finger: 1, link: 1, joint: [0, 0, 0.16136], rest: [-0.00129, -0.18339, 0.00088, 0.98304], axis: [0.01271, -0.99991, -0.0039], range: [-0.43802, 1.66583] },
    { finger: 2, link: 0, joint: [-0.00302, 0.07702, 0.1707], rest: [-0.3082, 0.3082, 0.63641, 0.6364], axis: [-0.99994, 0.00374, -0.01065], range: [-0.9908, 0.92286] },
    { finger: 2, link: 1, joint: [0, 0, 0.16136], rest: [-0.00129, -0.18339, 0.00088, 0.98304], axis: [0.01142, -0.99993, -0.00332], range: [-0.43775, 1.66585] },
    { finger: 3, link: 0, joint: [-0.00417, -0.07641, 0.17071], rest: [0.3082, 0.30821, -0.6364, 0.6364], axis: [0.99994, -0.00374, -0.01066], range: [-0.9908, 0.92285] },
    { finger: 3, link: 1, joint: [0, 0, 0.16136], rest: [-0.00129, -0.18339, 0.00088, 0.98304], axis: [0.01271, -0.99991, -0.0039], range: [-0.43802, 1.66584] },
  ],
  eyes: [],
};
