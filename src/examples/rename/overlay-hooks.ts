import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Lets a build run against REWRITTEN source without the rewrite being on disk in the tree
 * (T1593b phase 2a).
 *
 *   LOOM_SOURCE_OVERLAY=<dir> node --import ./src/tooling/alias-hooks.ts \
 *     --import ./src/examples/rename/overlay-hooks.ts src/examples/build-examples.ts --out <dir>/built
 *
 * A module under the repository whose path also exists under `<dir>` is loaded with the
 * text found there. Its URL does not change, so its own imports resolve as they always
 * did; only its bytes are different. That is how the apply tool's dry run builds every
 * example from sources it has not written and compares the result with what it expected.
 *
 * Without the variable this registers nothing.
 */
const overlay = process.env["LOOM_SOURCE_OVERLAY"];
const root = fileURLToPath(new URL("../../../", import.meta.url));

if (overlay !== undefined && overlay !== "") {
  registerHooks({
    load(url, context, next) {
      if (url.startsWith("file:")) {
        const inside = relative(root, fileURLToPath(url));
        const replaced = join(overlay, inside);
        if (!inside.startsWith("..") && existsSync(replaced)) {
          return { format: "module-typescript", source: readFileSync(replaced, "utf8"), shortCircuit: true };
        }
      }
      return next(url, context);
    },
  });
}
