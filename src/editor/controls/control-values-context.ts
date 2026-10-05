import { createContext } from "react";
import type { NodeId } from "@domain/types/ids.ts";

/** The existing value graph's resolved parameters, sampled by each driven widget. */
export interface ControlValuesReader {
  read(nodeId: NodeId): Readonly<Record<string, unknown>>;
}

export const ControlValuesContext = createContext<ControlValuesReader | null>(null);
