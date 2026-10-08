import type {
  Actor,
  AppCommandBus,
  CapabilityClass,
  CommandInput,
  CommandName,
  CommandOutput,
  CommandResult,
  CommandStatus,
  InvocationContext,
  QueryInput,
  QueryName,
  QueryOutput,
} from "../types/commands.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { FrameClock, FrameEvaluationInput } from "../types/frame.ts";
import { authoredGraph, type FlatGraph, type GraphDocument, type ProjectSettings } from "../types/graph.ts";
import type { ChannelResolver } from "../parameters/resolve.ts";
import { NO_FLATTENING, type FlatteningReads, type ParameterReadContext } from "../parameters/node-references.ts";
import type { Revision } from "../types/ids.ts";
import { isComponentInstance } from "../components/instance.ts";
import { isNodePath } from "../components/addressing.ts";
import { keyReads } from "../graph/parameter-dependencies.ts";
import { channelDependenciesOf, referenceCyclesThrough } from "../graph/reference-cycles.ts";
import type { IdFactory } from "../graph/ids.ts";
import type { GraphStore, GraphStoreView, HistoryOutcome } from "../graph/store.ts";
import { createCapabilityGrantStore, type CapabilityGrantStore } from "./grants.ts";
import {
  inputRefusal,
  isAnyInput,
  rewriteNodeAddresses,
  stringLeavesOf,
  type AnyInput,
  type CommandInputSchema,
  type InputKeysCovered,
} from "./input-schema.ts";
import { fromInstance, toInstance, type InstancePath } from "../components/addressing.ts";
import { createGraphStore } from "../graph/store.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";

/**
 * The application command bus (§I.bus, T50).
 *
 * Every mutation in the product goes through `execute` — toolbar, keybind, inspector
 * edit, drag-connect, tests and every agent adapter alike (§V29). Adapters (WebMCP, an
 * MCP server, the future collab layer) are transport and schema only: they add commands
 * by declaration-merging `CommandMap`, never by forking this interface (§V39).
 *
 * Registering a command from another module:
 *
 * ```ts
 * declare module "@domain/types/commands.ts" {
 *   interface CommandMap {
 *     "node.setOutput": { input: { nodeId: NodeId }; output: { ok: boolean } };
 *   }
 * }
 *
 * bus.registerCommand({
 *   name: "node.setOutput",
 *   inputSchema: z.object({ nodeId: z.string().min(1) }).strict(),
 *   handler: (input, ctx) => {
 *     const applied = ctx.apply({ label: "Set output", recipe: (draft) => { ... } });
 *     return { status: "applied", output: { ok: true }, revision: applied.revision };
 *   },
 * });
 * ```
 *
 * A handler never touches the store directly. `ctx.apply` is the only mutation
 * primitive, and it is what stamps the actor, bumps the revision, writes the audit
 * entry and opens the undo group — so §V30, §V31 and §V34 hold for commands nobody has
 * written yet.
 */

export interface ApplyRequest {
  /** Human-readable label for the undo entry and the history UI. */
  label: string;
  recipe: (draft: GraphDocument) => void;
  /** Start a new undo group even inside a transaction (§V34). */
  splitUndo?: boolean;
}

export interface ApplySettingsRequest {
  /** Human-readable label for the undo entry, TD-style: "Set frame rate" (§V177). */
  label: string;
  /** A PARTIAL patch — absent fields keep their current value (T272). */
  patch: Partial<ProjectSettings>;
  splitUndo?: boolean;
}

/** §T1546b: an undo step that changes no graph entity (`GraphStoreInternals.applyStep`). */
export interface ApplyStepRequest {
  label: string;
  splitUndo?: boolean;
}

export interface AppliedInfo {
  committed: boolean;
  changed: boolean;
  revision: Revision;
  undoGroupId: string | undefined;
}

/**
 * §T1695b — WHAT A COMMAND MEANS INSIDE A COMPONENT SESSION. Every registration says, and
 * that is a fact about the command, whichever bus it is registered on.
 *
 * A component's inside is edited through a bus of its own (`openComponentSession`), over the
 * definition's graph. That bus has a PARENT, the project's bus, and what it does with a
 * command it was asked for is this declaration:
 *
 *  - `"definition"`: the command edits the graph in hand. The session runs its OWN
 *    registration, on its own store and undo, and never the parent's: a graph edit that
 *    fell through would patch the project with the ids of a component's inside (§B286).
 *    A session that holds no copy does not offer the command.
 *  - `"instance"`: the command acts on state of a running instance, which lives in the
 *    project's plan under flattened ids. The session holds no copy. It rewrites every node
 *    address of the input (`nodeIdInput`, derived from the schema) onto the instance the
 *    editor is viewing, executes on the parent, and maps the result's node ids back. With
 *    no instance in view it refuses by name.
 *  - `"app"`: the command names no node of a document (the transport, a file, a panel, the
 *    canvas camera). The session holds no copy and executes on the parent, input unchanged.
 *  - `{ definition: true, handsUp }`: a `definition` command whose handler may hand one
 *    call up through `context.session.handUp()`, for a call whose meaning depends on what
 *    it is aimed at. `handsUp` says when, in words (a page bank's recall belongs to an
 *    instance, an inner bank's to the definition).
 *
 * `docs/component-session-commands-design-2026-10-06.md` has the census behind the list and
 * why a declared refusal is not on it.
 */
export type InSession = "definition" | "instance" | "app" | { readonly definition: true; readonly handsUp: string };

export type InSessionKind = "definition" | "instance" | "app";

export function inSessionKind(declared: InSession): InSessionKind {
  return typeof declared === "string" ? declared : "definition";
}

