# Photo depth models and guided refinement

Verified 2026-10-09 using the actual Loom inference worker and preparation/save path on one machine: Apple M3 Max, 36 GiB unified memory, macOS 26.3.1(a), Chromium 151.0.7922.34, real Apple/Metal WebGPU adapter. These timings describe this machine, not every browser or M3 configuration. ONNX Runtime Web installed version: 1.29.0.

## Artifacts and notices

Large artifacts are from [ONNX Community's published conversion](https://huggingface.co/onnx-community/depth-anything-v2-large/tree/1fa1591c7b080e98da9655827c3a33a3972a4a83/onnx), revision `1fa1591c7b080e98da9655827c3a33a3972a4a83`.

| Artifact | Exact bytes | SHA-256 |
| --- | ---: | --- |
| FP16 | 668,656,405 | `8eefc7afb877b10d413c8e1024b012073c6e4f62735d39555b1083fee3aabf0a` |
| Q4F16 | 234,560,369 | `8d180bf55d92bdae8c1a15ea3f13ad18f4e7d2721037779f0ddd7b6dbe92fad8` |

Both lengths and hashes were checked against downloaded bytes. Both declare float32 `pixel_values` input in dynamic NCHW layout and float32 `predicted_depth` output. Reduced weight precision does not change their external tensor contract. The loader and worker retain native single-channel float32 predictions.

Large weights are **CC-BY-NC-4.0**, according to the [author's license statement](https://github.com/DepthAnything/Depth-Anything-V2#license) and conversion model card. They are not Apache-2.0 like Small. The application downloads them on explicit Run, keeps the notice visible at selection and does not bundle or relicense the weights. Commercial users must resolve suitable rights; quantization does not remove the non-commercial restriction.

## Execution proof

Both Large variants passed the shipped browser worker on explicitly selected WebGPU at 266, 392, 518, 644, 770, 896, 1036 and 1288. Native dimensions, sample counts and float32 byte counts matched the artifact. Every output was finite. Explicit WASM passed 266 and 518; larger CPU sizes are not offered without proof.

| Model | Warm GPU, 518² | Warm browser CPU, 518² |
| --- | ---: | ---: |
| Large FP16 | approximately 332 ms | approximately 18,611 ms |
| Large Q4F16 | approximately 908 ms | approximately 23,246 ms |

Q4F16 reduced the download, but measured slower than FP16 on this Metal adapter. Repeated 1288 predictions varied slightly; inference is not promised bitwise deterministic. Persisted predictions did reopen bit-for-bit.

On a real ornate facade photograph, both Large variants and Small passed actual preparation, cache and save/reopen. Large Q4F16 versus FP16 normalized occupied-band mean absolute difference was 0.01789, with correlation 0.99899. GPU versus CPU correlations exceeded 0.994 for both variants. These are agreement measurements, not accuracy measurements: no measured ground truth was available. Inspection showed similar arches/cornice relief; neither the larger model nor upscaling is guaranteed to recover missing moldings.

## Refinement and cache proof

The actual facade's 2K derived output was 2048 × 1365, produced by two guided passes in approximately 355 ms. Its 4K output was 4096 × 2730, produced by three passes in approximately 432 ms. Native samples stayed unchanged, refined samples were finite, save/reopen stayed exact, and v2 metadata recorded the native parent hash and recipe. Separate focused Dawn tests compare the WGSL filter with a numerical reference, including non-square registration, border behavior, constant depth, signed/sub-byte values and cancellation cleanup.

Chromium rejected a single ArrayBuffer-backed Response for the 668 MB FP16 model even in a normal persistent profile with sufficient cache quota. Streaming the same bytes in bounded chunks succeeded; reopening matched the exact artifact SHA-256. The existing Cache API store now uses that single streaming write path for all artifacts. Actual preparation successfully cached Small and both Large variants together. Private/incognito storage can still refuse large writes; failures remain explicit rather than being treated as successful uncached acquisition.

Marigold V2 remains unimplemented pending quantized macOS feasibility on the 36 GB machine. These browser results do not establish an ONNX export or Mac executor for Marigold.
