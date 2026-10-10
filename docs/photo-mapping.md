# Photo projection mapping

Open **File → Map from photo…**, or **Settings → Output → Map from photo…**.
Photograph a stationary surface from beside the projector lens.

1. Choose the reference photo. You can add a separate night photo for preview.
2. Load matching saved depth and mask files, or run each preparation separately.
3. Save new maps, then create the network. Choose a display in Window Out and align
   Grid Warp and Corner Pin to the physical surface.

The main Output previews the effect without a projector. The photo composite has
its own light opacity and reference brightness controls; these do not change
projector output. Crop, fit or stretch a differently framed preview photo, then use
the reference overlay to compare rooflines and windows.

## Depth and masks

Depth stays float32 at its native resolution. It describes relative depth, so it
helps reveal contours and relief but does not measure physical geometry. Depth
inputs can be selected up to 1288 × 1288.

Surface masking is optional. Turn off **Use surface mask** to map the full frame
without generating or saving a mask.

**Facade walls and openings** keeps opaque walls and excludes sky and dark openings,
with an option to exclude blue reflective glass. Inspect the red exclusion overlay and
adjust Opening cutoff before rerunning. Brush erase/restore and stroke undo let you
correct shaded walls, bright glass or other missed features. **Object background
removal** is a separate option for isolated subjects.

Mask detail offers 1024 or 1536. Facade preparation combines a small semantic map
with reference-photo refinement at that resolution. Larger masks are not native
high-resolution semantic predictions; see [model details](./models/topformer.md).
Object background removal uses native 1024/1536 inputs.

## Save and reuse

Keep `.loomf32` maps and photos beside the `.loom.json` project. Saved maps can be
reused without inference, and the asset fields can relink moved files. Preparation
runs only when you click Run or Rerun; model weights are cached locally.

On a prepared Float Map In, **Prepare / rerun…** opens its saved preparation.
Rerunning depth preserves mask edits and calibration. Rerunning the mask replaces
its brush edits. Oversized photos fit the project's resolution limit while keeping
the full frame and original asset.

New networks include five editable, animated looks: Neon contours, Prismatic sweep,
Chromatic relief, Surface trace and Depth reveal. Depth and photographic edges drive
their structure. Speed, palette, glow and detail controls live on the Custom WGSL
node. Create a new network from saved maps to use the latest templates; existing
networks retain their own shaders.
