import type { NodeDefinition, CompiledNodeDescription } from "../../domain/types/node-definition.ts";
import type { ParameterValue, VectorParameter } from "../../domain/types/parameters.ts";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { EXTEND_OPTIONS, readEnumIndex, readNumber, readVector } from "./parameter-readers.ts";
import { CORNER_PIN_FRAGMENT_WGSL } from "../shaders/corner-pin.wgsl.ts";

/**
 * Corner Pin — the 2D projection-mapping node (T1491b). TouchDesigner's Corner Pin TOP.
 *
 * The performance stack is input → scene(s) → FX → MAPPING → output, and this is the
 * mapping: the picture is pinned by its four corners onto a quad of the output, the way a
 * projector's image is pinned onto the face of a wall that the projector does not look at
 * square-on. Extract picks which quad OF THE INPUT is pinned (the whole input by default),
 * so one source can feed several pinned surfaces, each showing its own part.
 *
 * ## The warp is a HOMOGRAPHY, not two triangles
 *
 * A flat surface seen in perspective is a projective map of the plane, so the only warp that
 * keeps straight lines straight AND spaces a grid the way the eye expects is the 3×3
 * homography through the four corners. Splitting the quad into two triangles and mapping
 * each affinely bends every line that crosses the diagonal — the classic cheap corner pin's
 * visible kink. Here the per-pixel map is exact: the output point goes through the inverse
 * of the pin homography to the pinned surface's own unit square, and from there through the
 * extract homography to the input. Both matrices are solved HERE, on the CPU, per compile
 * (headless, no clock — §V11/§V44); the shader does two 3×3 products and two divisions.
 *
 * ## Coordinates
 *
 * Every corner is normalised, (0, 0) the bottom-left and (1, 1) the top-right, y UP as
 * TouchDesigner and Crop count it. Pins are in OUTPUT coordinates, extract corners in INPUT
 * coordinates. The defaults are the corners themselves, so a fresh node is the identity.
 *
 * ## A degenerate quad renders nothing, and says why
 *
 * A projected rectangle is always a CONVEX quad. Three collinear corners (zero area), a
 * bow-tie (two corners swapped) or a dent (one corner pushed inside the others) has no
 * homography that fills it, and solving one anyway divides by zero somewhere inside the
 * picture. So a quad that is not strictly convex is refused: the output is transparent and
 * the node reports which quad and why — never NaNs, which would poison everything below.
 * Either winding is fine: a mirrored pin (rear projection) is a legitimate map.
 */

export type Point2 = readonly [number, number];
/** Bottom-left, bottom-right, top-right, top-left — TD's order, and the unit square's. */
export type Quad = readonly [Point2, Point2, Point2, Point2];
/** Row-major 3×3. */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

export const IDENTITY_QUAD: Quad = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

/**
 * Below this the corner's turn is treated as none. It is a guard against an exact zero,
 * not a quality bar: a quad one texel wide on a 4096-pixel output still turns by ~2e-4.
 */
const TURN_EPSILON = 1e-7;

/**
 * Why a quad cannot be pinned, or null when it can. Strictly convex, either winding: all
 * four corner turns (cross products of consecutive edges) share one sign and none is zero.
 * Four turns of one sign are a single convex loop — the exterior angles of a quad that
 * wound twice would sum past 4π, which four angles each under π cannot.
 */
