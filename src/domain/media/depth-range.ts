import { z } from "zod";

/** Registered near-bright depth; this range never changes native prediction samples. */
export const depthRangeSchema = z.object({
  low: z.number().finite().min(0).max(1),
  high: z.number().finite().min(0).max(1),
  softness: z.number().finite().min(0).max(0.25),
}).strict().refine(settings => settings.high > settings.low, {
  message: "Depth range high must exceed low.", path: ["high"],
});

export type DepthRangeSettings = z.infer<typeof depthRangeSchema>;
export const DEFAULT_DEPTH_RANGE: DepthRangeSettings = Object.freeze({ low: 0, high: 1, softness: 0.02 });
