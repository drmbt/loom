import { encodeDepthExr } from "./depth-exr.ts";

/** Canonical prepared assets use ordinary OpenEXR FLOAT channels and Loom metadata. */
export const PREPARED_MAP_EXTENSION = ".loom.exr";
export const PREPARED_MAP_MIME_TYPE = "image/x-exr";
export const encodePreparedMap = encodeDepthExr;
