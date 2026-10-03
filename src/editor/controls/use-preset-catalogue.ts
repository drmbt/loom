import { useEffect, useState } from "react";
import type { LoomBus } from "@domain/commands/bus.ts";
import { presetCatalogueHolderFor, type BankCatalogue } from "@domain/presets/bank-view.ts";

/**
 * T1541b — THE COMPONENT CATALOGUE A BOARD SURFACE READS A LOOK'S BANK THROUGH, re-read
 * when it changes.
 *
 * A look's presets live in its component (§T1505b), so a Store or Delete on an instance —
 * or an edit inside the component that adds or removes its page bank — changes the
 * catalogue and leaves the document alone. A surface that re-renders only on the document
 * would keep the strip it drew before: the inspector and the phone already re-read on the
 * catalogue (§T1505b); the desk's Panel strip and the "+ panel" offer re-read through
 * this. `undefined` on a bus with no catalogue attached, where no instance is a bank.
 */
export function usePresetCatalogue(bus: LoomBus): BankCatalogue | undefined {
  const components = presetCatalogueHolderFor(bus).current?.components;
  const [, changed] = useState(0);
  useEffect(() => components?.subscribe(() => changed((count) => count + 1)), [components]);
  return components;
}