export function quadDegeneracy(quad: Quad): string | null {
  if (quad.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return "a corner is not a finite number";
  const turns = quad.map((corner, index) => {
    const next = quad[(index + 1) % 4] as Point2;
    const after = quad[(index + 2) % 4] as Point2;
    return (next[0] - corner[0]) * (after[1] - next[1]) - (next[1] - corner[1]) * (after[0] - next[0]);
  });
  if (turns.some((turn) => Math.abs(turn) <= TURN_EPSILON)) return "three corners are in a line (zero area)";
  const positive = turns.filter((turn) => turn > 0).length;
  if (positive !== 0 && positive !== 4) return "it is self-intersecting or concave (corners out of order)";
  return null;
}

/**
 * The homography taking the unit square's corners (0,0), (1,0), (1,1), (0,1) to `quad`'s
 * corners in order — Heckbert's closed form for the square-to-quadrilateral case
 * ("Fundamentals of Texture Mapping and Image Warping", 1989). For a parallelogram the
 * perspective terms g and h come out exactly zero and this is the affine map, which is what
 * makes the identity node exact.
 * The caller has checked `quadDegeneracy`; the denominator is non-zero for a convex quad.
 */
export function squareToQuad(quad: Quad): Mat3 {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = quad;
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / den;
  const h = (dx1 * dy3 - dx3 * dy1) / den;
  return unsigned([x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1]);
}

/** -0 as 0: the same map, and a plan that compares and serialises as the one it is. */
const unsigned = (m: Mat3): Mat3 => m.map((entry) => entry + 0) as unknown as Mat3;

/** The inverse by the adjugate, or null when the determinant is zero. */
export function invertMat3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (det === 0 || !Number.isFinite(det)) return null;
  return unsigned([
    A / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    C / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ]);
}

