import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import type { CompiledNodeDescription } from "../../domain/types/node-definition.ts";
import type { CameraPayload, LightPayload } from "../../domain/types/scene.ts";
import type { BufferBindingDescriptor, DispatchPassDescriptor } from "../../runtime/backend/plan.ts";
import {
  LIGHT_LIVE_BINDING,
  LIGHT_RECORDS_BINDING,
  LIGHT_SOURCE_PREFIX,
  LIGHT_TABLE_BINDING,
  LIGHT_WORKGROUP,
  lightGatherSourceUniform,
  lightGatherWgsl,
  lightGridWgsl,
  lightResolveWgsl,
} from "../shaders/scene-lights.wgsl.ts";
import type { PointAttributeType } from "../../points/attributes.ts";
import type { NodeCompileInputs } from "./compile-context.ts";
import { packedGroups } from "./instance-records.ts";
import { MAX_LIGHT_SLOTS, MAX_POINT_LIGHTS, lightGridDimensions, lightRecordStorage, lightTableStorage } from "./light-records.ts";
import { readNumber, readVector } from "./parameter-readers.ts";
import { resolveColorMap, resolveScalarMap } from "./points.ts";

/**
 * T1589b — LIGHTS FROM A POINTSET, the two nodes' halves
 * (docs/lights-from-pointset-design-2026-10-06.md, sections 3 and 4).
 *
 * `compileLightPoints` is the LIGHT in Points mode: it resolves its pointset into records,
 * once a frame, and publishes them. `lightTablePlan` is the RENDER: it gathers the records
 * of every such Light it lists into one table and builds the grid over its own view. Both
 * live here so that `scene.ts` holds a call to each and nothing else of the path.
 */

/** The parameters of a Light that take a per-point attribute in Map mode, in Points mode. */
export const LIGHT_POINT_MAPS = ["color", "intensity", "position", "range", "direction", "orient", "cone"] as const;

/** A Light's Type as its rows carry it (`scene-lights.wgsl.ts`, the record's kind). */
export const lightKindNumber = (kind: unknown): number => (kind === "spot" ? 2 : kind === "point" ? 1 : 0);

const refusal = (nodeId: string, code: string, message: string, suggestion: string): CompiledNodeDescription => ({
  passes: [],
  diagnostics: [{ severity: "error", code, message: `Node "${nodeId}": ${message}`, nodeId, suggestion }],
});

/**
 * A map this Light cannot honour, refused BY NAME (§V288): a parameter that takes no map, or
 * any map at all on a Light in Single mode, which has no points to read one from. A map that
 * was quietly dropped would leave the retained value lighting the scene and look authored.
 */
export function lightMapRefusal(
  nodeId: string,
  parameterMaps: NodeCompileInputs["parameterMaps"],
  pointsMode: boolean,
): CompiledNodeDescription | undefined {
  const mapped = Object.keys(parameterMaps).sort();
  if (mapped.length === 0) return undefined;
  const takes = (LIGHT_POINT_MAPS as readonly string[]).map((key) => `"${key}"`).join(", ");
  if (!pointsMode) {
    return {
      passes: [],
      diagnostics: mapped.map((key) => ({
        severity: "error" as const,
        code: "node.parameter.map",
        message: `Node "${nodeId}": ${key} is in map mode, but this Light is one light (Mode: Single) and has no points to read a per-point value from.`,
        nodeId,
        suggestion: `Set Mode to Points and wire a pointset to Points (a Light then maps ${takes}), or switch ${key} back to Constant.`,
      })),
    };
  }
  const unhonoured = mapped.filter((key) => !(LIGHT_POINT_MAPS as readonly string[]).includes(key));
  if (unhonoured.length === 0) return undefined;
  return {
    passes: [],
    diagnostics: unhonoured.map((key) => ({
      severity: "error" as const,
      code: "node.parameter.map",
      message: `Node "${nodeId}": ${key} is in map mode, but a Light in Points mode maps only ${takes}.`,
      nodeId,
      suggestion: "Switch it back to Constant, or drive it through the value graph instead.",
    })),
  };
}

