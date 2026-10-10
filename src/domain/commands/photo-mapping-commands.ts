import { z } from "zod";
import { supportsPhotoDepthSize } from "../media/preparation-sizes.ts";
import { photoDepthRecipeSchema, depthRecipeParameters, type PhotoDepthRecipe } from "../media/photo-depth-recipe.ts";
import { imageFramingSchema, imageFramingParameters, type ImageFraming } from "../media/image-framing.ts";
import { depthRangeSchema, type DepthRangeSettings } from "../media/depth-range.ts";
import { kindOf } from "../graph/node-kinds.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { Revision } from "../types/ids.ts";
import type { GraphPatchOperation, GraphPatchResult, TempId } from "../types/patch.ts";
import type { StoredParameter } from "../types/parameters.ts";
import { applyGraphPatch } from "./apply-patch.ts";
import type { LoomBus } from "./bus.ts";

export interface PhotoMappingCreateInput {
  photo: string;
  depth?: string;
  nativeDepth?: string;
  depthRecipe?: PhotoDepthRecipe;
  mask?: string;
  width: number;
  height: number;
  shader: string;
  effect?: number;
  inputSide?: number;
  previz?: boolean;
  previewPhoto?: string;
  previewFit?: "fit" | "fill" | "stretch";
  previewFraming?: ImageFraming;
  previewOpacity?: number;
  depthRange?: DepthRangeSettings;
  patternShader?: string;
  testPattern?: boolean;
  video?: string;
}

declare module "../types/commands.ts" {
  interface CommandMap {
    "photoMapping.create": { input: PhotoMappingCreateInput; output: GraphPatchResult };
  }
}

const rejection = (_input: unknown, diagnostics: RuntimeDiagnostic[], revision: Revision): GraphPatchResult => ({
  status: "rejected", revision, appliedOperations: 0, diagnostics, createdIds: {},
});

