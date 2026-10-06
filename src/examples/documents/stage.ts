import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";

/**
 * E25 — Stage (T444). The MULTI-STAGE render the owner asked for, verbatim: "a multi
 * stage setup of a camera, geometry, reproduction, picked up by another camera then to
 * screen and all this driven interestingly."
 *
 * Scene A — the PERFORMANCE: a torus of lit octahedra under a magenta key, filmed by
 * a camera ORBITING on two quadrature LFOs. Its render is a TEXTURE.
 *
 * That texture crosses into scene B as a MATERIAL MAP — one plain edge into an unlit
 * material's albedo slot (V372: pixels are data, they travel on wires) — worn by a
 * flat grid standing in scene B like a cinema screen. A second camera, itself drifting,
 * films the screen and a floor of instanced boxes under a warm key, and THAT goes to
 * the output: a virtual screen inside a scene, the TD/Notch classic.
 *
 * Every stage is driven and nothing rebuilds: both orbits and the breathing fill are
 * VALUES through the scene payload channel (T377, §V5) — camera eyes and light
 * intensity re-publish per frame as uniform writes.
 */
export const stageDocument = document(
  "e25-stage",
  "E25 Stage",
  settings({ outputResolution: { width: 768, height: 432 } }),
  graph(
    [
      // ---- scene A: the performance ---------------------------------------------
      node("ringA", "pointTorus", [-1460, -184], { cols: 36, rows: 18, radius: 0.7, radius2: 0.28 }, { label: "torus_ringa" }),
      node("matA", "materialPhong", [-1460, -392], {
        color: [1, 0.25, 0.55, 1], specular: [1, 1, 1, 1], shininess: 80, roughness: 0.25,
      }, { label: "material_a" }),
      node("geoA", "geometry", [-1180, -184], {
        mode: "instances", shape: "octahedron", scale: 0.075, material: "material_a",
      }, { label: "geometry_a" }),
      node("orbAx", "lfo", [-1180, -552], { shape: "sine", frequency: 0.07, amplitude: 2.4, offset: 0, phase: 0 }, { label: "lfo_orbax" }),
      node("orbAz", "lfo", [-1180, -736], { shape: "sine", frequency: 0.07, amplitude: 2.4, offset: 0, phase: 0.25 }, { label: "lfo_orbaz" }),
      node("camA", "camera", [-1180, -368], { lookAt: [0, 0, 0], fov: 50 }, {
        label: "camera_a",
        parameters: {
          "eye.x": drivenSlot("lfo_orbax", 2.4),
          "eye.y": 0.9,
          "eye.z": drivenSlot("lfo_orbaz", 0),
        },
      }),
      node("keyA", "light", [-1180, -920], {
        kind: "directional", color: [1, 0.85, 0.95, 1], intensity: 1.1, direction: [-0.3, -0.8, -0.5],
      }, { label: "light_keya" }),
      node("shotA", "render", [-880, -184], {
        scenes: "geometry_a", camera: "camera_a", lights: "light_keya",
        ambientColor: [0.3, 0.2, 0.5, 1], ambientIntensity: 0.3,
        background: [0.14, 0.05, 0.2, 1],
      }, { label: "render_shota" }),

      // ---- the crossing: render A becomes a MATERIAL MAP -------------------------
      node("screenMat", "materialUnlit", [-580, -184], { color: [1, 1, 1, 1] }, { label: "material_screen" }),

      // ---- scene B: the stage ----------------------------------------------------
      node("screenGrid", "pointGrid", [-580, 56], { cols: 48, rows: 27, count: 1296, sizeX: 3.2, sizeY: 1.8 }, { label: "grid_screen" }),
      node("screen", "geometry", [-280, 40], { mode: "surface", material: "material_screen" }, { label: "geometry_screen" }),
      node("floorPts", "pointGrid", [-620, 256], { cols: 12, rows: 12, count: 144, sizeX: 4, sizeY: 3 }, { label: "grid_floor" }),
      node("floorKernel", "pointKernel", [-410, 256], {
        capacity: 144,
        attributes: '[{"name":"position","type":"vec3f","semantic":"position","default":[0,0,0]}]',
        kernel: "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  /* the xy plane lies down: y becomes depth, the floor sits under the screen */\n  q.position = vec3f(p.position.x, -1.15, p.position.y - 0.6);\n  return q;\n}",
      }, { label: "kernel_floor" }),
      node("matFloor", "materialPhong", [-410, 466], {
        color: [0.25, 0.28, 0.38, 1], specular: [0.6, 0.7, 1, 1], shininess: 24, roughness: 0.7,
      }, { label: "material_floor" }),
      node("floor", "geometry", [-200, 256], {
        mode: "instances", shape: "box", scale: 0.09, material: "material_floor",
      }, { label: "geometry_floor" }),
      node("orbBx", "lfo", [0, -144], { shape: "sine", frequency: 0.045, amplitude: 1.4, offset: 0, phase: 0 }, { label: "lfo_orbbx" }),
      node("breathe", "lfo", [0, -328], { shape: "sine", frequency: 0.2, amplitude: 0.5, offset: 1.1, phase: 0 }, { label: "lfo_breathe" }),
      node("camB", "camera", [0, 56], { lookAt: [0, -0.1, 0], fov: 55 }, {
        label: "camera_b",
        parameters: {
          "eye.x": drivenSlot("lfo_orbbx", 0.8),
          "eye.y": 0.35,
          "eye.z": 3.1,
        },
      }),
      node("keyB", "light", [0, 256], {
        kind: "directional", color: [1, 0.9, 0.7, 1], direction: [-0.4, -0.75, -0.4],
      }, {
        label: "light_keyb",
        parameters: { intensity: drivenSlot("lfo_breathe", 1.1) },
      }),
      node("shotB", "render", [280, 56], {
        scenes: "geometry_screen geometry_floor", camera: "camera_b", lights: "light_keyb",
        ambientColor: [0.5, 0.55, 0.8, 1], ambientIntensity: 0.25,
        background: [0.03, 0.04, 0.08, 1],
      }, { label: "render_shotb" }),
      node("out", "output", [560, 56], {}, { label: "output1" }),
    ],
    [
      edge("e-ringa-geoa", ["ringA", "out"], ["geoA", "points"]),
      // THE WIRE (V372): scene A's picture, into a material's map slot, one edge.
      edge("e-shota-screenmat", ["shotA", "out"], ["screenMat", "albedo"]),
      edge("e-screengrid-screen", ["screenGrid", "out"], ["screen", "points"]),
      edge("e-floorpts-kernel", ["floorPts", "out"], ["floorKernel", "in"]),
      edge("e-kernel-floor", ["floorKernel", "out"], ["floor", "points"]),
      edge("e-shotb-out", ["shotB", "out"], ["out", "input"]),
    ],
  ),
);
