# Texture inputs on a Material · WGSL (T1658b)

**Status, 2026-10-06: built** (`610616e6`, tests `cc2290d2` and `d5d6235d`; the pins of an untextured material in `49803f66`, taken first). Section 9 says what was built, what changed from the design below, and what was not checked. Written against main at `bc8e7444`; the light path's slice 4 (shadow maps into two layered targets) was in flight in the same two files, and section 5 counts the budget before and after it.

## 0. On one page

- A Material · WGSL reads up to **four textures**. The node gains four optional inputs, **Texture 1 to Texture 4**.
- The source **names** what it reads, in the file's own comment idiom: `// @texture lens`. The first name is Texture 1, the second Texture 2. The generator declares the binding; the author never writes a binding number.
- `surface()` reads a texture by a coordinate of its choosing, with two functions from a new shared module, `// @use map`: `mapLinear(lens, uv, extend)` and `mapNearest(lens, uv, extend)`. Both are `textureLoad` only. The plain WGSL built-ins (`textureLoad`, `textureDimensions`) work on the name too.
- **A named texture with nothing wired is an error that names it.** A wire into an input the source does not name is a warning that names it. Nothing reads black in silence.
- It works wherever a Material · WGSL works: a grid Surface, a mesh Surface and mesh instances. The textures are bindings of the fragment stage, and those three draws share one fragment generator.
- A source that names no texture compiles to **the text it has today, to the byte**. Pinned before the first edit.

## 1. What the reference tools give a custom material

| | TouchDesigner, GLSL MAT | Notch, Material | Here |
|---|---|---|---|
| Who names a texture | the author, in the shader: a sampler declared under a name of their own (`sampler2D` for a 2D TOP) | the tool: one input per channel of the material | the author, in the source: `// @texture name` |
| Where it is wired | the Samplers page: a sequence of rows, each a Name and a TOP. The name is the one the shader declares | a fixed input per role: Colour Texture, Diffuse Texture, Specular Map, Emissiveness Map, Metallicness Map, Roughness Map, Normal Map, Displacement Map, Alpha Map, Ambient Occlusion Map, two for subsurface | four inputs, Texture 1 to 4, taken in the order the source names them |
| How many | as many rows as the author adds | twelve, one a role | four |
| A live picture | any TOP, a Video Device In included | "Typical Input: Video Loader" on every map | any texture output: a Webcam, a Movie File In, a Render |
| Sampling, per texture | Extend U, V, W (Hold, Zero, Repeat, Mirror), Filter (Nearest, Linear, Mipmap Linear), Anisotropic Filter | Texture Wrap Mode U and V on the material; a Mapping node overrides the coordinate | the call: `mapNearest` is nearest, `mapLinear` is linear, and each takes an extend an axis (hold, repeat, mirror) |
| The coordinate | the author's: a texture coordinate layer of the geometry, or anything computed | the mesh's UVs, or the Mapping input | the author's: `s.uv`, or anything computed from `s.local` or `s.world` |

Sources, read 2026-10-06:

- https://docs.derivative.ca/GLSL_MAT (Parameters, Samplers Page: "This is the sampler name that the GLSL program will use to sample from this TOP. The samplers need to be declared at the same dimentions as the TOP"; the texture sampling parameters of each row; Load Uniform Names "fill in the various name fields").
- https://docs.derivative.ca/Phong_MAT (a stock MAT's maps: eight texture coordinate layers, the same sampling parameters per map).
- https://manual.notch.one/2026.1/en/docs/reference/nodes/materials/material/ (Inputs table).

What follows from them:

