# Complete encoding comparison

Every CPU row uses **median µs per draw**, matching parent PR #493, plus the corresponding
**ms per frame**. A trial averages 60 timed frames (1,000 for the single-draw control);
the table takes the median across independent paired process/page trials. This is not
a median of individual draw-call stopwatch samples.

`ms/frame = median µs/draw × actual total draws/frame ÷ 1,000`. Savings here are the
difference of the two displayed medians, so the columns are arithmetically consistent.
Paired percentage intervals are a separate statistic in the analysis JSON. Earlier
results remain as distinct batches; they are not pooled with the quiet rerun.

The baseline already includes #493. Same metric and workload shape do not make absolute
times interchangeable across different revisions, machines, mock, Node and browser.
The video-contended batch is excluded and remains archived locally.

## Node/Dawn: CPU encoding

| Batch | Workload | Draws/frame | Median µs/draw: baseline → optimized | CPU saved ms/frame | CPU saved % |
| --- | --- | ---: | ---: | ---: | ---: |
| Original, 7 pairs | Different drawables / same pipeline | 6,000 | 4.037 → 3.889 | +0.889 | 3.7% |
| Original, 7 pairs | Repeated drawable / same pipeline | 6,000 | 2.587 → 2.311 | +1.651 | 10.6% |
| Original, 7 pairs | Alternating pipelines | 6,000 | 2.864 → 2.875 | -0.065 | -0.4% |
| Original, 7 pairs | One draw/pass | 1 | 47.357 → 46.842 | +0.001 | 1.1% |
| Count matrix, 15 pairs | Different drawables / same pipeline | 150 | 4.029 → 3.747 | +0.042 | 7.0% |
| Count matrix, 15 pairs | Repeated drawable / same pipeline | 150 | 3.394 → 3.084 | +0.047 | 9.1% |
| Count matrix, 15 pairs | Alternating pipelines | 150 | 3.704 → 3.722 | -0.003 | -0.5% |
| Count matrix, 15 pairs | Different drawables / same pipeline | 750 | 3.261 → 2.941 | +0.241 | 9.8% |
| Count matrix, 15 pairs | Repeated drawable / same pipeline | 750 | 2.734 → 2.445 | +0.216 | 10.6% |
| Count matrix, 15 pairs | Alternating pipelines | 750 | 3.217 → 3.183 | +0.025 | 1.0% |
| Count matrix, 15 pairs | Different drawables / same pipeline | 6,000 | 4.337 → 4.133 | +1.222 | 4.7% |
| Count matrix, 15 pairs | Repeated drawable / same pipeline | 6,000 | 2.890 → 2.627 | +1.580 | 9.1% |
| Count matrix, 15 pairs | Alternating pipelines | 6,000 | 3.158 → 3.166 | -0.051 | -0.3% |
| Count matrix, 15 pairs | One draw/pass | 1 | 74.544 → 69.970 | +0.005 | 6.1% |
| Quiet rerun, 15 pairs | Different drawables / same pipeline | 5,000 | 3.583 → 3.228 | +1.774 | 9.9% |
| Quiet rerun, 15 pairs | Repeated drawable / same pipeline | 5,000 | 2.558 → 2.268 | +1.448 | 11.3% |
| Quiet rerun, 15 pairs | Alternating pipelines | 5,000 | 2.839 → 2.855 | -0.081 | -0.6% |
| Quiet rerun, 15 pairs | Different drawables / same pipeline | 6,000 | 3.673 → 3.358 | +1.886 | 8.6% |
| Quiet rerun, 15 pairs | Repeated drawable / same pipeline | 6,000 | 2.569 → 2.261 | +1.846 | 12.0% |
| Quiet rerun, 15 pairs | Alternating pipelines | 6,000 | 2.853 → 2.855 | -0.008 | -0.0% |
| Quiet rerun, 15 pairs | Different drawables / same pipeline | 10,000 | 4.016 → 3.648 | +3.682 | 9.2% |
| Quiet rerun, 15 pairs | Repeated drawable / same pipeline | 10,000 | 2.534 → 2.233 | +3.008 | 11.9% |
| Quiet rerun, 15 pairs | Alternating pipelines | 10,000 | 2.842 → 2.841 | +0.011 | 0.0% |

## Mock: CPU encoding