/** What whoever opens a session bus knows, and the bus cannot: what it edits, and through which instance. */
export interface SessionScope {
  /** What is being edited, as a person would name it (`component "Bloom"`). For a refusal's sentence. */
  readonly subject: () => string;
  /**
   * The instance the editor is viewing the definition through, as the EDITOR's path
   * (`addressing.ts`), read at each call: one session outlives a move between two instances
   * of its component. Undefined when no instance is in view (a build script, a library
   * editor): an `instance` command then refuses by name.
   */
  readonly instancePath: () => InstancePath | undefined;
}

export interface ReferenceCycleHost { readonly componentId: string; readonly version: number }
export type ReferenceCycleValidator = (graph: GraphDocument, nodeId: string, host?: ReferenceCycleHost) => RuntimeDiagnostic[];

/** `CommandContext.session`: what a handler on a session bus can ask of where it runs. */
export interface CommandSession {
  readonly instancePath: () => InstancePath | undefined;
  /**
   * Runs THIS call on the parent bus, as an inherited command would run: the input's node
   * addresses rewritten onto the instance in view when its schema declares any, unchanged
   * when it declares none. For a registration that declared `handsUp`. The outcome is the
   * parent's, with its diagnostics' node ids mapped back; when the parent applied a step
   * to the project, one `info` line says the step is the project's to undo.
   */
  readonly handUp: <TOutput>() => Promise<CommandOutcome<TOutput>>;
}

export interface CommandContext {
  readonly invocation: InvocationContext;
  readonly actor: Actor;
  /** True when the caller asked for validation only — `apply` will not commit (§V36). */
  readonly dryRun: boolean;
  readonly commandName: string;
  /** Document snapshot taken when the command was invoked. */
  readonly graph: GraphDocument;
  readonly registry: NodeRegistryView;
  readonly store: GraphStoreView;
  readonly ids: IdFactory;
  /**
   * Whether the INVOKING actor holds a capability (T315, §V38).
   *
   * Bound to `actor`, so a handler can ask what the caller may do and cannot ask about
   * anyone else. Deliberately not the grant store itself: a handler must be able to READ
   * an authorization and must never be able to write one — "calling a tool never grants a
   * capability" is only structural if the granting API is out of reach here.
   *
   * `requiredCapabilities` on the registration covers a command that is wholly gated.
   * This exists for the case it cannot express: `graph.applyPatch` carries a batch of
   * mixed operations (§V32) and exactly one of them, `setViewport`, needs a grant — a
   * command-level requirement would gate every graph edit there is, which §V38 explicitly
   * does not want.
   */
  readonly holds: (capability: CapabilityClass) => boolean;
  /** Scoped validation shared by every command that applies a graph patch. */
  readonly referenceCycles: (graph: GraphDocument, nodeId: string) => RuntimeDiagnostic[];
  /**
   * THE channel resolver the running app is resolving `driven` parameters through, or
   * `undefined` when no app is attached (T593, B121, B8, §V61, §V109).
   *
   * ## Why it arrives here rather than being built here
   *
   * A command that wanted channels could call `graphChannelResolver(graph, registry)` for
   * itself — it has both. That is precisely the move B8 forbids. The app's resolver is a
   * LADDER (`use-graph-compile.ts`): an Analyze's readback, then the value graph's CPU
   * signal chain, then the graph shorthand as the backstop. A rebuild inside the domain
   * would answer for the LFO/Constant/Timer trio and for nothing else, so
   * `mouse1 → lag1 → param` and `constant1 → math1 → param` would resolve one way for the
   * compiler and another way for the validator, on the same document, in the same tab.
   * `use-graph-compile.ts:50` states the rule this field exists to keep: THE TWO MUST NOT
   * BE TWO RESOLVERS.
   *
   * So it is the same object the plan was compiled from, published by whoever owns it
   * (`attachChannelResolver`) and read per invocation, never a merge of the same inputs.
   *
   * FRAMELESS on this side. A command is asked outside any frame, and the app's resolver
   * answers a no-frame read from a throwaway zero-frame session keyed on the document
   * revision — so validating cannot advance a stateful stage (a Lag must not move because
   * an agent asked whether the graph is valid).
   *
   * UNDEFINED IS A REAL ANSWER, and it means "no app": a headless bus, a test, an
   * out-of-process caller. §V338 — a consumer must report that as itself and never as
   * "the channel is not attached", which is a claim about the DOCUMENT.
   */
  readonly channels: ChannelResolver | undefined;
  /**
   * T1497b — THE ABSOLUTE CLOCK'S READING at the last frame the app's transport produced,
   * or `undefined` when no app is attached (or it has produced no frame yet).
   *
   * A preset recall stamps its morph record with this (`start`, `epoch`), and it arrives
   * here for the channel resolver's reason: every caller of a command — a Panel, the
   * phone, the keymap, a pulse, the cue list, an agent — must stamp the SAME moment, and
   * none of them should have to know there is a moment to stamp. It is also how §V44
   * holds on the command side: the handler reads the frame the transport already
   * produced, never `Date.now`.
   *
   * UNDEFINED IS A REAL ANSWER, as for `channels` (§V338): a headless bus has no
   * transport, and a morph requested there commits as a cut and says why.
   */
  readonly frameClock: FrameClock | undefined;
  /**
   * §T1557b — WHAT A PARAMETER READ AT THIS MOMENT IS MADE OF, every field filled: this
   * command's `graph` and `registry`, the frame the transport last produced, the app's
   * channel resolver (`channels`), and its flattening (the morphs in flight and the
   * instances `op('<instance>').chan.<c>` names). Hand it to `parameterReadOptions`.
   *
   * It exists because a command could not supply the frame, the morphs or the instances,
   * so the reads that wanted the live value (a recall's Select, Morph and Curve, a cue
   * list's position) passed `{ channels }` alone — §B181's shape: `op('x').chan.y` fell back
   * to the stored static while the plan animated. A read that wants the DOCUMENT instead —
   * locating a slot, seeding a mode — calls `resolveStored`, and says so.
   *
   * Attached by the composition root (`attachFlattenedGraph`, `attachFrame`, beside
   * `attachChannelResolver`); with nothing attached it is the frameless, flattening-free
   * scope a headless bus truthfully has (§V338).
   */
  readonly readScope: () => ParameterReadContext;
  /** The sole mutation primitive available to a handler (§V29). */
  apply: (request: ApplyRequest) => AppliedInfo;
  /**
   * The settings mutation primitive (T272, §V177).
   *
   * Separate from `apply` because settings are not a graph entity and a recipe over a
   * `GraphDocument` draft cannot reach them — not because there are two mutation paths.
   * Both land in the same `commit`: one revision, one audit entry, one undo group.
   */
  applySettings: (request: ApplySettingsRequest) => AppliedInfo;
  /**
   * §T1546b: an undo step with no graph change — a revision, an audit entry and a slot in
   * the actor's history, coalescing like `apply`. For an edit whose state lives OUTSIDE the
   * document and that its owner restores when the step is undone or redone: a component
   * session's publish, expose, reorder (`session.ts`). Unlike `audit`, Undo can reach it.
   */
  applyStep: (request: ApplyStepRequest) => AppliedInfo;
  /**
   * Records an APPLIED audit entry for a mutation that never touches the document
   * (T214, §V31, §V124).
   *
   * `apply` covers everything that edits the graph: it bumps the revision, opens the
   * undo group and writes the audit entry together, because for a document edit those
   * three are one event. A pulse is the case where they come apart — clearing a feedback
   * buffer changes what is on screen and changes nothing in the file, so there is no
   * revision to bump and nothing for undo to restore, and a recipe that mutated nothing
   * would have been recorded as "no change" and left no trace at all.
   *
   * §V31 says every mutation is audited, and "it was not a document edit" is not an
   * exemption — the audit ring is how a user (or an agent reading `graph.audit`) finds
   * out that something reset the loop they were watching.
   *
   * Rejections are NOT this function's business: the bus already writes those from the
   * outcome status, and calling both would log the same failure twice.
   */
  audit: () => void;
  /** Actor-local history, used by the undo/redo commands (§V41). */
  undoLast: () => HistoryOutcome;
  redoLast: () => HistoryOutcome;
  /** §T1695b: where this bus sits, when it is a component session's; undefined on the project's bus. */
  readonly session: CommandSession | undefined;
}