/** Builds a regular editable projection network as one atomic, undoable graph patch. */
export function registerPhotoMappingCommands(bus: LoomBus, options: { refresh?: boolean } = {}): void {
  const exists = bus.hasCommand("photoMapping.create");
  if (exists && !options.refresh) return;
  const register = exists ? bus.replaceCommand.bind(bus) : bus.registerCommand.bind(bus);
  register({
    name: "photoMapping.create",
    inSession: "definition",
    description: "Create an editable photo-mapping network from a photo, saved float32 depth and an optional mask asset.",
    inputSchema: z.object({
      photo: z.string().trim().min(1), depth: z.string().trim().min(1).optional(), mask: z.string().trim().min(1).optional(),
      nativeDepth: z.string().trim().min(1).optional(), depthRecipe: photoDepthRecipeSchema.optional(),
      width: z.number().int().positive(), height: z.number().int().positive(),
      shader: z.string().trim().min(1), effect: z.number().finite().optional(),
      inputSide: z.number().int().positive().optional(),
      previz: z.boolean().optional(),
      previewPhoto: z.string().trim().min(1).optional(),
      previewFit: z.enum(["fit", "fill", "stretch"]).optional(),
      previewFraming: imageFramingSchema.optional(),
      previewOpacity: z.number().finite().min(0).max(1).optional(),
      depthRange: depthRangeSchema.optional(), patternShader: z.string().trim().min(1).optional(),
      testPattern: z.boolean().optional(), video: z.string().trim().min(1).optional(),
    }).strict().refine(input => input.inputSide === undefined ||
      (input.depthRecipe?.version === 2 ? input.inputSide === input.depthRecipe.inputSide : supportsPhotoDepthSize(input.inputSide)), {
      message: "Unsupported depth input size.", path: ["inputSide"],
    }).refine(input => input.previewPhoto === undefined || input.previz !== false, {
      message: "A preview photo requires reference-photo previz.", path: ["previewPhoto"],
    }).refine(input => input.previewFraming === undefined || (input.previewPhoto !== undefined && input.previz !== false), {
      message: "Preview framing requires a preview photo with reference-photo previz.", path: ["previewFraming"],
    }).refine(input => input.depth !== undefined || (input.nativeDepth === undefined && input.depthRecipe === undefined), {
      message: "Native depth and depth recipes require an assigned depth map.", path: ["depth"],
    }).refine(input => input.testPattern !== true || input.patternShader !== undefined, {
      message: "Test pattern requires its calibration shader.", path: ["patternShader"],
    }).refine(input => input.depthRecipe?.refinement == null || input.nativeDepth !== undefined, {
      message: "Refined depth requires its saved native parent.", path: ["nativeDepth"],
    }).refine(input => input.depthRecipe === undefined || input.inputSide === undefined || input.depthRecipe.inputSide === input.inputSide, {
      message: "Depth recipe and input size must agree.", path: ["inputSide"],
    }),
    handler: (input, context) => {
      // Source identity and preparation metadata keep the original photograph dimensions.
      // Only the graph's working textures are fitted to the project's resolution limit.
      const maxResolution = context.store.getSettings().limits.maxResolution;
      const scale = Math.min(1, maxResolution / Math.max(input.width, input.height));
      const width = Math.max(1, Math.round(input.width * scale));
      const height = Math.max(1, Math.round(input.height * scale));

      const previz = input.previz ?? true;
      const pattern = input.patternShader !== undefined;
      const projectorShift = pattern ? 1 : 0;
      const video = input.video !== undefined || input.effect === 9;
      const specs: { ref: TempId; type: string; role: string; column: number; row: number; parameters: Record<string, StoredParameter> }[] = [
        { ref: "$photo", type: "movieFileIn", role: "surface", column: 0, row: 0, parameters: { file: input.photo } },
        { ref: "$depth", type: "floatMapIn", role: "depth", column: 0, row: 1,
          parameters: { file: input.depth ?? "", photo: input.photo, interpretation: "depth", inputSide: String(input.inputSide ?? 518),
            ...(input.depth === undefined ? { emptySource: "constant", emptyValue: 0.5 } : {}),
            ...(input.depthRecipe === undefined ? {} : depthRecipeParameters(input.depthRecipe)),
            ...(input.nativeDepth === undefined ? {} : { nativeMap: input.nativeDepth }) } },
        { ref: "$mask", type: "floatMapIn", role: "mask", column: 0, row: 2,
          parameters: { file: input.mask ?? "", photo: input.photo, interpretation: "mask", inputSide: "518",
            ...(input.mask === undefined ? { emptySource: "constant", emptyValue: 1 } : {}) } },
        { ref: "$effect", type: "customWgslMulti", role: "relief", column: 1, row: 0,
          parameters: { source: input.shader, mode: input.effect ?? 0,
            ...(input.depthRange === undefined ? {} : { depthLow: input.depthRange.low, depthHigh: input.depthRange.high }) } },
        { ref: "$coverage", type: "mask", role: "surface", column: 2 + projectorShift, row: 0, parameters: { channel: "red", apply: "colour" } },
        { ref: "$grid", type: "gridWarp", role: "surface", column: 3 + projectorShift, row: 0, parameters: {} },
        { ref: "$corner", type: "cornerPin", role: "surface", column: 4 + projectorShift, row: 0, parameters: {} },
        { ref: "$window", type: "window", role: "projector", column: 5 + projectorShift, row: 0, parameters: {} },
      ];
      if (pattern) specs.push(
        { ref: "$pattern", type: "customWgsl", role: "calibration", column: 1, row: 3, parameters: { source: input.patternShader! } },
        { ref: "$testSwitch", type: "switch", role: "calibration", column: 2, row: 0, parameters: { index: input.testPattern === true ? 1 : 0 } },
      );
      if (video) specs.push({ ref: "$video", type: "movieFileIn", role: "content", column: 0, row: 3, parameters: { file: input.video ?? "" } });
      if (previz) specs.push(
        // Grade the reference RGB while preserving alpha; Screen opacity controls only
        // the effect's preview strength and leaves the projector branch alone.
        { ref: "$reference", type: "level", role: "reference", column: 1, row: 1, parameters: { brightness: 0.65 } },
        { ref: "$previz", type: "screen", role: "preview", column: 2, row: 1, parameters: { opacity: input.previewOpacity ?? 0.35 } },
      );
      if (input.previewPhoto !== undefined) specs.push({ ref: "$previewPhoto", type: "movieFileIn", role: "preview", column: 1, row: 2,
        parameters: { file: input.previewPhoto, imageFit: input.previewFit ?? "stretch",
          ...(input.previewFraming === undefined ? {} : imageFramingParameters(input.previewFraming)) } });
      specs.push({ ref: "$output", type: "output", role: previz ? "preview" : "mapping", column: 3, row: 1, parameters: {} });
      const kinds: string[] = [];
      for (const spec of specs) {
        const definition = context.registry.get(spec.type);
        if (definition === undefined) {
          const missing: RuntimeDiagnostic[] = [{ severity: "error", code: "photoMapping.node.unavailable",
            message: `Photo mapping requires the registered node type "${spec.type}".` }];
          return { status: "rejected", revision: context.graph.revision, diagnostics: missing,
            output: rejection(input, missing, context.graph.revision) };
        }
        kinds.push(kindOf(definition));
      }
      const nodes = Object.values(context.graph.nodes);
      const names = new Set(nodes.flatMap(node => node.label === undefined ? [] : [node.label]));
      const groupNames = new Set(Object.values(context.graph.groups).map(group => group.label));
      let suffix = 1;
      while (specs.some((spec, index) => names.has(`${kinds[index]}_${spec.role}${suffix}`)) || groupNames.has(`Photo mapping ${suffix}`)) suffix++;
      const right = Math.max(0, ...nodes.map(node => node.position.x + (node.size?.width ?? 220)),
        ...Object.values(context.graph.groups).map(group => group.bounds.x + group.bounds.width));
      const origin = nodes.length === 0 && Object.keys(context.graph.groups).length === 0 ? 0 : right + 80;
      const operations: GraphPatchOperation[] = specs.flatMap((spec, index): GraphPatchOperation[] => [
        { op: "addNode", ref: spec.ref, type: spec.type, label: `${kinds[index]}_${spec.role}${suffix}`,
          position: { x: origin + spec.column * 260, y: spec.row * 300 }, parameters: spec.parameters },
        { op: "setNodeSize", nodeId: spec.ref, size: { width: 220, height: 220 } },
        ...(index < 3 || spec.ref === "$previewPhoto" || spec.ref === "$video" ? [{ op: "setNodeResolution" as const, nodeId: spec.ref,
          resolution: { mode: "fixed" as const, width, height } }] : []),
      ]);
      const connect = (source: TempId, target: TempId, portId: string, order?: number): void => {
        operations.push({ op: "connect", source: { nodeId: source, portId: "out" }, target: { nodeId: target, portId },
          ...(order === undefined ? {} : { order }) });
      };
      connect("$photo", "$depth", "picture");
      connect("$photo", "$mask", "picture");
      connect(input.effect === 9 ? "$video" : "$photo", "$effect", "input");
      connect("$depth", "$effect", "more", 0);
      connect("$mask", "$effect", "more", 1);
      if (pattern) {
        // Custom WGSL retains its required picture socket even for a UV-only generator.
        connect("$photo", "$pattern", "input");
        connect("$effect", "$testSwitch", "inputs", 0);
        connect("$pattern", "$testSwitch", "inputs", 1);
      }
      connect(pattern ? "$testSwitch" : "$effect", "$coverage", "input");
      connect("$mask", "$coverage", "mask");
      connect("$coverage", "$grid", "input");
      connect("$grid", "$corner", "input");
      connect("$corner", "$window", "input");
      if (previz) {
        connect(input.previewPhoto === undefined ? "$photo" : "$previewPhoto", "$reference", "input");
        connect("$coverage", "$previz", "in1");
        connect("$reference", "$previz", "in2");
        connect("$previz", "$output", "input");
      } else {
        connect("$corner", "$output", "input");
      }
      operations.push({ op: "addGroup", ref: "$group", label: `Photo mapping ${suffix}`,
        bounds: { x: origin - 20, y: -40, width: pattern ? 1820 : 1560, height: pattern || video ? 1180 : 880 }, members: specs.map(spec => spec.ref) });
      const result = applyGraphPatch({ baseRevision: context.graph.revision, label: "Create photo mapping", operations }, context);
      if (scale === 1 || (result.status !== "applied" && result.status !== "validated")) return result;
      const diagnostics: RuntimeDiagnostic[] = [...(result.diagnostics ?? []), {
        severity: "warning", code: "photoMapping.resolution.fitted",
        message: `Photo mapping output fitted from ${input.width} × ${input.height} to ${width} × ${height} pixels to stay within the project's ${maxResolution}-pixel resolution limit. The full photograph and saved map references are preserved.`,
      }];
      return { ...result, diagnostics, output: { ...result.output, diagnostics } };
    },
    rejectionOutput: rejection,
  });
}
