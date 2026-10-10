# Marigold V2 native preparation notices

Loom's local Marigold V2 depth preparation uses the separately licensed components below. Model weights download explicitly; the bundle omits the text encoder and does not substitute Marigold v1.1. Exact pins, lengths and hashes appear in [the verification report](marigold-v2-mlx-verification-2026-10-09.md).

## Apache-2.0 model and implementation sources

| Component | Attribution/source | License/notice |
| --- | --- | --- |
| Native Swift port | Hiroaki Yamane; [source](https://github.com/mnmly/mlx-swift-marigold-v2/tree/f831354b69b2c683757bed567bf1395ceb826eb6) | [LICENSE](https://github.com/mnmly/mlx-swift-marigold-v2/blob/f831354b69b2c683757bed567bf1395ceb826eb6/LICENSE), [original NOTICE](https://github.com/mnmly/mlx-swift-marigold-v2/blob/f831354b69b2c683757bed567bf1395ceb826eb6/NOTICE) |
| Marigold V2 | Huawei Technologies Co., Ltd.; [implementation](https://github.com/huawei-bayerlab/marigold-v2) and [released checkpoint](https://huggingface.co/huawei-bayerlab/marigold-v2-0/tree/cdf9810fb690886391a63aec012b5f501064fb0d) | [Implementation LICENSE](https://github.com/huawei-bayerlab/marigold-v2/blob/main/LICENSE), [NOTICE](https://github.com/huawei-bayerlab/marigold-v2/blob/main/NOTICE), [checkpoint LICENSE](https://huggingface.co/huawei-bayerlab/marigold-v2-0/blob/cdf9810fb690886391a63aec012b5f501064fb0d/LICENSE) |
| Qwen-Image-Edit-2509 | Qwen team; [original model card/license declaration](https://huggingface.co/Qwen/Qwen-Image-Edit-2509/blob/d3968ef930e841f4c73640fb8afa3b306a78167e/README.md) | Apache-2.0, declared by the original model card |
| Mixed MLX 4/8-bit conversion | AbstractFramework / @lpalbou; [conversion model card](https://huggingface.co/AbstractFramework/qwen-image-edit-2509-4bit/blob/4af31392d562331651822afe6241daa09e87bbd1/README.md) | [LICENSE.md](https://huggingface.co/AbstractFramework/qwen-image-edit-2509-4bit/blob/4af31392d562331651822afe6241daa09e87bbd1/LICENSE.md) |

MLX-Gen 0.18.2 generated the conversion. Its model card attributes MLX-Gen to MFlux by Filip Strand and the original MFlux contributors. This is an MLX saved-weight layout, not a diffusers `from_pretrained` checkpoint. Loom loads the weights through an audited mapping without vendoring the MLX-Gen Python runtime.

## Retained upstream native-port NOTICE

The original port's NOTICE is retained verbatim:

```text
mlx-swift-marigold-v2
Copyright 2026 Hiroaki Yamane

A Swift / mlx-swift port of Marigold V2 (https://github.com/huawei-bayerlab/marigold-v2),
Copyright 2026 Huawei Technologies Co., Ltd., licensed under the Apache License, Version 2.0.
Marigold V2 in turn includes code derived from Marigold (https://github.com/prs-eth/Marigold),
Copyright 2023-2025 Marigold Team, ETH Zürich, licensed under the Apache License, Version 2.0.

The Qwen-Image transformer and VAE implementations follow Hugging Face diffusers
(https://github.com/huggingface/diffusers), Copyright The HuggingFace Team, licensed under
the Apache License, Version 2.0.

The Spectral colormap table (Sources/MLXMarigoldV2/SpectralLUT.swift) is sampled from
matplotlib's "Spectral", which is based on ColorBrewer (https://colorbrewer2.org),
Copyright Cynthia Brewer, Mark Harrower and The Pennsylvania State University, licensed
under the Apache License, Version 2.0.

No model weights are included. Qwen-Image-Edit-2509 and the Marigold V2 checkpoints carry
their own licenses; check them before redistributing weights or outputs.
```

Loom modifications dated 2026-10-09 add packed MLX affine 4/8-bit linear execution, audited conversion-key mapping, strict quantized tensor validation, restoration of the original Qwen output bias, and a bounded native photo-preparation worker. Runtime LoRA and the trained decoder/prompt topology remain identified as Marigold V2. The original source LICENSE and NOTICE remain with the downloaded source.

## Native runtime dependencies

| Dependency | Pinned source | License |
| --- | --- | --- |
| MLX Swift | [ml-explore/mlx-swift at `ea8a179`](https://github.com/ml-explore/mlx-swift/tree/ea8a179690170ca891a97bc0473198ab1ecda5f4) | [MIT; Copyright (c) 2023 ml-explore](https://github.com/ml-explore/mlx-swift/blob/ea8a179690170ca891a97bc0473198ab1ecda5f4/LICENSE) |
| MLX C | [ml-explore/mlx-c at `c74db53`](https://github.com/ml-explore/mlx-c/tree/c74db5307cc8ce122f48d97ef951b30578674e7f) | [MIT; Copyright (c) 2023 ml-explore](https://github.com/ml-explore/mlx-c/blob/c74db5307cc8ce122f48d97ef951b30578674e7f/LICENSE) |
| MLX core | [ml-explore/mlx at `1f8e74e`](https://github.com/ml-explore/mlx/tree/1f8e74e3f12f31365464a6867c6579f0e9b29d85) | [MIT; Copyright © 2023 Apple Inc.](https://github.com/ml-explore/mlx/blob/1f8e74e3f12f31365464a6867c6579f0e9b29d85/LICENSE) |
| Swift Numerics | [apple/swift-numerics at `0c0290f`](https://github.com/apple/swift-numerics/tree/0c0290ff6b24942dadb83a929ffaaa1481df04a2) | [Apache-2.0 with Runtime Library Exception](https://github.com/apple/swift-numerics/blob/0c0290ff6b24942dadb83a929ffaaa1481df04a2/LICENSE.txt) |

This attribution index does not replace complete component licenses or original notices distributed with their sources/assets.
