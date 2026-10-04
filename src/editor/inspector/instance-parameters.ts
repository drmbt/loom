import type { LoomBus } from "@domain/commands/bus.ts";
import type { FlatGraph, GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { ChannelWriteTarget, ParameterWriteTarget } from "./parameter-editor.ts";

/** Instance-effective reads and published ownership; no copy enters the authoring store. */
export interface InstanceParameters {
  readonly bus: LoomBus;
  read(nodeId: NodeId): { readonly graph: FlatGraph; readonly node: GraphNode } | undefined;
  target(nodeId: NodeId, key: string): ParameterWriteTarget | undefined;
  channelTarget?(nodeId: NodeId): ChannelWriteTarget;
}