export interface CommandOutcome<TOutput> {
  /** `"validated"` = a dry run that passed: reported, not applied, not audited (§V36). */
  status: CommandStatus;
  output: TOutput;
  diagnostics?: RuntimeDiagnostic[];
  /** Defaults to the store revision after the handler ran. */
  revision?: Revision;
  undoGroupId?: string | undefined;
}

export type CommandHandler<TName extends CommandName> = (
  input: CommandInput<TName>,
  context: CommandContext,
) => CommandOutcome<CommandOutput<TName>> | Promise<CommandOutcome<CommandOutput<TName>>>;

export interface CommandRegistration<TName extends CommandName> {
  name: TName;
  /**
   * §T1556b — what input this command takes, parsed by `execute` before the handler runs,
   * so every door (menu, keymap, palette, phone, agent) gets the same refusal. REQUIRED: a
   * command cannot be registered without saying. `ANY_INPUT(reason)` is the named escape
   * for an input the bus genuinely cannot describe.
   */
  inputSchema: CommandInputSchema<TName> | AnyInput;
  /**
   * §T1695b — what this command means inside a component session (`InSession`). REQUIRED,
   * on the same ground as `inputSchema`: a command cannot be registered without saying.
   */
  inSession: InSession;
  handler: CommandHandler<TName>;
  /** Capability classes that must be granted before this command runs (§V38). */
  requiredCapabilities?: readonly CapabilityClass[];
  description?: string;
  /**
   * Builds the output value returned when the bus itself rejects the call (a missing
   * capability grant, input its schema refuses — T1556b). Without it the bus throws
   * instead, because it cannot invent a typed result.
   *
   * `input` is `unknown` because on an input refusal it is exactly what the schema refused.
   */
  rejectionOutput?: (
    input: unknown,
    diagnostics: RuntimeDiagnostic[],
    revision: Revision,
  ) => CommandOutput<TName>;
}

export type QueryHandler<TName extends QueryName> = (
  input: QueryInput<TName>,
  context: QueryContext,
) => QueryOutput<TName> | Promise<QueryOutput<TName>>;

export interface QueryContext {
  readonly invocation: InvocationContext;
  readonly actor: Actor;
  readonly graph: GraphDocument;
  readonly registry: NodeRegistryView;
  readonly store: GraphStoreView;
}

export interface QueryRegistration<TName extends QueryName> {
  name: TName;
  handler: QueryHandler<TName>;
  requiredCapabilities?: readonly CapabilityClass[];
  description?: string;
}

export class UnknownCommandError extends Error {
  constructor(name: string, why?: string) {
    super(why ?? `No command registered as "${name}".`);
    this.name = "UnknownCommandError";
  }
}

/**
 * §T1695b: a call the bus refused before any handler ran, for a command with no
 * `rejectionOutput` to answer with (the rule `InvalidCommandInputError` follows for input).
 */
export class CommandRefusedError extends Error {
  readonly diagnostics: readonly RuntimeDiagnostic[];

  constructor(diagnostics: readonly RuntimeDiagnostic[]) {
    super(diagnostics.map((diagnostic) => diagnostic.message).join(" "));
    this.name = "CommandRefusedError";
    this.diagnostics = diagnostics;
  }
}

export class UnknownQueryError extends Error {
  constructor(name: string) {
    super(`No query registered as "${name}".`);
    this.name = "UnknownQueryError";
  }
}

