import { useEffect, useReducer, useState, useSyncExternalStore } from "react";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { ComponentRegistryView } from "@domain/components/registry.ts";
import type { GraphComponentDefinition } from "@domain/types/components.ts";
import type { RetainedFileSnapshot } from "@ui/files/retained-files.ts";
import { readComponentInstance } from "@domain/components/instance.ts";
import { availableUpgrade } from "@domain/components/upgrade.ts";
import { collectComponentDependencies, externalFiles, type ExternalFile } from "@domain/components/component-file.ts";
import { retainedFiles } from "@ui/files/retained-files.ts";
import { AssetField } from "@ui/controls/curve-field.tsx";
import { parseFileReference } from "@domain/media/file-reference.ts";
import { Button } from "@ui/primitives/button.tsx";
import { ControlRow } from "@ui/controls/control-row.tsx";
import styles from "./inspector.module.css";

/**
 * T1065 — the component INSTANCE's session controls, in the one inspector every node
 * already has (§T948's rule, the Laser section's precedent).
 *
 * This replaces `ComponentInspector`, a 212-line pane that was never mounted anywhere
 * in the product — it was the ONLY human door to `component.detach`, so an agent could
 * detach an instance and a human could not, while its sibling `component.upgradeInstance`
 * had a door in the library. §V220's dominant shape (built, tested, never wired), on a
 * whole pane. Everything else that pane promised the generic inspector already does
 * structurally: the parameter PAGE is the synthesized manifest's own parameters (§V80
 * by construction), values write through the same editor as every node (§V29), and the
 * boundary shows as the instance's ports.
 *
 * What actually needs a component-specific surface is exactly what lives here:
 *
 *  - the PINNED VERSION, stated (§V84 — a newer definition never moves an instance);
 *  - UPGRADE, offered only when a newer version is installed, never taken on its own;
 *  - ENTER, the same `graph.diveIn` the double-click and `i` run (§V78: one command);
 *  - DETACH, the explicit opt-out of linked editing — labelled with what it does,
 *    because "detach" alone reads as removal, and it is the opposite: the instance
 *    becomes an editable copy and stops following the definition;
 *  - FILES (T1519b): every retained file inside the component (nested ones too) that
 *    does not open in this browser, with RELINK — the handle is stored under the
 *    reference's own identity, so the definition is not edited and the document's
 *    revision does not move. Before this the one route to a relink was entering the
 *    component, where the field's pick writes the definition.
 */

export interface ComponentSectionProps {
  readonly bus: LoomBus;
  readonly context: InvocationContext;
  readonly nodeId: NodeId;
  readonly components: ComponentRegistryView;
}

/** T994's claim: this section presents controls for NO parameter keys. */
// eslint-disable-next-line react-refresh/only-export-components -- T994: the claim lives WITH the section it mirrors.
export function componentSectionParameters(): readonly string[] {
  return [];
}

export function ComponentSection({ bus, context, nodeId, components }: ComponentSectionProps) {
  // §V79: re-authoring a definition changes what an instance resolves against with
  // nothing to invalidate — this subscription is what makes the version line follow.
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => components.subscribe(bump), [components]);
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const graph = useSyncExternalStore(bus.store.subscribe, bus.store.getGraph, bus.store.getGraph);
  const files = retainedFiles();
  useSyncExternalStore(files.subscribe, files.revision, files.revision);
  const node = graph.nodes[nodeId];
  const state = node === undefined ? null : readComponentInstance(node);
  if (state === null) return null;
  const definition = components.get(state.componentId, state.version);
  const upgrade = node === undefined ? null : availableUpgrade(node, components);
  const unopened = definition === undefined ? [] : unopenedFiles(definition, components, files.snapshot);

  const run = (command: "component.upgradeInstance" | "component.detach") => {
    setBusy(true);
    void bus
      .execute(command, { nodeId }, context)
      .then((outcome) => {
        setRefused(
          outcome.status === "applied"
            ? null
            : (outcome.diagnostics.map((entry) => entry.message).join(" ") || outcome.status),
        );
      })
      .finally(() => setBusy(false));
  };

  return (
    <section className={styles.section} aria-label="Component">
      <div className={styles.sectionHeader}>
        <span>Component</span>
        <span className={styles.sectionRule} aria-hidden />
      </div>

      <div className={styles.statusLine} role="status">
        {definition === undefined
          ? /* §V10: an instance of an uninstalled definition stays inspectable and SAYS
               what it is pinned to, rather than going blank — the values it carries are
               the user's and must not read as lost. */
            `${state.componentId} v${String(state.version)} — this component is not installed here; the instance keeps its values and renders nothing.`
          : `${definition.name} v${String(state.version)}${upgrade === null ? "" : ` — v${String(upgrade.latestVersion)} is installed`}`}
      </div>
      {refused === null ? null : (
        <span className={styles.statusHint} role="alert">
          {refused}
        </span>
      )}

      {upgrade === null ? null : (
        <ControlRow label="Upgrade">
          {/* §V84: offered, NEVER automatic — the pinned version is a promise to the
              saved document, and only this click moves it (migrated, with warnings). */}
          <Button variant="outline" disabled={busy} onClick={() => run("component.upgradeInstance")}>
            Upgrade to v{String(upgrade.latestVersion)}
          </Button>
        </ControlRow>
      )}

      <ControlRow label="Instance">
        <Button
          variant="outline"
          disabled={busy || definition === undefined}
          onClick={() => {
            void bus.execute("graph.diveIn", { nodeId }, context).then((outcome) => {
              if (outcome.status !== "applied") {
                setRefused(outcome.diagnostics.map((entry) => entry.message).join(" ") || outcome.status);
              }
            });
          }}
        >
          Enter
        </Button>
        <Button variant="outline" disabled={busy || definition === undefined} onClick={() => run("component.detach")}>
          Detach — make an editable copy
        </Button>
      </ControlRow>

      {unopened.map((file) => (
        <ControlRow key={`${file.componentName ?? ""}/${file.nodeName}/${file.uri}`} label="File">
          <AssetField
            label={`"${file.fileName}" on "${file.nodeName}" in "${file.componentName ?? ""}"`}
            value={file.uri}
            kind={parseFileReference(file.uri)?.kind ?? "binary"}
            relinkOnly
          />
        </ControlRow>
      ))}
    </section>
  );
}

/**
 * T1519b: the retained files inside `definition` and every component it nests that do not
 * open here (missing, unreadable, or waiting for access). Read from the definitions, which
 * is what an instance's internals are; the flattened graph's lease keeps each one resolved.
 */
function unopenedFiles(
  definition: GraphComponentDefinition,
  components: ComponentRegistryView,
  snapshot: (reference: string) => RetainedFileSnapshot,
): ExternalFile[] {
  const collected = collectComponentDependencies(definition, components);
  const carried = collected.ok ? collected.definitions : [definition];
  return carried
    .flatMap((each) => externalFiles(each.graph, each.name))
    .filter((file) => {
      const status = snapshot(file.uri).kind;
      return status === "missing" || status === "error" || status === "permission";
    });
}