/** `m` applied to a point, with the projective division. */
export function applyHomography(m: Mat3, [x, y]: Point2): Point2 {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

/**
 * The output → unit-square map for a pin quad, signed so the homogeneous w is POSITIVE
 * inside the quad. A homography is only defined up to scale, and the sign is the one part of
 * that scale the shader can see: past the pinned plane's horizon w goes negative, and the
 * extend modes (which read outside the quad) must know where the surface stops existing.
 */
export function outputToSquare(pins: Quad): Mat3 | null {
  const inverse = invertMat3(squareToQuad(pins));
  if (inverse === null) return null;
  const cx = (pins[0][0] + pins[1][0] + pins[2][0] + pins[3][0]) / 4;
  const cy = (pins[0][1] + pins[1][1] + pins[2][1] + pins[3][1]) / 4;
  const w = inverse[6] * cx + inverse[7] * cy + inverse[8];
  return w > 0 ? inverse : unsigned(inverse.map((entry) => -entry) as unknown as Mat3);
}

const IDENTITY_MAT3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const PIN_KEYS = ["pinbl", "pinbr", "pintr", "pintl"] as const;
const EXTRACT_KEYS = ["extractbl", "extractbr", "extracttr", "extracttl"] as const;
const CORNER_LABELS = ["Bottom Left", "Bottom Right", "Top Right", "Top Left"] as const;

function readQuad(parameters: Readonly<Record<string, ParameterValue>>, keys: readonly string[]): Quad {
  return keys.map((key, index) => readVector(parameters, key, IDENTITY_QUAD[index] as Point2)) as unknown as Quad;
}

/**
 * The two quads as the compile reads them from resolved values — exported so a reader that
 * maps a picture through this node (the perform window's edit-mapping lens, §T1538b) pins
 * exactly the quads the pass was built from.
 */
export function cornerPinQuads(parameters: Readonly<Record<string, ParameterValue>>): { readonly pins: Quad; readonly extract: Quad } {
  return { pins: readQuad(parameters, PIN_KEYS), extract: readQuad(parameters, EXTRACT_KEYS) };
}

/** Row `index` of a 3×3 as a vec4f uniform (the fourth lane is padding). */
const row = (m: Mat3, index: number): number[] => [m[index * 3] ?? 0, m[index * 3 + 1] ?? 0, m[index * 3 + 2] ?? 0, 0];

const ZERO_EXTEND = "zero";

function cornerParameters(
  keys: readonly string[],
  group: string,
  what: string,
  extra: Partial<VectorParameter>,
): Record<string, VectorParameter> {
  return Object.fromEntries(
    keys.map((key, index) => [
      key,
      {
        type: "vector",
        size: 2,
        label: `${group} ${CORNER_LABELS[index] ?? ""}`,
        default: IDENTITY_QUAD[index] as Point2,
        group,
        description: `${what} ${(CORNER_LABELS[index] ?? "").toLowerCase()} corner, 0..1 with (0, 0) at the bottom left.`,
        ...extra,
      } satisfies VectorParameter,
    ]),
  );
}

export const cornerPinNode: NodeDefinition = {
  type: "cornerPin",
  version: 1,
  title: "Corner Pin",
  category: "filter",
  description:
    "Pins the image by its four corners onto any quad of the output, in true perspective: the 2D projection-mapping warp. Extract picks which quad of the input is pinned. Outside the quad the output is Transparent, or the pinned surface continued by Hold Edge, Repeat or Mirror.",
  tags: ["mapping", "projection", "keystone", "warp", "corner pin", "perspective", "homography"],
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    // Soft past both ends: a pin beyond the frame is overscan, which mapping a surface
    // larger than the projector's throw needs. `handle` puts each pin on the preview (T1491b).
    ...cornerParameters(PIN_KEYS, "Pin", "Where the output puts the pinned image's", {
      min: -1,
      max: 2,
      range: "soft",
      handle: "picture",
    }),
    ...cornerParameters(EXTRACT_KEYS, "Extract", "The input's", { min: 0, max: 1, range: "soft" }),
    extend: {
      type: "enum",
      label: "Outside",
      default: ZERO_EXTEND,
      options: [...EXTEND_OPTIONS],
      description:
        "What the output shows outside the pinned quad: nothing (Transparent), or the pinned surface continued by holding its edge, repeating or mirroring. Past the surface's horizon it is always transparent.",
    },
    feather: {
      type: "number",
      label: "Edge Feather",
      default: 0,
      min: 0,
      max: 0.5,
      range: "bounded",
      description:
        "Softens the quad's edges, as a fraction of the pinned surface's width and height (so it foreshortens with it). 0 is a hard edge.",
      inactiveWhen: (values) =>
        values["extend"] !== undefined && values["extend"] !== ZERO_EXTEND
          ? "Feather fades to transparent, so it applies only when Outside is Transparent."
          : null,
    },
  },
  resolutionPolicy: { kind: "inherit", input: "input" },
  formatPolicy: { kind: "inherit", input: "input" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputs, parameters } = readCompileInputs(context);
    const target = outputs["out"];
    const source = inputs["input"];
    if (target === undefined || source === undefined) {
      const what = target === undefined ? 'output port "out"' : 'input port "input"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }
    const { pins, extract } = cornerPinQuads(parameters);
    const diagnostics: RuntimeDiagnostic[] = [];
    for (const [quad, name, code] of [
      [pins, "Pin", "cornerPin.pin.degenerate"],
      [extract, "Extract", "cornerPin.extract.degenerate"],
    ] as const) {
      const reason = quadDegeneracy(quad);
      if (reason === null) continue;
      diagnostics.push({
        severity: "warning",
        code,
        message: `Corner Pin's ${name} quad cannot be pinned: ${reason}. The output is transparent.`,
        nodeId,
        suggestion: `Move the ${name} corners so they go bottom left, bottom right, top right, top left around a convex shape.`,
      });
    }
    // A refused quad still renders — transparent, through the same pass — so the output is
    // a defined picture and the plan's shape does not depend on where a corner is dragged.
    const toSquare = diagnostics.length === 0 ? outputToSquare(pins) : null;
    const valid = toSquare !== null;
    const inverse = toSquare ?? IDENTITY_MAT3;
    const forward = valid ? squareToQuad(extract) : IDENTITY_MAT3;
    const pass: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:cornerPin`,
      shader: CORNER_PIN_FRAGMENT_WGSL,
      target,
      textures: [{ binding: "inputTexture", resourceId: source.resource }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      uniforms: {
        pin0: row(inverse, 0),
        pin1: row(inverse, 1),
        pin2: row(inverse, 2),
        ext0: row(forward, 0),
        ext1: row(forward, 1),
        ext2: row(forward, 2),
        extend: readEnumIndex(parameters, "extend", EXTEND_OPTIONS, ZERO_EXTEND),
        feather: readNumber(parameters, "feather", 0),
        valid: valid ? 1 : 0,
      },
      nodeId,
      label: "Corner Pin",
    };
    return diagnostics.length === 0 ? { passes: [pass] } : { passes: [pass], diagnostics };
  },
};