export class InvalidInvocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInvocationError";
  }
}

/**
 * §T1556b: input a command's schema refused, thrown when the command has no
 * `rejectionOutput` to answer with (the capability path's rule). The message is the
 * diagnostics' sentences, so a thrower and a returner say the same thing.
 */
export class InvalidCommandInputError extends Error {
  readonly diagnostics: readonly RuntimeDiagnostic[];

  constructor(diagnostics: readonly RuntimeDiagnostic[]) {
    super(diagnostics.map((diagnostic) => diagnostic.message).join(" "));
    this.name = "InvalidCommandInputError";
    this.diagnostics = diagnostics;
  }
}

export class CapabilityDeniedError extends Error {
  readonly missing: readonly CapabilityClass[];

  constructor(name: string, missing: readonly CapabilityClass[]) {
    super(`Command "${name}" requires ungranted capabilities: ${missing.join(", ")}.`);
    this.name = "CapabilityDeniedError";
    this.missing = missing;
  }
}

interface StoredCommand {
  name: string;
  inputSchema: CommandInputSchema<CommandName> | AnyInput;
  inSession: InSession;
  handler: (input: unknown, context: CommandContext) => unknown;
  requiredCapabilities: readonly CapabilityClass[];
  description: string | undefined;
  rejectionOutput:
    | ((input: unknown, diagnostics: RuntimeDiagnostic[], revision: Revision) => unknown)
    | undefined;
}

interface StoredQuery {
  name: string;
  handler: (input: unknown, context: QueryContext) => unknown;
  requiredCapabilities: readonly CapabilityClass[];
  description: string | undefined;
}

export interface LoomBus extends AppCommandBus {
  /**
   * THE authority on capability grants (T90, §V38). The confirm flow writes here; the
   * bus checks here; adapters cannot reach it through a tool call.
   */
  readonly grants: CapabilityGrantStore;
  /** `S` is inferred from `inputSchema` so `InputKeysCovered` can name a key it forgot (§T1556b). */
  registerCommand: <
    TName extends CommandName,
    S extends CommandRegistration<TName>["inputSchema"] = CommandRegistration<TName>["inputSchema"],
  >(
    registration: Omit<CommandRegistration<TName>, "inputSchema"> & { readonly inputSchema: S } & InputKeysCovered<TName, S>,
  ) => void;
  registerQuery: <TName extends QueryName>(registration: QueryRegistration<TName>) => void;
  /**
   * Whether `execute(name)` has a command to run: one registered here, or (§T1695b) one a
   * session bus inherits from its parent. A `definition` command the session holds no copy
   * of is NOT inherited, so this is false for it.
   */
  hasCommand: (name: string) => boolean;
  /** §T1695b: whether the command is registered on THIS bus, not inherited. */
  ownsCommand: (name: string) => boolean;
  /** §T1695b: what a command declared (`InSession`): here, or on the bus this one inherits from. */
  inSessionOf: (name: string) => InSession | undefined;
  /**
   * §T1695b — the bus's own refusal of a call, before any handler: audited, and answered
   * through the command's `rejectionOutput` (or thrown, as `CommandRefusedError`, when it
   * has none). A session bus refuses an `instance` command through its parent with this
   * when no instance is in view.
   */
  refuse: <TName extends CommandName>(
    name: TName,
    input: unknown,
    diagnostics: RuntimeDiagnostic[],
    context: InvocationContext,
  ) => Promise<CommandResult<TName>>;
  /** §T1695b: the bus this one inherits from; undefined on the project's bus. */
  readonly parent: LoomBus | undefined;
  /** §T1695b: the project's bus, which is this one when it has no parent. App state is kept there (`sharedForBus`). */
  readonly root: LoomBus;
  hasQuery: (name: string) => boolean;
  /** Every command `hasCommand` answers true for, sorted. */
  listCommands: () => readonly string[];
  /**
   * §T1556b — the input schema a command registered (`ANY_INPUT` included), or undefined for
   * a name nothing registered. Read-only, for the gates that hold DATA (keymap bindings,
   * menu rows, pulse templates) to the input the command takes.
   */
  inputSchemaOf: (name: string) => CommandRegistration<CommandName>["inputSchema"] | undefined;
  listQueries: () => readonly string[];
  /**
   * Publishes the composition root's ONE channel resolver into every `CommandContext`
   * (T593, B121). See `CommandContext.channels`.
   *
   * A READ FUNCTION rather than the resolver, for the same reason `attachStateSources`
   * takes one: the app's resolver is re-memoized per document revision, and a source that
   * captured one render's object would hand every later command a stale ladder. Last
   * attach wins — the bus has no unregister and React mounts more than once.
   */
  attachChannelResolver: (read: () => ChannelResolver | undefined) => void;
  /** What is currently attached, for the composition root and its gates. */
  readonly channelResolver: () => ChannelResolver | undefined;
  /**
   * Publishes the running transport's absolute clock into every `CommandContext` (T1497b).
   * See `CommandContext.frameClock`.
   *
   * A READ FUNCTION, like the two beside it: the reading moves every frame, and a value
   * captured at attach time would stamp every morph with the moment the app mounted.
   * Last attach wins — the bus has no unregister and React mounts more than once.
   */
  attachFrameClock: (read: () => FrameClock | undefined) => void;
  /** What a command invoked now would read, for the composition root and its gates. */
  readonly frameClock: () => FrameClock | undefined;
  /**
   * §T1557b — publishes the frame the running transport last produced, for `readScope`. A
   * READ FUNCTION like the others: the frame moves every tick. Undefined = no frame yet, and
   * a read resolves at the zero frame. Last attach wins.
   */
  attachFrame: (read: () => FrameEvaluationInput | undefined) => void;
  /**
   * §T1557b — `CommandContext.readScope` for a reader outside a command (the camera gizmo's
   * pose read), over the store's current document. The same producer, so the two cannot be
   * assembled differently.
   */
  readonly readScope: () => ParameterReadContext;
  /**
   * Publishes the composition root's ONE flattened document (T615, §V82).
   *
   * A command addresses a node by id, and inside a component instance the only id that
   * exists is a FLAT one — `c1/reset` names a real node in the plan and no node at all in
   * the document. `parameter.pulse` is the case that forced this: once the pulse watcher
   * ran on the flattened graph (which is what makes an expression-fired pulse inside a
   * component fire at all), every one of those fires was rejected as "no node c1/reset".
   *
   * A read function rather than the graph, exactly as with the channel resolver: the
   * flattening is re-memoized per document revision, and a captured one goes stale. Last
   * attach wins; the bus has no unregister and React mounts more than once.
   *
   * Null until a composition root attaches one, and null means "there is no app", not
   * "there are no components" — a handler falls back to the document, which is what every
   * bus without a rendered tree has always seen.
   *
   * §T1557b: the flattening WHOLE (`runtime.flattened.current()`), not its graph alone, so
   * `readScope` carries the morphs and instances off the same object (`FlatteningReads`).
   */
  attachFlattenedGraph: (read: () => (FlatteningReads & { readonly graph: FlatGraph }) | undefined) => void;
  /** The flattened document, or undefined when nothing has attached one. */
  readonly flattenedGraph: () => FlatGraph | undefined;
  /** The composition root supplies the same component projection used by the compiler. */
  attachReferenceCycleValidator: (validate: ReferenceCycleValidator) => void;
  readonly referenceCycles: ReferenceCycleValidator;
  /** Read-only document access for the UI. Mutation stays behind `execute` (§V29). */
  readonly store: GraphStoreView;
  readonly registry: NodeRegistryView;
}

