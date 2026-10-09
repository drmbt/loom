# TopFormer facade preparation model

Loom uses the ADE20K TopFormer checkpoint exported by
[ONNX-TopFormer-Semantic-Segmentation](https://github.com/ibaiGorordo/ONNX-TopFormer-Semantic-Segmentation).
The upstream model is [TopFormer](https://github.com/hustvl/TopFormer).

The exact ONNX artifact is bundled as `src/runtime/models/assets/topformer-ade20k.onnx`.
It is requested only by an explicit facade-mask run and uses the existing model cache
and byte/hash verification. Google rejects cross-site browser fetches of the upstream
artifact; Loom serves its verified copy directly instead of retrying another provider.

- Upstream artifact: `https://drive.usercontent.google.com/download?id=1WxvVEqQGn8S2q4uqpG9OZY2Alc5ZcBCa&export=download`
- Byte length: `12099327`
- SHA-256: `1043feb52554d3db9ace3a2b46726d564ca629611f4c9d74a52a6d90aac0750c`
- Input: ImageNet-normalized RGB, float32 `[1,3,512,512]`, named `input`.
- Output: float32 ADE20K logits `[1,150,64,64]`, named `output`.

The converter identifies the model licence as Apache-2.0. The original author's published
licence contains unresolved merge markers around Apache-2.0 and MIT notices. Both full
notices are retained verbatim in `topformer-author-license.txt` and
`topformer-converter-license.txt`; this document does not replace either notice.

Preparation sums semantic confidence for wall, building, house, column and clock.
The native semantic envelope remains 64 × 64. A separate reference-photo refinement
excludes dark openings and optionally blue/cyan reflective glass at the selected mask
resolution. Shaded walls and painted blue surfaces can need erase/restore corrections.
The saved float32 result records the 512-pixel model input, native envelope dimensions,
refinement resolution and complete exclusion settings. It is not described as native
1024/1536 semantic inference.
