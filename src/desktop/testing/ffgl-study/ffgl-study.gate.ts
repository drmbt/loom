/**
 * VN91: the harness kept as the regression gate for the native path (b). Every reference case
 * runs twice on fresh instances; every claim must hold and every run must repeat byte for byte.
 * The Resolume oracle never runs here: it is opt-in (LOOM_FFGL_ORACLE=1, cli.ts).
 *
 *   tools/heavy.sh pnpm desktop:ffgl-study
 */
import test from "node:test";
import assert from "node:assert/strict";
import { REFERENCE_CASES } from "./cases.ts";
import { createNativeBackend } from "./native-backend.ts";
import { runCase } from "./study.ts";
import { runStudy } from "./cli.ts";

const backend = createNativeBackend();
const size = { width: 640, height: 360 };

for (const study of REFERENCE_CASES) {
  test(`native: ${study.id} (${study.plugin}) meets its claims and repeats exactly`, async () => {
    const status = await backend.available();
    assert.ok(status.ok, status.ok ? "" : status.reason);
    const record = await runCase(backend, study, size, 2);
    for (const claim of record.claims) assert.ok(claim.ok, `${study.id}: ${claim.claim}${claim.detail ? ` (${claim.detail})` : ""}`);
    assert.equal(record.clock, "host");
    assert.ok(record.deterministic, `${study.id}: two fresh runs differ`);
  });
}

test("the Resolume oracle is opt-in and never part of the default suite", async () => {
  const previous = process.env["LOOM_FFGL_ORACLE"];
  delete process.env["LOOM_FFGL_ORACLE"];
  try {
    await assert.rejects(runStudy({ backends: ["resolume"], size, cost: false }), /LOOM_FFGL_ORACLE=1/);
    await assert.rejects(runStudy({ backends: ["wasm"], size, cost: false }), /VN84/);
  } finally { if (previous !== undefined) process.env["LOOM_FFGL_ORACLE"] = previous; }
});