export interface CommandBusOptions {
  store?: GraphStore;
  registry?: NodeRegistryView;
  /** Bus-owned grant store (T90, §V38). Created empty when not supplied. */
  grants?: CapabilityGrantStore;
  /**
   * §T1695b: the bus this one inherits from, which makes this one a session bus: a command
   * it does not hold is answered through the parent, by the command's own `inSession`.
   */
  parent?: LoomBus | undefined;
  /** §T1695b: what the session edits and through which instance. Only read with a `parent`. */
  scope?: SessionScope | undefined;
  referenceHost?: ReferenceCycleHost;
}

/** The code of the refusal a session issues for an `instance` command with no instance in view. */
export const SESSION_NO_INSTANCE_CODE = "session.noInstance";
/** The code of the note on a handed-up call that applied a step to the project. */
export const SESSION_PROJECT_STEP_CODE = "session.projectStep";

function assertContext(context: InvocationContext, name: string): void {
  // §V30: no anonymous mutation — an actor is not optional, and neither is its id.
  if (context.actor === undefined || context.actor === null) {
    throw new InvalidInvocationError(`"${name}" was invoked without an actor (§V30).`);
  }
  if (typeof context.actor.id !== "string" || context.actor.id.trim() === "") {
    throw new InvalidInvocationError(`"${name}" was invoked with an empty actor id (§V30).`);
  }
  if (typeof context.projectId !== "string" || context.projectId.trim() === "") {
    throw new InvalidInvocationError(`"${name}" was invoked without a projectId.`);
  }
}

/**
 * T90 (§V38): grants are read from the BUS-OWNED store, never from the invocation.
 * `InvocationContext.capabilities` still exists in the frozen contract but is advisory —
 * an adapter fabricating it changes nothing, which is what "calling a tool never grants
 * a capability" actually requires.
 */
function missingCapabilities(
  required: readonly CapabilityClass[],
  actor: InvocationContext["actor"],
  grants: CapabilityGrantStore,
): CapabilityClass[] {
  if (required.length === 0) return [];
  return required.filter((capability) => !grants.has(actor, capability));
}

