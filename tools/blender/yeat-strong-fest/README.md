# YEAT STRONG FEST stage previz

One 3840 x 2160 pixel map from Resolume, split onto the video walls in Loom.

| Region | Pixel map | Model |
| --- | --- | --- |
| MAIN WALL | 2520 x 1512 at 0,0 (15 x 18 tiles of 168 x 84) | `led.main`, 15 x 9 m, upstage |
| IMAG | 672 x 1008 at 2524,0 (4 x 12 tiles) | `led.imag_SR` and `led.imag_SL`, 4 x 6 m each, both showing the ONE IMAG region |

The DJ booth strips (y 1512) are not modelled. Metres per tile is an ASSUMPTION (`TILE_M` in `build.py`:
1000 x 500 mm, about 5.95 mm pitch), chosen to match the Depence render's proportions. Change it when
the LED spec arrives and rebuild.

## Files

- `build.py` builds the model, writing `public/media/yeat-strong-fest/stage.glb`. Each screen is one quad with 0..1 uvs, and the crop
  lives in the network.
- `advanced_output.py` writes the Arena Advanced Output preset (`projects/yeat-strong-fest/yeat-strong-fest.xml`,
  installed as `~/Documents/Resolume Arena/Presets/Advanced Output/yeat-strong-fest.xml`). It has one screen, `PIXEL MAP`,
  published over Syphon as `YEAT PIXEL MAP`, with two slices: `MAIN WALL` (composition centre 3600 x 2160 → 0,0 2520 x 1512)
  and `IMAG` (composition centre 1440 x 2160 → 2524,0 672 x 1008). Point IMAG's Input Source at the camera layer
  if IMAG is live, and give the screen a display output at the venue.
- `projects/yeat-strong-fest/yeat-strong-fest.loom.json` is the network, authored over Loom MCP and saved from the app.
  `syphonin_pixelMap` listens for Arena's `YEAT PIXEL MAP`. `wgsl_cropMain` and `wgsl_cropImag` cut the regions out, and
  their x/y/w/h are in pixel-map pixels, so a half-size feed still lands. Source slider: 0 live, 1 the pixel map image,
  2 a test map at pixel-map coordinates (red top left, green top right, blue bottom left, yellow bottom right). It opens on 1.
  Panel `YEAT STRONG FEST`: LED brightness, main and IMAG trims, orbit, elevation, distance, lens, aim, deck tone,
  work light. Camera presets in `presets_shots`: `foh`, `wide`, `close`, `sr_angle`, `sl_angle`, `sl_profile`.

```bash
B=/Applications/Blender.app/Contents/MacOS/Blender
$B --background --factory-startup --python tools/blender/yeat-strong-fest/build.py -- \
   --out public/media/yeat-strong-fest/stage.glb --blend renders/yeat-strong-fest/stage.blend
python3 tools/blender/yeat-strong-fest/advanced_output.py \
   --template "$HOME/Documents/Resolume Arena/Presets/Advanced Output/yeat-full-stage-central park.xml" \
   --out projects/yeat-strong-fest/yeat-strong-fest.xml
```

Coordinates follow `tools/blender/stage-previz/`: metres, Z up, audience at −Y, +X stage left.
