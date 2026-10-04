export {
  defaultParameterValue,
  defaultParameters,
  validateParameterValue,
  validateParameters,
  validateStoredParameter,
} from "./validate.ts";

export {
  PARAMETER_MODES,
  componentDefinition,
  componentKey,
  componentNamesFor,
  isComponentKeyOf,
  isParameterSlot,
  parseComponentKey,
  componentAddressedDefinition,
  bindingFromText,
  holdsRetainedValue,
  numericLiteralFor,
  payloadText,
  seedBinding,
  slotFromValue,
  withBinding,
  withMode,
  withStaticValue,
  staticBindingValue,
  storedStaticValue,
} from "./slots.ts";

export { bindCycleDiagnostics } from "./bind-cycles.ts";

export { storedValues } from "./stored-values.ts";

export { parameterReference, parseParameterReference } from "./reference.ts";
export type { ParsedParameterReference } from "./reference.ts";

export {
  PULSE_NODE_TOKEN,
  createPulseWatcher,
  isPulseArmed,
  pulseCommandInput,
  pulseParametersOf,
} from "./pulse.ts";
export type { PulseFire, PulseWatcher } from "./pulse.ts";

export {
  STORED_READ,
  resolveParameter,
  resolveParameterSchema,
  resolveParameters,
  resolveStored,
  resolveStoredSchema,
  srgbToLinear,
} from "./resolve.ts";
export type {
  BindLookupResult,
  ChannelResolver,
  ParameterDriver,
  ParameterMorphStep,
  ParameterMorphs,
  ParameterDriverContext,
  ParameterSource,
  ParentBindResolver,
  ParameterRead,
  ParameterReadOptions,
  ResolveExtras,
  ResolveParametersOptions,
  ResolvedComponent,
  ResolvedParameter,
  ResolvedParameters,
} from "./resolve.ts";
export {
  NO_FLATTENING,
  NO_INSTANCES,
  createNodeReferenceReader,
  nodeReferenceMembers,
  nodeReferenceNames,
} from "./node-references.ts";
export { parameterReadOptions } from "./node-references.ts";
export type {
  FlatteningReads,
  LiveParameterReads,
  InstanceChannelSource,
  InstanceChannelSources,
  NodeReferenceCatalogueOptions,
  NodeReferenceMember,
  NodeReferenceOptions,
  ParameterReadContext,
} from "./node-references.ts";
export { codeParametersLast, codeParametersOf } from "./code.ts";