/**
 * T1589b slice 2 — A SPOT IN SINGLE MODE HAS NO CONE YET, AND SAYS SO.
 *
 * A spot is a kind of ROW of a Render's light table. A Light in Single mode is not a row
 * yet: it is a block of the lit shader, and that block takes no cone (it goes when named
 * Lights become rows, T1623b slice 3, and this warning goes with it). Until then such a
 * Light shines as a point light from its Position.
 *
 * A WARNING, never a refusal. Type is a value: the plan and every text are a point light's
 * whichever of the two it says, so nothing here is decided by it. It is in the compile's
 * diagnostics, which the Problems pane and the headless server both read, by the node's
 * name. The compile runs on every revision, so an authored Type: Spot is said from the edit
 * that makes it; a Type DRIVEN to Spot between revisions is not, because a values-only frame
 * keeps no node's diagnostics (`frame-compile.ts`).
 */
export function lightSpotUnbuilt(nodeId: string): RuntimeDiagnostic {
  return {
    severity: "warning",
    code: "node.scene.lightSpot",
    message: `Node "${nodeId}": Type is Spot, and a Light in Mode: Single has no cone yet. It shines as a Point light from Position, in every direction: Cone, Cone Softness and Direction are not read.`,
    nodeId,
    suggestion:
      "Set Mode to Points and wire a pointset to Points (one point is one spot), or set Type to Point. A Light in Single mode takes its cone when named Lights become rows of the Render's light table.",
  };
}

/**
 * The Light in POINTS mode: one light at every point of the Points input.
 *
 * `light` is the node's own values as the Single path reads them (colour in linear space,
 * intensity, range, falloff): the resolve pass takes them as uniforms, so a breathing
 * Intensity or a driven Range is a write, never a rebuild (§V5). What is structural is which
 * attributes are mapped, and whether the pointset is counted.
 */
export function compileLightPoints(request: {
  readonly nodeId: string;
  readonly points: NodeCompileInputs["inputs"][string] | undefined;
  readonly parameters: NodeCompileInputs["parameters"];
  readonly parameterMaps: NodeCompileInputs["parameterMaps"];
  readonly light: LightPayload["light"];
}): CompiledNodeDescription {
  const { nodeId, parameters, parameterMaps, light } = request;
  const pointset = request.points?.pointset;
  if (pointset === undefined) {
    return refusal(
      nodeId,
      "node.scene.lightPoints",
      "Mode: Points repeats this light at every point of the Points input, and no pointset arrives on it.",
      "Wire a pointset to Points (a Point Grid, a Point Kernel, a Resample along a curve), or set Mode back to Single.",
    );
  }
  const position = resolveColorMap(nodeId, parameterMaps["position"], pointset, "points", "position", "vec3f");
  if ("refusal" in position) return position.refusal;
  const place = position.map ?? pointset.pairs["position"];
  if (place === undefined || (position.map === undefined && place.type !== "vec3f")) {
    return refusal(
      nodeId,
      "node.scene.lightPoints",
      "the Points input carries no vec3f `position`, and a light stands at its point's position.",
      "Keep position through any kernel before the Light, or map Position to the vec3f attribute that holds each light's place.",
    );
  }
  const color = resolveColorMap(nodeId, parameterMaps["color"], pointset, "points", "color");
  if ("refusal" in color) return color.refusal;
  const intensity = resolveScalarMap(nodeId, parameterMaps["intensity"], pointset, "points", "intensity");
  if ("refusal" in intensity) return intensity.refusal;
  const range = resolveScalarMap(nodeId, parameterMaps["range"], pointset, "points", "range");
  if ("refusal" in range) return range.refusal;
  /* The way each light travels: a vec3f in place of Direction, a quaternion in place of Orient. */
  const direction = resolveColorMap(nodeId, parameterMaps["direction"], pointset, "points", "direction", "vec3f");
  if ("refusal" in direction) return direction.refusal;
  const orient = resolveColorMap(nodeId, parameterMaps["orient"], pointset, "points", "orient");
  if ("refusal" in orient) return orient.refusal;
  const cone = resolveScalarMap(nodeId, parameterMaps["cone"], pointset, "points", "cone");
  if ("refusal" in cone) return cone.refusal;

  const records = lightRecordStorage(nodeId, pointset.capacity);
  const sources = packedGroups();
  /* `resolveScalarMap` hands back an f32 or a float vector with its channel, and nothing else. */
  const scalar = (map: NonNullable<typeof intensity.map>) => ({
    ...sources.read(map, map.type as PointAttributeType),
    ...(map.channel === undefined ? {} : { channel: map.channel }),
  });
  const placeRead = sources.read(place, "vec3f");
  const colorRead = color.map === undefined ? undefined : sources.read(color.map, "vec4f");
  const intensityRead = intensity.map === undefined ? undefined : scalar(intensity.map);
  const rangeRead = range.map === undefined ? undefined : scalar(range.map);
  const directionRead = direction.map === undefined ? undefined : sources.read(direction.map, "vec3f");
  const orientRead = orient.map === undefined ? undefined : sources.read(orient.map, "vec4f");
  const coneRead = cone.map === undefined ? undefined : scalar(cone.map);
  const turn = readVector(parameters as never, "orient", [0, 0, 0, 1]);
  const pass: DispatchPassDescriptor = {
    kind: "dispatch",
    id: `${nodeId}:lights:resolve`,
    shader: lightResolveWgsl({
      groups: sources.count,
      place: placeRead,
      ...(colorRead === undefined ? {} : { color: colorRead }),
      ...(intensityRead === undefined ? {} : { intensity: intensityRead }),
      ...(rangeRead === undefined ? {} : { range: rangeRead }),
      ...(directionRead === undefined ? {} : { direction: directionRead }),
      ...(orientRead === undefined ? {} : { orient: orientRead }),
      ...(coneRead === undefined ? {} : { cone: coneRead }),
      ...(pointset.count === undefined ? {} : { counted: true }),
    }),
    entryPoint: "main",
    workgroups: [Math.ceil(pointset.capacity / LIGHT_WORKGROUP), 1, 1],
    buffers: [
      { binding: LIGHT_RECORDS_BINDING, resourceId: records.resourceId },
      ...(pointset.count === undefined ? [] : [{ binding: LIGHT_LIVE_BINDING, resourceId: pointset.count.buffer }]),
      ...sources.bindings(LIGHT_SOURCE_PREFIX),
    ],
    uniforms: {
      color: [light.color[0], light.color[1], light.color[2], light.intensity],
      /* The Type is a value of the row (T1623b): a set of suns, of lamps and of spots are one text. */
      shape: [Math.max(0, readNumber(parameters, "range", 0)), light.falloff === "inverseSquare" ? 1 : 0, lightKindNumber(parameters["kind"]), 0],
      aim: [light.direction[0], light.direction[1], light.direction[2], 0],
      orient: [turn[0] ?? 0, turn[1] ?? 0, turn[2] ?? 0, turn[3] ?? 1],
      cone: [readNumber(parameters, "cone", 60), readNumber(parameters, "coneSoftness", 0.4), 0, 0],
      count: pointset.capacity,
    },
    uniformBinding: "params",
    nodeId,
  };
  const payload: LightPayload = {
    kind: "light",
    /* A pointset's lights cast no shadow (the casting few are Lights in Single mode, T1622b). */
    light: { ...light, shadows: false },
    points: { records: records.resourceId, capacity: pointset.capacity },
  };
  return { passes: [pass], scratch: [records.scratch], scene: { out: payload } } as CompiledNodeDescription;
}

