# Marigold V2 MLX verification — 2026-10-09

Quantized Marigold V2 depth preparation passed on the owner's **Apple M3 Max with 36 GiB unified memory**. The route uses a native Swift/MLX worker, a mixed 4/8-bit Qwen-Image-Edit-2509 transformer and the released `depth/Log-stage2` LoRA/trained VAE decoder. It prepares static photos separately from live DAV2 depth.

## Setup and execution boundary

On macOS Apple Silicon with the Xcode/Swift toolchain available, run:

```bash
pnpm native:marigold:build
```

The default native cache is `.cache/marigold-v2`; model assets live under its `models/` directory. The build acquires pinned source archives and builds the worker. Start Loom's Electron app, open photo mapping preparation, choose **Marigold V2 / MLX mixed 4/8-bit**, select a **512, 768 or 1024** inference long edge and seed, then run preparation. First use downloads and verifies the model bundle; subsequent use reuses the verified local cache. Cancellation and acquisition failures remain explicit.

Inference runs in an Electron-owned native process. **No helper or cloud inference is required.** The photo stays local; network access acquires source/model assets. Browser-only Marigold preparation is unavailable and uses the normal desktop/macOS/Apple Silicon indicators. Saved float-map networks reopen and render in the browser without the worker or model. Electron owns the job and UI integration; MLX supplies Metal execution.

The proof used Swift 6.3.3 on macOS 26. The upstream library declares macOS 14 as its minimum. These measurements qualify the actual 36 GiB M3 Max, not every Apple Silicon model, RAM size or older macOS installation.

## Frozen sources and model identities

