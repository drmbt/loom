import { PHOTO_DEPTH_INPUT_SIDES } from "../../domain/media/preparation-sizes.ts";
import { MARIGOLD_INPUT_SIDES, MARIGOLD_MODEL_ID, type PhotoDepthRecipe } from "../../domain/media/photo-depth-recipe.ts";
import { PHOTO_DEPTH_MODELS, PHOTO_DEPTH_LARGE_FP16, PHOTO_DEPTH_LARGE_Q4F16 } from "./model-catalogue.ts";

/** Large GPU sizes passed the shipped worker on M3 Max / Chrome 151, 2026-10-09.
 * CPU proof is deliberately limited to 266/518; no automatic provider substitution. */
export function photoDepthSidesFor(modelId: string, backend: PhotoDepthRecipe["backend"]): readonly number[] {
  if (modelId === MARIGOLD_MODEL_ID) return backend === "mlx" ? MARIGOLD_INPUT_SIDES : [];
  if (backend === "mlx" || !PHOTO_DEPTH_MODELS.some(model => model.id === modelId)) return [];
  const large = modelId === PHOTO_DEPTH_LARGE_FP16.id || modelId === PHOTO_DEPTH_LARGE_Q4F16.id;
  return large && backend === "wasm" ? [266, 518] : PHOTO_DEPTH_INPUT_SIDES;
}

export function photoDepthUnavailableReason(recipe: PhotoDepthRecipe, webgpuAvailable: boolean, native?: { available: boolean; reason?: string; inputSides?: readonly number[] }): string | null {
  if (recipe.modelId === MARIGOLD_MODEL_ID) {
    if (native?.available !== true) return native?.reason ?? "Marigold V2 preparation requires Desktop on macOS with Apple Silicon.";
    if (native.inputSides !== undefined && !native.inputSides.includes(recipe.inputSide)) return "Restart the desktop app to enable this Marigold size. The running native process reports an older preparation capability.";
    return null;
  }
  if (!PHOTO_DEPTH_MODELS.some(model => model.id === recipe.modelId)) return "This saved map's model is not available for preparation. You can still reuse its verified map.";
  if (recipe.backend === "webgpu" && !webgpuAvailable) return "WebGPU inference is unavailable in this browser. Choose CPU explicitly or open Loom in a WebGPU-capable host.";
  if (!photoDepthSidesFor(recipe.modelId, recipe.backend).includes(recipe.inputSide)) return "This model, backend and input size combination has not been validated. Choose a supported input size.";
  return null;
}