/* ------------------------------------------------------------------------------------ */
/* The Render's half                                                                     */
/* ------------------------------------------------------------------------------------ */

/** One pointset Light a Render lists: the node, for a sentence that names it, its records, and its place in the Render's Lights. */
export interface PointLightSource {
  readonly nodeId: string;
  readonly points: NonNullable<LightPayload["points"]>;
  /** Which Light of the Render's Lights this is, counted from 0 in list order: every row of its set carries it. */
  readonly number: number;
}

export interface LightTablePlan {
  /** The gather, then the grid: emitted before anything draws the colour (T1604b). */
  readonly passes: DispatchPassDescriptor[];
  readonly scratch: { readonly kind: "buffer"; readonly key: string; readonly stride: number; readonly capacity: number };
  /** The one buffer a lit draw binds for the lights. */
  readonly buffer: BufferBindingDescriptor;
  /** The rows a lit draw carries: the grid, the lens and the depth row. */
  readonly uniforms: Readonly<Record<string, number[]>>;
}

/**
 * The Render's light table and its two passes, or the refusal that names what does not fit.
 *
 * `surface` is the size in pixels of what the lit draws render into (twice the output under
 * SSAA): a fragment finds its tile from its own pixel. The grid itself is a share of the
 * picture and does not know the size.
 */
