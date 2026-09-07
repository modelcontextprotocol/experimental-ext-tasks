/** Requester-side MCP Tasks session and execution support. */

export {
  InputCorrelationError,
  JsonRpcResponseError,
  TaskCancellationUnsupportedError,
  TaskExecutionClosedError,
  TaskRecoveryOwnershipError,
  TaskUpdatesAlreadyAcquiredError,
  toolDeclarationV1,
  toolDeclarationV2,
} from "./api.js";
export type {
  ApplicationCreateMessageResult,
  ApplicationElicitResult,
  ApplicationInputHandler,
  ApplicationInputRequest,
  ApplicationInputResult,
  ApplicationListRootsResult,
  InputCorrelationCandidate,
  InputCorrelationFailureReason,
  ResolvedInputExchangeContext,
  SerializedTaskReference,
  TaskEnabledSession,
  TaskHandle,
  ToolCallOptions,
  ToolDeclaration,
  ToolDeclarationProvider,
  ToolExecution,
  ToolExecutionCommon,
  WithTasksOptions,
} from "./api.js";
export { DispatchError } from "./port.js";
export type {
  ConnectedMcpSessionPort,
  DispatchContext,
  DispatchOptions,
  IncomingServerRequest,
  JsonRpcResponse,
  SessionTaskCapabilities,
} from "./port.js";
export { createSessionPortFromClient } from "./sdk-client-adapter.js";
export type {
  ClientSessionPortOptions,
  RawClientDispatch,
} from "./sdk-client-adapter.js";
export { withTasks } from "./session.js";
export type { TaskEligibleMethodV2 } from "../core/v2/index.js";