export function createCommandBus(options: CommandBusOptions = {}): LoomBus {
  const store = options.store ?? createGraphStore();
  const registry = options.registry ?? createNodeRegistry().view();
  const grants = options.grants ?? createCapabilityGrantStore();
  const commands = new Map<string, StoredCommand>();
  const queries = new Map<string, StoredQuery>();
  const parent = options.parent;
  const scope = options.scope;

  /** §T1695b: is `name` a command this bus answers through its parent? Never a `definition` one. */
  const inherits = (name: string): boolean => {
    if (parent === undefined || commands.has(name) || !parent.hasCommand(name)) return false;
    const declared = parent.inSessionOf(name);
    return declared !== undefined && inSessionKind(declared) !== "definition";
  };

  /** A diagnostic's node id, as the definition in hand names it when it is a node of the instance in view. */
  const mappedBack = (diagnostics: readonly RuntimeDiagnostic[], path: InstancePath | undefined): RuntimeDiagnostic[] =>
    diagnostics.map((diagnostic) => {
      if (path === undefined || diagnostic.nodeId === undefined) return diagnostic;
      const inner = fromInstance(path, diagnostic.nodeId);
      return inner === undefined ? diagnostic : { ...diagnostic, nodeId: inner };
    });

  /**
   * §T1695b: one call on the parent, addressed at the instance in view when `addressed` (an
   * `instance` command always is; a hand-up is when its schema declares a node address).
   */
  async function onParent<TName extends CommandName>(
    name: TName,
    input: unknown,
    context: InvocationContext,
    addressed: boolean,
  ): Promise<CommandResult<TName>> {
    if (parent === undefined) throw new UnknownCommandError(name);
    if (!addressed) return parent.execute(name, input as CommandInput<TName>, context);
    const path = scope?.instancePath();
    if (path === undefined || path.length === 0) {
      return parent.refuse(
        name,
        input,
        [
          {
            severity: "error",
            code: SESSION_NO_INSTANCE_CODE,
            message: `"${name}" acts on a running instance of ${scope?.subject() ?? "this component"}, and this editor is not open through one.`,
            suggestion: "Open the component from one of its instances in the project, then try again.",
          },
        ],
        context,
      );
    }
    const schema = parent.inputSchemaOf(name);
    const rewritten =
      schema === undefined || isAnyInput(schema) ? input : rewriteNodeAddresses(schema, input, (nodeId) => toInstance(path, nodeId));
    const result = await parent.execute(name, rewritten as CommandInput<TName>, context);
    return { ...result, diagnostics: mappedBack(result.diagnostics, path) };
  }

  /** Does `name`'s schema, as the parent holds it, declare a node address? */
  const declaresAddresses = (name: string): boolean => {
    const schema = parent?.inputSchemaOf(name);
    return schema !== undefined && !isAnyInput(schema) && stringLeavesOf(schema).some((leaf) => leaf.kind === "node");
  };

  /** The bus's own refusal, answered as the registration can answer it (see `LoomBus.refuse`). */
  function refusal<TName extends CommandName>(
    registration: StoredCommand,
    input: unknown,
    diagnostics: RuntimeDiagnostic[],
    context: InvocationContext,
    thrown: () => Error,
  ): CommandResult<TName> {
    const revision = store.view.getRevision();
    if (context.dryRun !== true) {
      store.internals.recordAudit({ revision, actor: context.actor, command: registration.name, status: "rejected" });
    }
    if (registration.rejectionOutput === undefined) throw thrown();
    return {
      status: "rejected",
      revision,
      diagnostics,
      output: registration.rejectionOutput(input, diagnostics, revision) as CommandOutput<TName>,
    };
  }
  /** T593: null until a composition root attaches one. Null means "no app", not "empty". */
  let readChannels: (() => ChannelResolver | undefined) | null = null;
  let validateReferenceCycles: ReferenceCycleValidator | undefined;
  /** T615: likewise — null is "no app", and a handler falls back to the document. */
  let readFlattened: (() => (FlatteningReads & { readonly graph: FlatGraph }) | undefined) | null = null;
  /** T1497b: likewise — null is "no app", and a morph commits as a cut. */
  let readFrameClock: (() => FrameClock | undefined) | null = null;
  /** §T1557b: likewise — null is "no app", and a read resolves at the zero frame. */
  let readFrame: (() => FrameEvaluationInput | undefined) | null = null;
  /** §T1557b: the one producer behind `bus.readScope` and every `CommandContext.readScope`. */
  const readScopeOver = (graph: GraphDocument): ParameterReadContext => ({
    // §T1552b: a command addresses the document AS AUTHORED (the ids it patches, an instance
    // whole), on purpose. A site that must read the flattening overrides `graph` with
    // `flattenedGraph()`, which is a `FlatGraph` and says so.
    graph: authoredGraph(graph),
    registry,
    frame: readFrame?.() ?? undefined,
    channels: readChannels?.() ?? undefined,
    flattening: readFlattened?.() ?? NO_FLATTENING,
  });

  const bus: LoomBus = {
    store: store.view,
    registry,
    grants,

    attachChannelResolver(read: () => ChannelResolver | undefined): void {
      readChannels = read;
    },
    channelResolver: () => readChannels?.() ?? undefined,

    attachFlattenedGraph(read: () => (FlatteningReads & { readonly graph: FlatGraph }) | undefined): void {
      readFlattened = read;
    },
    flattenedGraph: () => readFlattened?.()?.graph ?? undefined,
    attachReferenceCycleValidator(validate): void { validateReferenceCycles = validate; },
    referenceCycles(graph, nodeId, host): RuntimeDiagnostic[] {
      if (validateReferenceCycles !== undefined) return validateReferenceCycles(graph, nodeId, host);
      if (parent !== undefined) return parent.referenceCycles(graph, nodeId, host);
      if (Object.values(graph.nodes).some(isComponentInstance) && Object.values(graph.nodes).some(node => keyReads(node.parameters).some(read => read.node !== null && isNodePath(read.node)))) {
        return [{ severity: "error", code: "parameter.referenceProjection.missing", nodeId,
          message: "Path reference cycle validation requires the component-aware graph projection.",
          suggestion: "Attach the composition root's reference cycle validator before editing component paths." }];
      }
      return referenceCyclesThrough(graph, nodeId, node => channelDependenciesOf(registry.get(node.type)));
    },

    attachFrame(read: () => FrameEvaluationInput | undefined): void {
      readFrame = read;
    },
    readScope: () => readScopeOver(store.view.getGraph()),

    attachFrameClock(read: () => FrameClock | undefined): void {
      readFrameClock = read;
    },
    frameClock: () => readFrameClock?.() ?? undefined,

    registerCommand<TName extends CommandName>(registration: CommandRegistration<TName>): void {
      if (commands.has(registration.name)) {
        throw new Error(`Command "${registration.name}" is already registered.`);
      }
      if (registration.inputSchema === undefined || registration.inputSchema === null) {
        // The type already requires it; this is for a caller that cast its way past.
        throw new Error(`Command "${registration.name}" is registered without an inputSchema (§T1556b).`);
      }
      if (registration.inSession === undefined || registration.inSession === null) {
        // Likewise required by the type.
        throw new Error(`Command "${registration.name}" is registered without saying what it means inside a component session (inSession, §T1695b).`);
      }
      if (registration.inSession === "instance" && registration.rejectionOutput === undefined) {
        // A session refuses it when no instance is in view, and a pulse relays that sentence:
        // a refusal that can only be thrown would reach the user as "command failed".
        throw new Error(`Command "${registration.name}" is declared "instance" and has no rejectionOutput to answer a session's refusal with (§T1695b).`);
      }
      if (registration.inSession === "instance") {
        // Its addresses are rewritten from its schema, so the schema has to say which strings
        // they are. An undeclared one would reach the project as the definition's bare id:
        // the wrong node, or none, and nothing said.
        const leaves = isAnyInput(registration.inputSchema) ? [] : stringLeavesOf(registration.inputSchema);
        const undeclared = leaves.filter((leaf) => leaf.kind === "unmarked").map((leaf) => leaf.path);
        if (undeclared.length > 0 || !leaves.some((leaf) => leaf.kind === "node")) {
          throw new Error(
            `Command "${registration.name}" is declared "instance", so every string of its input is a node address (nodeIdInput, nodeIdsInput) or a canvas id, and at least one is an address${undeclared.length > 0 ? `; undeclared: ${undeclared.join(", ")}` : ""} (§T1695b).`,
          );
        }
      }
      if (inherits(registration.name)) {
        // The double registration §T969(b) and §T1195 grew, refused where it would start.
        throw new Error(
          `Command "${registration.name}" is inherited from the parent bus (declared "${String(parent?.inSessionOf(registration.name))}"); a session bus does not register its own (§T1695b).`,
        );
      }
      commands.set(registration.name, {
        name: registration.name,
        inputSchema: registration.inputSchema as StoredCommand["inputSchema"],
        inSession: registration.inSession,
        handler: registration.handler as StoredCommand["handler"],
        requiredCapabilities: registration.requiredCapabilities ?? [],
        description: registration.description,
        rejectionOutput: registration.rejectionOutput as StoredCommand["rejectionOutput"],
      });
    },

    registerQuery<TName extends QueryName>(registration: QueryRegistration<TName>): void {
      if (queries.has(registration.name)) {
        throw new Error(`Query "${registration.name}" is already registered.`);
      }
      queries.set(registration.name, {
        name: registration.name,
        handler: registration.handler as StoredQuery["handler"],
        requiredCapabilities: registration.requiredCapabilities ?? [],
        description: registration.description,
      });
    },

    hasCommand: (name: string) => commands.has(name) || inherits(name),
    ownsCommand: (name: string) => commands.has(name),
    inSessionOf: (name: string) => commands.get(name)?.inSession ?? parent?.inSessionOf(name),
    hasQuery: (name: string) => queries.has(name),
    listCommands: () => [...new Set([...commands.keys(), ...(parent?.listCommands().filter(inherits) ?? [])])].sort(),
    inputSchemaOf: (name: string) => commands.get(name)?.inputSchema ?? (inherits(name) ? parent?.inputSchemaOf(name) : undefined),
    parent,
    get root(): LoomBus {
      return parent?.root ?? bus;
    },

    async refuse<TName extends CommandName>(
      name: TName,
      input: unknown,
      diagnostics: RuntimeDiagnostic[],
      context: InvocationContext,
    ): Promise<CommandResult<TName>> {
      assertContext(context, name);
      const registration = commands.get(name);
      if (registration === undefined) {
        if (parent !== undefined && inherits(name)) return parent.refuse(name, input, diagnostics, context);
        throw new UnknownCommandError(name);
      }
      return refusal<TName>(registration, input, diagnostics, context, () => new CommandRefusedError(diagnostics));
    },
    listQueries: () => [...queries.keys()].sort(),

    async query<TName extends QueryName>(
      name: TName,
      input: QueryInput<TName>,
      context: InvocationContext,
    ): Promise<QueryOutput<TName>> {
      assertContext(context, name);
      const registration = queries.get(name);
      if (registration === undefined) throw new UnknownQueryError(name);

      const missing = missingCapabilities(registration.requiredCapabilities, context.actor, grants);
      if (missing.length > 0) throw new CapabilityDeniedError(name, missing);

      const queryContext: QueryContext = {
        invocation: context,
        actor: context.actor,
        graph: store.view.getGraph(),
        registry,
        store: store.view,
      };
      return (await registration.handler(input, queryContext)) as QueryOutput<TName>;
    },

    async execute<TName extends CommandName>(
      name: TName,
      input: CommandInput<TName>,
      context: InvocationContext,
    ): Promise<CommandResult<TName>> {
      assertContext(context, name);
      const registration = commands.get(name);
      if (registration === undefined) {
        // §T1695b: a session bus answers what it does not hold through its parent, by the
        // command's own declaration.
        const declared = parent?.hasCommand(name) === true ? parent.inSessionOf(name) : undefined;
        if (declared === undefined) throw new UnknownCommandError(name);
        const kind = inSessionKind(declared);
        if (kind === "definition") {
          throw new UnknownCommandError(
            name,
            `"${name}" edits a graph, and this editor of ${scope?.subject() ?? "a component"} holds no copy of it (§T1695b: a definition command is registered on every document bus).`,
          );
        }
        return onParent(name, input, context, kind === "instance");
      }

      const dryRun = context.dryRun === true;

      // §T1556b: the input is checked HERE, before grants and before the handler, so a
      // menu, a keybind, the phone and an agent get one refusal for one mistake. The
      // handler then receives the input as sent: the schema is a gate, never a transform.
      if (!isAnyInput(registration.inputSchema)) {
        const parsed = registration.inputSchema.safeParse(input);
        if (!parsed.success) {
          const diagnostics = inputRefusal(name, parsed.error.issues);
          return refusal<TName>(registration, input, diagnostics, context, () => new InvalidCommandInputError(diagnostics));
        }
      }

      const missing = missingCapabilities(registration.requiredCapabilities, context.actor, grants);
      if (missing.length > 0) {
        const diagnostics: RuntimeDiagnostic[] = [
          {
            severity: "error",
            code: "capability.denied",
            message: `"${name}" requires the ${missing.join(", ")} capability.`,
            suggestion: "Ask the user to grant it; calling the tool never grants it (§V38).",
          },
        ];
        const revision = store.view.getRevision();
        if (registration.rejectionOutput === undefined) {
          throw new CapabilityDeniedError(name, missing);
        }
        if (!dryRun) {
          store.internals.recordAudit({ revision, actor: context.actor, command: name, status: "rejected" });
        }
        return {
          status: "rejected",
          revision,
          diagnostics,
          output: registration.rejectionOutput(input, diagnostics, revision) as CommandOutput<TName>,
        };
      }

      const graph = store.view.getGraph();
      const commandContext: CommandContext = {
        invocation: context,
        actor: context.actor,
        dryRun,
        commandName: name,
        graph,
        registry,
        store: store.view,
        ids: store.internals.ids,
        // T593: read AT INVOCATION, so a handler sees the ladder the app is compiling
        // through right now rather than the one it held when the command registered.
        channels: readChannels?.() ?? undefined,
        // T1497b: likewise read AT INVOCATION — the frame on screen when the command ran.
        frameClock: readFrameClock?.() ?? undefined,
        readScope: () => readScopeOver(graph),
        referenceCycles: (draft, nodeId) => bus.referenceCycles(draft, nodeId, options.referenceHost),
        holds: (capability: CapabilityClass): boolean => grants.has(context.actor, capability),
        applySettings: (request: ApplySettingsRequest): AppliedInfo =>
          store.internals.applySettings({
            actor: context.actor,
            command: name,
            label: request.label,
            transactionId: context.transactionId,
            splitUndo: request.splitUndo === true,
            dryRun,
            patch: request.patch,
          }),
        applyStep: (request: ApplyStepRequest): AppliedInfo =>
          store.internals.applyStep({
            actor: context.actor,
            command: name,
            label: request.label,
            transactionId: context.transactionId,
            splitUndo: request.splitUndo === true,
            dryRun,
          }),
        apply: (request: ApplyRequest): AppliedInfo =>
          store.internals.apply({
            actor: context.actor,
            command: name,
            label: request.label,
            transactionId: context.transactionId,
            splitUndo: request.splitUndo === true,
            dryRun,
            recipe: request.recipe,
          }),
        audit: (): void => {
          // §V36: a dry run reports and records nothing, including this.
          if (dryRun) return;
          store.internals.recordAudit({
            revision: store.view.getRevision(),
            actor: context.actor,
            command: name,
            status: "applied",
          });
        },
        undoLast: () => store.internals.undo(context.actor, name),
        redoLast: () => store.internals.redo(context.actor, name),
        session:
          parent === undefined
            ? undefined
            : {
                instancePath: () => scope?.instancePath(),
                handUp: async <TOutput>(): Promise<CommandOutcome<TOutput>> => {
                  if (typeof registration.inSession === "string") {
                    // A graph edit that left its graph without saying so is §B286 again.
                    throw new Error(`Command "${name}" handed a call up without declaring handsUp (§T1695b).`);
                  }
                  const result = await onParent(name, input, context, declaresAddresses(name));
                  const note: RuntimeDiagnostic[] =
                    result.status === "applied" && result.undoGroupId !== undefined
                      ? [
                          {
                            severity: "info",
                            code: SESSION_PROJECT_STEP_CODE,
                            message: `"${name}" changed the project, not ${scope?.subject() ?? "the component"}: undo it from the project.`,
                          },
                        ]
                      : [];
                  // The session's own revision stands: nothing in the graph in hand moved.
                  return { status: result.status, output: result.output as TOutput, diagnostics: [...result.diagnostics, ...note] };
                },
              },
      };

      let outcome: CommandOutcome<CommandOutput<TName>>;
      try {
        outcome = (await registration.handler(input, commandContext)) as CommandOutcome<
          CommandOutput<TName>
        >;
      } catch (thrown) {
        // §V31/§V66: a handler that throws must not become an unhandled rejection with
        // no trace in the log. The mutation did not happen, so it is recorded as
        // rejected and reported as a diagnostic — the same shape every other failure
        // has. A command with no `rejectionOutput` cannot be answered (the bus cannot
        // invent a typed result), so it rethrows AFTER the audit entry exists.
        const revision = store.view.getRevision();
        if (!dryRun) {
          store.internals.recordAudit({ revision, actor: context.actor, command: name, status: "rejected" });
        }
        if (registration.rejectionOutput === undefined) throw thrown;
        const diagnostics: RuntimeDiagnostic[] = [
          {
            severity: "error",
            code: "command.failed",
            // The error's TYPE only. Its message may quote untrusted document text (§V37).
            message: `"${name}" failed: ${thrown instanceof Error ? thrown.name : "a non-Error value was thrown"}.`,
            suggestion: "This is a defect in the command, not in the request; nothing was changed.",
          },
        ];
        return {
          status: "rejected",
          revision,
          diagnostics,
          output: registration.rejectionOutput(input, diagnostics, revision) as CommandOutput<TName>,
        };
      }

      const revision = outcome.revision ?? store.view.getRevision();

      // A committed mutation already wrote its audit entry inside the store. What is
      // left is the negative space: rejections and conflicts still have to be visible
      // in the log (§V31). A dry run writes nothing at all (§V36) — including one that
      // answers "validated", which is a report about a mutation that did not happen.
      if (!dryRun && (outcome.status === "rejected" || outcome.status === "conflict")) {
        store.internals.recordAudit({
          revision,
          actor: context.actor,
          command: name,
          status: outcome.status,
          ...(outcome.undoGroupId === undefined ? {} : { undoGroupId: outcome.undoGroupId }),
        });
      }

      return {
        status: outcome.status,
        revision,
        diagnostics: outcome.diagnostics ?? [],
        output: outcome.output,
        ...(outcome.undoGroupId === undefined ? {} : { undoGroupId: outcome.undoGroupId }),
      };
    },
  };

  return bus;
}