| Component | Pinned source/revision |
| --- | --- |
| Native port | [mnmly/mlx-swift-marigold-v2](https://github.com/mnmly/mlx-swift-marigold-v2/tree/f831354b69b2c683757bed567bf1395ceb826eb6), `f831354b69b2c683757bed567bf1395ceb826eb6` |
| MLX Swift | [ml-explore/mlx-swift](https://github.com/ml-explore/mlx-swift/tree/ea8a179690170ca891a97bc0473198ab1ecda5f4), `ea8a179690170ca891a97bc0473198ab1ecda5f4` |
| MLX C | [ml-explore/mlx-c](https://github.com/ml-explore/mlx-c/tree/c74db5307cc8ce122f48d97ef951b30578674e7f), `c74db5307cc8ce122f48d97ef951b30578674e7f` |
| MLX core, 0.32.2 | [ml-explore/mlx](https://github.com/ml-explore/mlx/tree/1f8e74e3f12f31365464a6867c6579f0e9b29d85), `1f8e74e3f12f31365464a6867c6579f0e9b29d85` |
| Swift Numerics | [apple/swift-numerics](https://github.com/apple/swift-numerics/tree/0c0290ff6b24942dadb83a929ffaaa1481df04a2), `0c0290ff6b24942dadb83a929ffaaa1481df04a2` |
| Quantized transformer | [AbstractFramework/qwen-image-edit-2509-4bit](https://huggingface.co/AbstractFramework/qwen-image-edit-2509-4bit/tree/4af31392d562331651822afe6241daa09e87bbd1), `4af31392d562331651822afe6241daa09e87bbd1` |
| Original VAE/configuration/bias | [Qwen/Qwen-Image-Edit-2509](https://huggingface.co/Qwen/Qwen-Image-Edit-2509/tree/d3968ef930e841f4c73640fb8afa3b306a78167e), `d3968ef930e841f4c73640fb8afa3b306a78167e` |
| Released depth adapter/prompts | [huawei-bayerlab/marigold-v2-0](https://huggingface.co/huawei-bayerlab/marigold-v2-0/tree/cdf9810fb690886391a63aec012b5f501064fb0d), `cdf9810fb690886391a63aec012b5f501064fb0d` |

The MLX Swift pin includes the upstream 0.32.2 GEMM fix; a moving branch is not equivalent to the verified source. Swift Argument Parser belongs to the upstream CLI and is not needed by the Loom worker.

| Source archive | Exact bytes | SHA-256 |
| --- | ---: | --- |
| Native port | 5,465,837 | `208ba4c491cd2e8f0ff7a6faa97d29984cfcfadea036cc6dc466b17a0fdcbb3f` |
| MLX Swift | 2,224,777 | `299847e295c6ed20bc4e8ee1649173691ba79ab1c7e66c5c555f5ed802a0ffa5` |
| MLX C | 176,985 | `f7fe562edb84da59f7d6226772a51c57bdc931503fcd0ae63c078d7390d3510b` |
| MLX core | 4,415,184 | `cb988a5bdc38c798918d042b9b1c6edda3ccc5f23a2155138d3aa5c1b2acc301` |
| Swift Numerics | 71,180 | `d245f3fb06086ad0ea493b40d0a1058f17529344b5fd52ca4a7f4271240810c8` |

Archives use `https://codeload.github.com/<repository>/tar.gz/<pinned-revision>`. Source archives/build work products are separate from the model download.

## Quantization and corrected output bias

The [conversion](https://huggingface.co/AbstractFramework/qwen-image-edit-2509-4bit/blob/4af31392d562331651822afe6241daa09e87bbd1/README.md) uses **MLX affine quantization, group size 64**: most transformer linears use four bits; `img_mod_linear` uses eight bits. Packed U32 weights carry BF16 scales and per-group quantization biases. Normalization weights and the VAE stay BF16. Runtime BF16 rank-128 LoRA side matmuls use alpha/rank = 1; they are not fused into packed weights.

MLX affine quantization is **not bitsandbytes NF4**. The official LoRA was trained against NF4. This route retains the released inference topology/trainables, but does not claim numerical interchangeability between codebooks.

The conversion omits the original nonzero `norm_out.linear.bias` because its output normalization reused a bias-free Flux layer. Loom restores the actual Qwen tensor instead of inserting zeros. The BF16 `[6144]` payload comes from bytes **4776–17063 inclusive** of the pinned Qwen `transformer/diffusion_pytorch_model-00005-of-00005.safetensors`. Its raw digest is checked before wrapping it as a small safetensors artifact:

- Raw tensor SHA-256: `c04b5d2762b398992af6c76f0726188d0dfdbef37a4ff761698a237efba0b633`.
- Restored artifact: 12,384 bytes, SHA-256 `a795b0d7bfa6693f123705484ad1167149654a491f583e8dac2280e739d70108`.

The loader maps only audited conversion names back to diffusers module paths: image/text modulation linears, image/text feed-forward projections and `attn.attn_to_out`. Packed dtype, shapes, groups, expected parameters and LoRA targets are checked. Missing/incompatible tensors are errors.

## Complete model download

The verified bundle is **15,326,640,856 bytes** (15.33 GB / 14.27 GiB), including metadata/notices and the restored bias. It excludes the text encoder/tokenizer and the unquantized 40 GB transformer. Fixed released prompt embeddings replace the 7B text encoder. All five supported sizes share one bundle; the 36 GiB Mac never loads or converts the full unquantized base.

Each entry was size-checked and SHA-256-verified from downloaded bytes. Paths describe the worker's asset layout.

| Artifact | Exact bytes | SHA-256 |
| --- | ---: | --- |
| `quant/LICENSE.md` | 11,358 | `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30` |
| `quant/README.md` | 2,306 | `f5860bdd198a7f353ec16144072466091451cce607ab4fb564b2ed228ba26307` |
| `Qwen-Image-Edit-2509/transformer/0.safetensors` | 2,133,769,869 | `97e221e28659142c0234f1a0d097ecd9ba5e6ebb2baef57463e291e0b28e2d94` |
| `Qwen-Image-Edit-2509/transformer/1.safetensors` | 2,142,940,100 | `e8b2e62dcd3fd8552f160b7d756d35af65764bb981af31739b4080de6851a0c5` |
| `Qwen-Image-Edit-2509/transformer/2.safetensors` | 2,103,978,106 | `6100e2628176a0834440c8d03c443b3c5d7649f16c4463587f1b0902416b2ca3` |
| `Qwen-Image-Edit-2509/transformer/3.safetensors` | 2,121,682,265 | `7759f6d31531ceaf38c7760d12e8a1330964a8c7404ee741be2c96ad81a67617` |
| `Qwen-Image-Edit-2509/transformer/4.safetensors` | 2,142,940,118 | `a0bce3238911d60db46d2da920496383c33b1c2130513300bcaab7361920a66e` |
| `Qwen-Image-Edit-2509/transformer/5.safetensors` | 2,103,978,210 | `a499deda821a0a8d72b056f1794f5a8631874a465850c4e84d25b8c21c02bc2d` |
| `Qwen-Image-Edit-2509/transformer/6.safetensors` | 449,941,880 | `b813d48584b2c83b089641e4bdc79a81cb012f29ef9a491d9b08e064fe6482a5` |
| `Qwen-Image-Edit-2509/transformer/model.safetensors.index.json` | 241,693 | `f9f03fac574131598f16cdee75d60ffa15dc0fd5e60c37d89bcc74aa3653366c` |
| `Qwen-Image-Edit-2509/transformer/config.json` | 339 | `247c94f9b923a7d6b6035ca76d27b556bd0efd1a8c7672f31f037644fcce340e` |
| `Qwen-Image-Edit-2509/vae/config.json` | 730 | `c448160dba5ce79c965cb075ee02e18d1c42eb6424f787e5869790d577b56a65` |
| `Qwen-Image-Edit-2509/vae/diffusion_pytorch_model.safetensors` | 253,806,966 | `0c8bc8b758c649abef9ea407b95408389a3b2f610d0d10fcb054fe171d0a8344` |
| `Marigold-V2/LICENSE` | 11,357 | `b9cf2597773e6ad82b35aa652e4af4bba68e9304fbe4406bc0f6bdedad8a4b4a` |
| `Marigold-V2/depth/Log-stage2/trainables.safetensors` | 1,853,909,694 | `3edec69490ba8e8fdc8d63e130f93cb93f514360d415a22701250b2535056892` |
| `Marigold-V2/manifest.json` | 5,579 | `b6545c4fcc395b1628c7960e1942e8428d411916a74c2d19acabfafd475454e8` |
| `Marigold-V2/qwen_text_embeddings/qwen_edit_2509_qwen_depth_realimg512_prompt_embeds.pt` | 19,384,278 | `ba752b582571d990c75ad6aac2a2eeb0cf04c2fe01b233b1675028eabf342a6d` |
| `Marigold-V2/qwen_text_embeddings/qwen_edit_2509_qwen_depth_realimg512_prompt_mask.pt` | 23,624 | `80973a6521f21a5a6faf6402cae185dafef840d91e654efbeb1097914e634798` |
| `auxiliary/norm_out_bias.safetensors` | 12,384 | `a795b0d7bfa6693f123705484ad1167149654a491f583e8dac2280e739d70108` |

## Prediction semantics and registration

RGB is encoded by the Qwen VAE; its posterior is sampled with the requested seed; one transformer velocity prediction is subtracted from the input latent; the trained checkpoint decoder produces the scalar depth. The effective BF16 timestep is 0.5. Training-only projector tensors are excluded.

`depth/Log-stage2` predicts **affine-invariant relative log depth**, increasing with distance, rather than measured metric Z. Native outputs/saved maps retain actual finite float32 samples. Preparation metadata v2 records `semantics: "relative-log"`, `registration: "stretch"`, model `marigold-v2-q4`, bundle `marigold-v2-log-stage2-mlx-q4-v1`, backend `mlx`, seed and input size. Inputs cover the full reference frame at aspect-aware dimensions rounded to multiples of 16, rather than using square letterboxes. Sampling/display normalizes the recorded range and reverses polarity for near-is-bright consumers without rewriting the native samples.

RGB-guided cleanup/upscaling is a separate derived stage with its native parent identity. Inference, refined-map and graph-output dimensions remain distinct. Save metadata retains the recipe/content identity; changing model, size, seed or filter settings does not silently reuse a different preparation.

## Actual 36 GiB Mac performance

Release prototype runs used one native process per job, without concurrent model GPU jobs. MLX soft scheduling threshold: **20 GiB**; recycled-buffer cache limit: **512 MiB**. This setting was not a hard allocation cap. Loaded model allocations held approximately **15.17 GB**. Outputs were finite; independent reads verified `.npy` dimensions and little-endian float32 samples; PNGs were inspected visually.

| Input | Inference seconds | Full process seconds | Peak MLX GiB | Peak process footprint GB |
| --- | ---: | ---: | ---: | ---: |
| Facade 512 × 352, first cold run | 7.52 | 14.11 | 15.70 | 17.46 |
| Facade 768 × 512 | 4.53 | 8.30 | 16.57 | 17.67 |
| Facade 1024 × 688 | 8.06 | 12.14 | 17.22 | 18.86 |
| Official forest 512 × 512 | 3.16 | 6.63 | 16.00 | 16.69 |
| Official forest 1024 × 1024 | 11.15 | 14.71 | 18.70 | 18.94 |

Inference includes preprocessing/encode/DiT/decode/postprocessing; full process also includes loading/output writes. Later runs reused compiled Metal kernels and filesystem cache: the slower first 512 run does not mean larger input is generally faster. Process footprint and MLX allocations are different counters and must not be added. The prototype's `loadSeconds` discarded fractional duration, so this table uses stage timings and the wrapper's full elapsed time.

The first cold facade run coincided with `vm.swapusage` growing from **1654.06M to 4998.25M** (approximately **1.62 to 4.88 GiB**), with **214,028 swapout pages**. System-wide counters cannot assign all growth to the worker. Subsequent sequential runs, including 1024², added **zero swapouts**, with swap use unchanged at **4990.25M** (approximately 4.87 GiB). This proves allocation-budget feasibility on the measured machine; a busy desktop can still swap, and lower-memory Macs remain unqualified.

## Quality evidence and remaining scope

Facade inspection showed arched recesses, cornices and lattice structure, with more visible detail at 1024 than 512. Flat regions still show smoothing/ringing and inferred gradients. No measured facade ground truth was available: these results establish usable preparation/registration rather than geometric accuracy.

A fixed [official static demo](https://huggingface.co/spaces/huawei-bayerlab/marigold-v2-web/tree/2d2767ff9b18196953d4a7c54e092e25984aad0a) supplied a 900² forest RGB/depth pair. Local 1024² output preserved the hanging heart/thin fir branches and resembled its overall depth ordering; background detail remained noisier. The reference is an 8-bit RGBA colormapped PNG with undocumented inference resolution/seed. Published source/release assets omit raw official float predictions and latent parity arrays. **Visual agreement does not establish numerical NF4 parity or quantization accuracy.**

This is **Marigold V2 `depth/Log-stage2`**, not v1.1. Separate normals/albedo task adapters and their UI/runtime integration remain **unimplemented**. They require separate decoder/prompt installation, vector semantics, recipe identity and numerical/memory verification; this depth proof does not enable or advertise them. [Attribution/notices](marigold-v2-NOTICE.md).

## Desktop and artifact integration proof

The production worker was built from the pinned archives with the checked-in quantization
patch and runner. Its build cache verifies source/patch/runner/build-script and toolchain
identity plus the installed executable, Metal bundle and notices.

The actual Electron photo dialog completed 512-square depth from the official reference,
using the production preload/IPC owner/executor and Swift child. The renderer preparation
API then encoded a native `.loom.exr` artifact; a separate headless Chromium instance
without `loomDesktop` decoded and registered that exact file as finite relative log-depth.
Main-process diagnostics were empty after retirement. Test screenshots and saved output:
`.cache/marigold-v2/smoke/`.

The native parent watchdog was tested by exiting an owning process during the transformer
stage: the native worker retired within 723 ms and published no result file. Ordinary
cancellation waits for process exit and temporary-file cleanup; failures remain explicit
retirement diagnostics. Main shutdown also drains retained static jobs before exit.

Scoped checks passed: 153 preparation/viewer/client/name tests, 172 recipe/metadata/command/
loader tests, 176 desktop checks, 6 guided-refinement GPU tests, 313 fresh first imports and
2,186 structural gates. Browser checks cover stable preview slots, display-only palette
switches, photo alignment, saving and platform indicators. Typecheck, lint and production
build pass; lint retains four existing warnings. Full test suite was not requested/run.

Development integration also verifies native cache HTML writes/removal trigger zero editor
reloads. Static-only preload exposes a shared unload lifecycle without advertising Syphon,
NDI, Spout or native video input/output; video capability detection and its affected hooks
are covered by 63 focused native-video tests. The final dialog geometry check also passes
at an 820-pixel-wide viewport with no horizontal overflow.


## Higher resolutions and EXR artifacts (2026-10-10)

Additional square inputs ran serially on the same M3 Max/36 GiB machine and verified
finite float32 output. All five offered sizes share the same quantized bundle.

| Size | Inference | MLX peak | Result |
| --- | --- | --- | --- |
| 1280 square | 21.86 s | 19.45 GiB | Passed guarded scratch runner |
| 1536 square | 32.88 s | 21.75 GiB | Passed guarded scratch runner |
| 1536 square, production protocol | 35.38 s including load | 21.75 GiB | Passed, zero additional system swapouts |
| 2048 square | Aborted after 104.77 s | 26.94 GiB | Exceeded guarded resource budget; unavailable |

The scratch 1280 and 1536 runs coincided with approximately 1.95 GiB and 0.31 GiB
of additional system swap respectively. The 2048 attempt coincided with approximately
5.11 GiB. These are system-wide observations, not per-process attribution. Scratch
2048 shutdown originally used `exit` while GPU work was live and faulted during teardown;
the production watchdog uses `Darwin._exit(1)` after its bounded diagnostic.

MLX `memoryLimit` is a **soft scheduling threshold**, not a hard allocation cap.
Production now sets it to 24 GiB, with a separate 100 ms watchdog observing active and
peak allocations. Active above 24 GiB or peak above 26 GiB aborts the job explicitly;
the interval can observe an overshoot. Unsupported 2048 is not offered or silently resized.

Canonical artifacts now use `.loom.exr`, ordinary FLOAT32 OpenEXR with Loom metadata.
Independent OpenEXR 3.5.2 readback preserved the exact IEEE-754 bits, including signed
zero and subnormal samples. Its separately written ZIP/ZIPS scalar fixtures also decoded
bit-for-bit through Loom. The proprietary container and reader are removed. Preparation
retains actual native file hashes, so external EXR attributes do not break parent identity.
