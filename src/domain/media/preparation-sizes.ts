/** Native inference sizes verified against the pinned preparation models. */
export const PHOTO_DEPTH_INPUT_SIDES = [266, 392, 518, 644, 770, 896, 1036, 1288] as const;
export const PHOTO_MASK_INPUT_SIDES = [1024, 1536] as const;

export function supportsPhotoDepthSize(side: number): boolean {
  return (PHOTO_DEPTH_INPUT_SIDES as readonly number[]).includes(side);
}

export function supportsPhotoMaskSize(side: number): boolean {
  return (PHOTO_MASK_INPUT_SIDES as readonly number[]).includes(side);
}
