## Summary

After #493, unchanged draws still call native `setPipeline` on every draw. This prototype skips consecutive identical pipeline bindings within an owned render pass. New passes and bundle execution clear the cached state. Other draw state and validation are unchanged.

## CPU encoding

Different drawables sharing one pipeline; three passes/frame. Apple M3 Max, Node 22.23.3 and headed Google Chrome 154.0.8037.98 using a real Metal adapter. Baseline: canary `9c23f6c0`, after #493. Median µs/draw matches #493’s metric.

**Node/Dawn**

| Draws/frame | Median µs/draw: baseline → optimized | Saved ms/frame | Saved % |
| ---: | ---: | ---: | ---: |
| 250 | 3.571 → 3.232 | +0.085 | +9.5% |
| 2,500 | 3.359 → 3.040 | +0.799 | +9.5% |
| 5,000 | 3.583 → 3.228 | +1.774 | +9.9% |
| 10,000 | 4.016 → 3.648 | +3.682 | +9.2% |

**Headed Chrome**

| Draws/frame | Median µs/draw: baseline → optimized | Saved ms/frame | Saved % |
| ---: | ---: | ---: | ---: |
| 250 | 0.831 → 0.810 | +0.005 | +2.4% |
| 2,500 | 0.697 → 0.700 | -0.005 | -0.3% |
| 5,000 | 0.822 → 0.792 | +0.148 | +3.6% |
| 10,000 | 0.874 → 0.856 | +0.176 | +2.0% |

## Headed Chrome GPU pass time

Separate timestamp measurements, excluding gaps/readback:

| Draws/frame | GPU ms/frame: baseline → optimized | Saved ms/frame | Saved % |
| ---: | ---: | ---: | ---: |
| 250 | 0.133 → 0.133 | +0.000 | +0.0% |
| 2,500 | 0.814 → 0.779 | +0.035 | +4.3% |
| 5,000 | 1.575 → 1.578 | -0.003 | -0.2% |
| 10,000 | 2.367 → 2.099 | +0.268 | +11.3% |

15 alternating paired trials per workload after warm-up; all samples retained. Setup, completion and readback are outside CPU encoding. The 8×8 offscreen workload measures draw overhead, not application frame rate. Node CPU gains are stronger; Chrome’s GPU difference is larger at 10k, but the 5k result is flat and does not establish a cutoff. Frequent pipeline switches can add a small cost.

## Validation

Eight focused tests, three Dawn pixel tests and a browser binding/pixel audit pass. Build and hard client bundle budgets pass without raising limits. One Node/mock reproduction script is included.

## PR type

contribution

Draft proposal; this type follows the external-contribution guide and is rejected by the current validator during policy rollout.