- **The author names the texture** in both tools that let an author write a shader at all (Notch's Material is not code: its inputs are roles). A name in the source and a wire on the node, matched, is TouchDesigner's shape and is taken here.
- **TouchDesigner matches by name, with a row a texture.** A node here has no row a texture: its inputs are declared once for the type (the contract has `parametersFor` for a node's own parameters and nothing like it for ports). So the match is by ORDER onto four fixed inputs. Section 3.2 says why not a variadic input.
- Sampling is said per texture in TouchDesigner and per material in Notch. Here it is said per CALL: the author already writes the call, and one texture read two ways (a held picture and a tiled grain from the same input) needs no second input.

## 2. What exists today

- `materialWgslNode` has `inputs: []`. Its payload has `maps: {}`. `SurfaceIn` carries no texture.
- The stock materials have two optional inputs, Albedo Map and Roughness Map, bound as `albedoMap` and `roughnessMap` at bindings 3 and 4 of the lit module and read with `textureLoad` (a draw pass carries no sampler).
- **Custom WGSL · Multi** is the engine's precedent for an author's texture: one variadic input, More, whose wires bind in order as `inputTexture1` to `inputTexture3`; the source declares them; a declared one with nothing wired is refused by name.
- A Material · WGSL's code is pasted into the Render's surface module (`sceneSurfaceModule`, option `custom`), the one fragment generator of a grid Surface, a mesh Surface and mesh instances. Points, beams and primitive instances draw through another generator and refuse a Material · WGSL by name already.

## 3. The surface

### 3.1 Naming a texture

```wgsl
// @use map
// @texture lens
// @texture grain

fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  let picture = mapLinear(lens, s.uv, vec2u(MAP_HOLD));
  o.emissive = o.emissive + picture.rgb * p.mix;
  return o;
}
```

- `// @texture <name>` on a line of its own, like `// @use`. The name is a WGSL identifier.
- The generator declares `var <name>: texture_2d<f32>;` in front of the author's code, at a binding of its own choosing (110 to 113: clear of the lit module's own, of a mesh's at 100 to 104 and of the frame block at 120).
- Why a directive and not the author's own `var lens: texture_2d<f32>;`: the generator would have to cut each declaration out and write it again with a binding, and every cut moves the source map that sends a device error back to the author's line. A comment is left where it is.
- Refused by name, at the material node: a name that is not an identifier; a name twice; a name the generator or the source itself declares (`surface`, `params`, `SurfaceIn`, a helper of the author's); a fifth texture.

### 3.2 The inputs

Four optional inputs on the node: `texture1` to `texture4`, labelled Texture 1 to Texture 4, typed as a colour texture (the stock Albedo Map's type, so a picture arrives in the working space as it does there).

- **Fixed inputs, not one variadic input.** On a variadic input the wire's place in the list is the binding. Take the first wire away and the second becomes the first: the grain is now the picture, with no error. A fixed input stays the one it is.
- **Order, not name.** Texture 1 is the first `// @texture` of the source. An input cannot carry the source's name as its label (no per-node ports in the contract), so every sentence that mentions one says both: `texture "lens" (Texture 1)`.
- **Named and not wired: an error.** `the source names texture "lens" (Texture 1) and nothing is wired into Texture 1`. The Geometry that wears the material is not drawn, as for any material that does not compile. The alternative was a stated default (white, or clear): it needs a texture nobody made, and a lens that shows white is harder to find than a sentence.
- **Wired and not named: a warning.** `Texture 3 is wired and the source names 2 textures (lens, grain): it is not read`. The picture is right, so it is not an error; it is said because a wire that does nothing is how T1641b's class starts.
- A texture is bound as it is: any size, any float format (`rgba8unorm`, `rgba16float`, `r32float`), unfilterable, read with `textureLoad`. Nothing is resampled on the way in.
- **A live source is just a texture.** The binding is the producer's resource; what is in it this frame is what the surface reads this frame. The compiler orders the producer before the Render, as it does for a stock material's Albedo Map (E25 wires a Render's output into one). Tested with a texture that changes every frame.

### 3.3 Reading it: the shared module `map`

`// @use map` (it pulls in `extend`, whose two folds it reads by). Parameter-free, so it is the same text in a Custom WGSL.

| | |
|---|---|
| `mapNearest(t, uv, extend)` | the one texel the coordinate is in |
| `mapLinear(t, uv, extend)` | the four texels round it, weighed: four `textureLoad`s |
| `extend: vec2u` | across and along, each `MAP_HOLD`, `MAP_REPEAT` or `MAP_MIRROR` |

- A coordinate of 0 to 1 covers the texture once, texel centres at `(k + ½) ÷ size`, all `size` texels, Hold included. That is the address the stock materials' Repeat and Mirror use and NOT the one their Hold uses: a stock map held at its edge is read at `uv × (size − 1)`, truncated (T1650b). The two differ on purpose. Making either match the other moves pictures (this module's: every Material · WGSL that reads a texture; the stock Hold's: every mapped Surface that shipped: E20, E25, E34, E75, E76 and two project documents), so neither is to be "fixed" without that list. The module's own comment says the same.
- Hold clamps; Repeat and Mirror fold each texel's own coordinate by `extendRepeat` and `extendMirror`, so `mapLinear` blends across a tile's edge with the texel that is really next to it.
- **`textureLoad` only**, as everything in the lit shader is. No sampler, so no derivative, so a read inside a branch or a loop of the author's is legal (no uniformity rule). The price: no mip levels. A picture drawn much smaller than its texture shimmers; the author can feed a smaller texture (a Resolution upstream). Said in the description.
- The texture is a plain binding: `textureLoad(lens, vec2i(…), 0)` and `textureDimensions(lens)` work, for a read by texel.

### 3.4 The coordinates an author has

- `s.uv`: the points' own `uv` where they carry one (a Sweep, a mesh file, a mesh instance's shape) and the source names `.uv` (T1618b); else a grid's own coordinate; `vec2f(0)` on a mesh with none.
- `s.local` and `s.localNormal`: the surface in the shape's own frame. A lens-local coordinate is `s.local` less the lens's centre, over its size.
- `s.world`, `s.attr` (a mesh's surface row; its fourth number is the part, which is where a role such as "lens" lives), `s.instance.<field>`, `s.instanceId`.
- Nothing is added to `SurfaceIn`.

## 4. Where it works

| Draw | Works | Why |
|---|---|---|
| Grid Surface | yes | the surface module's fragment stage |
| Mesh Surface | yes | the same |
| Mesh instances (Instances, Shape: Mesh) | yes | the same fragment stage; an instance's own values are `s.instance` and `s.instanceId`, so one texture can be shown differently on each |
| The G-buffer layers and the shadow matte of those draws | yes | they run the author's `surface()` too, so they bind the same textures |
| Points, beams, primitive instances | no | they refuse a Material · WGSL by name today, and still do |
| Glass | no | a stock material |

The consumer's hull (three instances of one mesh, the lens a role in an attribute) is the third row: the role (`s.attr.w`, or a field of `s.instance`) picks the lens, `s.local` gives the coordinate inside it, `p.mix` blends.

## 5. The budget

WebGPU's floor is **sixteen sampled textures a shader stage**. What one lit draw binds:

| | Today | After the light path's slices 4 and 5 |
|---|---|---|
| A stock material's maps | 0 to 2 | 0 to 2 |
| **A Material · WGSL's textures** | **0 to 4** (it has no stock maps) | **0 to 4** |
| Shadow maps | one a casting light | 2 (one layered target for directional lights, one for point lights) |
| Environment | 1, or 2 prefiltered | the same |
| Ambient occlusion | 1 | 1 |
| Projectors | 2 each (cookie, occlusion) | 2 each |

- Today, with four textures, a prefiltered environment and occlusion: `4 + 2 + 1 = 7`, leaving nine for casting lights and projectors (`N + 2P ≤ 9`).
- After slice 4: `4 + 2 + 2 + 1 = 9`, leaving seven: three projectors with everything else on, whatever the number of casting lights.
- **Four is the stated count.** More would take the room the light path is about to give back; fewer than TouchDesigner's "as many as you add" is the cost of a floor of sixteen. A fifth `// @texture` is refused at the material node, by name, with the count.
- **When a draw does not fit**, the Render's own ledger already says so by category (`node.scene.textureBudget`, T1406b), and the compiler refuses the pass on a device that reports no more than the floor. The ledger gains the category "material textures".
- **V1029.** The surface module's text gains one binding line a named texture, up to four: declarations, under a named refusal at a stated count (its exception (b)). The four inputs are fixed, not variadic, so the gate derives no new axis from them; the count rides in the source, which is the author's text. If the gate asks for a row all the same, it gets `declarations`, bound 4.

## 6. What the author is told

- The node's description and the Source parameter's: how to name a texture, that Texture 1 is the first name, `// @use map` and its two functions, that there are no mip levels.
- Each input's description: which name it takes.
- T1641b: the two sentences of 3.2, and the refusals of 3.1. Every one says what to write instead.

## 7. What it does not do

- No mip levels, no anisotropic filter (no sampler in a draw pass).
- No texture arrays, cubes or 3D textures.
- No per-node labels on the inputs (the source's names do not reach the node's face).
- The stock materials do not read by `map`: their text and every pin stay as they are.
- More than four textures.

## 8. Tests, as planned

On Dawn through the compiler and the backend, exact (§V147):

- A quad whose material returns its texture read at `s.uv` shows the fed texture's texels at four known pixels; with the wire cut, the named error and no draw.
- The same through mesh instances, an instance each showing its own part of the texture.
- A texture that changes every frame: the surface shows frame N's picture in frame N.
- `mapNearest` and `mapLinear`, each with Hold, Repeat and Mirror, by the texel read.
- The consumer's shape: a mesh with a role in an attribute, the texture shown only where the role says, mixed by a parameter; a pixel of the rest of the mesh does not move when the texture does.
- By text: a Material · WGSL that names no texture is the text it was (grid, mesh and mesh instances, pinned before the first edit), and the stock materials' pins do not move.

## 9. As built (2026-10-06)

### 9.1 What it is

- `src/nodes/definitions/material-wgsl.ts`: four optional inputs, `texture1` to `texture4`; `reflectTextureNames(source)` reads the `// @texture <name>` lines; the payload's `custom.textures` carries each name with the resource wired into the input of its place.
- `src/nodes/shaders/shared-modules.ts`: the module `map` (`mapNearest`, `mapLinear`, `MAP_HOLD`, `MAP_REPEAT`, `MAP_MIRROR`; it requires `extend`).
- `src/nodes/shaders/scene-render.wgsl.ts`: the custom surface takes `textures: string[]` and declares one binding a name, from 110, at the end of the module's own declarations. `isSurfaceBoundName` says which names the module already has.
- `src/nodes/definitions/scene.ts`: one array built at the custom-material site and spread into the three `textures:` lists (the lit draw, the shadow matte, the other layers); the ledger says "Material · WGSL textures".
- Nothing else in the lit text. A source that names no texture is the text it was: three whole-plan pins (a quad, a mesh, mesh instances, with a casting sun and three layers) taken at `b194894a` hold, as do the one-sheet pins, the light-guard digests, the light-points fingerprints and V1029, which asked for no row.

### 9.2 What changed from the design

| The design said | Built |
|---|---|
| `mapTexel(t, uv, extend)` | `mapNearest`. The stock materials' Map Extend already emits a `mapTexel(uv, size)` of its own into the same module; two functions of one name in one file was a trap |
| A wire the source does not name is a warning | It is a warning in severity and `never`, `local` in class (T1641b): nothing reads it, the material is whole, the plan stays usable, and a final render stops on it |
| "Named and not wired: an error" | An error, class `notYet`: it reads the moment a wire arrives. The plan is withdrawn while it stands (the app keeps the last good one) and a final render stops. Not `local`: that is said of a `never` finding only, and making this one local needs a stand-in surface to draw meanwhile |

### 9.3 The three findings, and their class (`src/domain/diagnostics/classes.ts`)

| Code | Severity | Class | When |
|---|---|---|---|
| `node.materialWgsl.texture` | error | `never` | a line that names no texture: not a name, a name twice, a name the shader already declares, a fifth |
| `node.materialWgsl.textureUnwired` | error | `notYet` | a texture the source names with nothing wired into its input |
| `node.materialWgsl.textureUnread` | warning | `never`, `local` | a wire into an input no line names |

Every sentence names a texture both ways, `texture "lens" (Texture 1)`. The canvas socket and the inspector's Connections list show the input's own label, `Texture 1`: an input takes its label from the node TYPE, and the socket's description says which line it takes. An input that wears the source's name needs per-node port labels in the node contract (a `parametersFor` for ports), which is a row of its own.

### 9.4 Live media that is not there

The first thing anyone wires into a material is a Webcam or a Movie File In, and the camera or the file may not exist. Established by test; nothing needed fixing.

| Host | What the media node hands on | What is said |
|---|---|---|
| No source registered for the node: the app after a camera is refused (`use-media-sources.test.tsx`, "reports a refused camera and registers nothing"), and any process that drives the backend itself | **transparent black**: every byte of the node's texture is zero | by the app, `media.unavailable`: a warning, class `elsewhereHost`, which a final render lets through. By the compiler and the backend: nothing |
| A headless render (`renderHeadless`) | the harness's moving **test card** (`syntheticMediaFrame`, T650), per node and per frame | nothing. `strict: true` goes through |

- Held for a Webcam and for a Movie File In with no file: the material mixes transparent black as its parameter says (black, half its own colour, its own colour); under `strict` the surface shows the card, texel for pixel, decoded to the working space, exactly, and it moves between frames.
- So "wired means there is a texture" holds on every host, and the material has no optional-texture contract.
- The two placeholders differ (black in the app, a card in a headless render). Both are defined; a document's look on a host with no camera is the host's, and is said as such.

### 9.5 Tests

| File | Tests | What |
|---|---|---|
| `src/runtime/backend/vgpu/material-textures.gpu.test.ts` (new, Dawn) | 19 | a quad reads its texture pixel for texel, all 4,096; the wire cut; two textures in the order named, and exchanged; a texture that changes every frame, read in the frame it changes; the Albedo layer; lit with every layer on; `mapLinear`'s weights; Repeat and Mirror an axis each; `mapLinear` across a tile's edge; `textureLoad` on the name; a mesh Surface; the consumer's shape (two tests); mesh instances, and their wire cut; live media that is not there (four) |
| `src/nodes/definitions/material-textures.test.ts` (new) | 17 | the three pins; what each draw declares and binds on a quad, a mesh and mesh instances; a depth sweep binds none; the inputs and the reflection; the module; every refusal sentence and class; an unread wire; the ledger at seventeen bindings; a media-fed material compiles with nothing said |

Red-verified by mutation, applied and restored by edit: 18 one-line mutants of the module, the generator, the Render and the node; each fails a test.

### 9.6 Not checked

- Under MSAA and SSAA; with an environment, occlusion and projectors bound beside the textures (the bindings are disjoint by number; no test draws them together).
- A texture of another size or format than the 64 × 64 `rgba8unorm` ruler: `rgba16float` and `r32float` are bound the same way (unfilterable, `textureLoad`) and were not drawn.
- The app: wiring a Webcam into Texture 1 in the browser, and the Problems panel's wording of the three findings. No headed run.
- A Render's own output wired into its material's texture (a cycle): the compiler's own rule, not exercised here.
- The light path's slice 4 had not landed when this was built; the budget of section 5 after it is derived.