| Batch | Workload | Draws/frame | Median µs/draw: baseline → optimized | CPU saved ms/frame | CPU saved % |
| --- | --- | ---: | ---: | ---: | ---: |
| Original, 7 pairs | Different drawables / same pipeline | 6,000 | 0.753 → 0.736 | +0.105 | 2.3% |
| Original, 7 pairs | Repeated drawable / same pipeline | 6,000 | 0.323 → 0.328 | -0.029 | -1.5% |
| Original, 7 pairs | Alternating pipelines | 6,000 | 0.361 → 0.355 | +0.035 | 1.6% |
| Original, 7 pairs | One draw/pass | 1 | 6.720 → 6.491 | +0.000 | 3.4% |
| Count matrix, 15 pairs | Different drawables / same pipeline | 150 | 1.347 → 1.312 | +0.005 | 2.6% |
| Count matrix, 15 pairs | Repeated drawable / same pipeline | 150 | 0.986 → 1.039 | -0.008 | -5.5% |
| Count matrix, 15 pairs | Alternating pipelines | 150 | 1.019 → 1.081 | -0.009 | -6.1% |
| Count matrix, 15 pairs | Different drawables / same pipeline | 750 | 0.597 → 0.592 | +0.004 | 0.9% |
| Count matrix, 15 pairs | Repeated drawable / same pipeline | 750 | 0.347 → 0.346 | +0.001 | 0.3% |
| Count matrix, 15 pairs | Alternating pipelines | 750 | 0.377 → 0.386 | -0.007 | -2.4% |
| Count matrix, 15 pairs | Different drawables / same pipeline | 6,000 | 0.814 → 0.829 | -0.089 | -1.8% |
| Count matrix, 15 pairs | Repeated drawable / same pipeline | 6,000 | 0.323 → 0.329 | -0.035 | -1.8% |
| Count matrix, 15 pairs | Alternating pipelines | 6,000 | 0.358 → 0.362 | -0.029 | -1.4% |
| Count matrix, 15 pairs | One draw/pass | 1 | 6.702 → 6.771 | -0.000 | -1.0% |

## Chromium: CPU encoding

| Batch | Workload | Draws/frame | Median µs/draw: baseline → optimized | CPU saved ms/frame | CPU saved % |
| --- | --- | ---: | ---: | ---: | ---: |
| Quiet rerun, 15 pairs | Different drawables / same pipeline | 5,000 | 0.651 → 0.638 | +0.068 | 2.1% |
| Quiet rerun, 15 pairs | Repeated drawable / same pipeline | 5,000 | 0.433 → 0.410 | +0.115 | 5.3% |
| Quiet rerun, 15 pairs | Alternating pipelines | 5,000 | 0.452 → 0.458 | -0.030 | -1.3% |
| Quiet rerun, 15 pairs | Different drawables / same pipeline | 6,000 | 0.739 → 0.729 | +0.060 | 1.4% |
| Quiet rerun, 15 pairs | Repeated drawable / same pipeline | 6,000 | 0.425 → 0.402 | +0.136 | 5.3% |
| Quiet rerun, 15 pairs | Alternating pipelines | 6,000 | 0.448 → 0.448 | +0.002 | 0.1% |
| Quiet rerun, 15 pairs | Different drawables / same pipeline | 10,000 | 0.868 → 0.863 | +0.043 | 0.5% |
| Quiet rerun, 15 pairs | Repeated drawable / same pipeline | 10,000 | 0.421 → 0.408 | +0.135 | 3.2% |
| Quiet rerun, 15 pairs | Alternating pipelines | 10,000 | 0.452 → 0.457 | -0.051 | -1.1% |

## Chromium: GPU pass time

Separate GPU timestamp measurements; quantization and variance limit conclusions.

| Workload | Draws/frame | GPU ms/frame: baseline → optimized | GPU saved ms/frame | GPU saved % |
| --- | ---: | ---: | ---: | ---: |
| Different drawables / same pipeline | 5,000 | 1.567 → 1.567 | +0.000 | 0.0% |
| Repeated drawable / same pipeline | 5,000 | 1.064 → 1.018 | +0.046 | 4.3% |
| Alternating pipelines | 5,000 | 1.121 → 1.098 | +0.023 | 2.0% |
| Different drawables / same pipeline | 6,000 | 1.709 → 1.729 | -0.020 | -1.2% |
| Repeated drawable / same pipeline | 6,000 | 1.298 → 1.207 | +0.091 | 7.0% |
| Alternating pipelines | 6,000 | 1.343 → 1.387 | -0.044 | -3.3% |
| Different drawables / same pipeline | 10,000 | 2.313 → 1.507 | +0.806 | 34.8% |
| Repeated drawable / same pipeline | 10,000 | 2.502 → 2.344 | +0.158 | 6.3% |
| Alternating pipelines | 10,000 | 1.626 → 1.491 | +0.135 | 8.3% |