export function lightTablePlan(request: {
  readonly nodeId: string;
  readonly sources: ReadonlyArray<PointLightSource>;
  readonly resolution: readonly [number, number];
  readonly surface: readonly [number, number];
  readonly camera: CameraPayload;
  readonly viewProjection: ArrayLike<number>;
}): LightTablePlan | { readonly diagnostics: RuntimeDiagnostic[] } {
  const { nodeId, sources, camera } = request;
  const refuse = (code: string, message: string, suggestion: string): { diagnostics: RuntimeDiagnostic[] } => ({
    diagnostics: [{ severity: "error", code, message: `Node "${nodeId}": ${message}`, nodeId, suggestion }],
  });
  if (sources.length > MAX_POINT_LIGHTS) {
    return refuse(
      "node.scene.lightSources",
      `Lights names ${sources.length} Lights in Points mode (${sources.map((source) => `"${source.nodeId}"`).join(", ")}), and a Render gathers at most ${MAX_POINT_LIGHTS}.`,
      "Feed several sets of lights from one pointset and one Light, or list fewer.",
    );
  }
  const slots = sources.reduce((total, source) => total + source.points.capacity, 0);
  if (slots > MAX_LIGHT_SLOTS) {
    return refuse(
      "node.scene.lightCapacity",
      `the Lights in Points mode hold ${slots} points of capacity together (${sources.map((source) => `"${source.nodeId}" ${source.points.capacity}`).join(", ")}), and a Render lights from at most ${MAX_LIGHT_SLOTS}. Every slot counts, lit or not.`,
      "Lower the capacity of the pointsets that feed them to the lights they need.",
    );
  }
  const grid = lightGridDimensions(request.resolution);
  const table = lightTableStorage(nodeId, slots, grid);

  /* Where each Light's rows go in the table, how many it has, and which Light it is: values
     of the gather, one row a Light, so its text follows only how many Lights there are. */
  let base = 0;
  const gathered = sources.map((source, index): [string, number[]] => {
    const row = [base, source.points.capacity, source.number, 0];
    base += source.points.capacity;
    return [lightGatherSourceUniform(index), row];
  });
  const tableBuffer: BufferBindingDescriptor = { binding: LIGHT_TABLE_BINDING, resourceId: table.resourceId };

  /* The camera, as the grid needs it. The depth of a place is read off the view-projection the
     draws use: its w row for a perspective camera, its z row scaled back to distance for an
     orthographic one. The half-extents are the ambient occlusion resolve's own. */
  const matrix = request.viewProjection;
  const row = (index: number): number[] => [0, 1, 2, 3].map((column) => matrix[column * 4 + index] ?? 0);
  const near = Math.max(camera.near, 1e-6);
  const far = Math.max(camera.far, near * 1.001);
  const depthRow = camera.ortho
    ? row(2).map((value, index) => value * (camera.far - camera.near) + (index === 3 ? camera.near : 0))
    : row(3);
  const aspect = request.resolution[0] / Math.max(request.resolution[1], 1);
  const tanHalf = Math.tan((camera.fovDeg * Math.PI) / 360);
  const orthoHalf = Math.max(camera.orthoHeight, 1e-6) / 2;
  const halfExtents = camera.ortho ? [orthoHalf * aspect, orthoHalf] : [tanHalf * aspect, tanHalf];
  const gridRow = [grid[0], grid[1], grid[2], camera.ortho ? 1 : 0];

  const gather: DispatchPassDescriptor = {
    kind: "dispatch",
    id: `${nodeId}:lights:gather`,
    shader: lightGatherWgsl({ sources: sources.length }),
    entryPoint: "main",
    workgroups: [Math.ceil(slots / LIGHT_WORKGROUP), 1, 1],
    buffers: [tableBuffer, ...sources.map((source, index) => ({ binding: `${LIGHT_SOURCE_PREFIX}${index}`, resourceId: source.points.records }))],
    /* The table's header is written from these three: every later loop's bounds (T1623b). */
    uniforms: { ...Object.fromEntries(gathered), count: slots, words: table.words, cells: table.cellsAt },
    uniformBinding: "params",
    nodeId,
  };
  const build: DispatchPassDescriptor = {
    kind: "dispatch",
    id: `${nodeId}:lights:grid`,
    shader: lightGridWgsl(),
    entryPoint: "main",
    workgroups: [Math.ceil(table.cells / LIGHT_WORKGROUP), 1, 1],
    buffers: [tableBuffer],
    uniforms: {
      viewProjection: Array.from(matrix),
      depthRow,
      lens: [halfExtents[0] as number, halfExtents[1] as number, near, far],
      grid: gridRow,
    },
    uniformBinding: "params",
    nodeId,
  };
  return {
    passes: [gather, build],
    scratch: table.scratch,
    buffer: tableBuffer,
    uniforms: {
      lightGrid: gridRow,
      lightLens: [request.surface[0], request.surface[1], near, far],
      lightDepth: depthRow,
    },
  };
}
