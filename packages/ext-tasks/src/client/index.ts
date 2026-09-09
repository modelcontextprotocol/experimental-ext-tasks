/** Requester-side MCP Tasks session and execution support. */

export {
  InputCorrelationError,
  JsonRpcResponseError,
  TaskCancelledError,
  TaskFailedError,
  TaskCancellationUnsupportedError,
  TaskExecutionClosedError,
  toolDeclaration,
  TaskRecoveryOwnershipError,
  TaskUpdatesAlreadyAcquiredError,
  TaskRetentionUnsupportedError,
  TaskInputUpdateUnsupportedError,
} from "./api.js";
export {
  createTaskSessionEndpointId,
  resultFromTaskOutcome,
  taskViewFromExecutionEvent,
} from "./api.js";
export { withRelatedTaskMetadata } from "./api.js";
export type {
  ApplicationCreateMessageResult,
  ApplicationElicitResult,
  ApplicationInputHandler,
  ApplicationInputCallbacks,
  ApplicationInputRequest,
  ApplicationInputResult,
  ApplicationListRootsResult,
  InputCorrelationCandidate,
  InputCorrelationFailureReason,
  ResolvedInputExchangeContext,
  SerializedTaskReference,
  TaskController,
  TaskControllerOptions,
  TaskEnabledSession,
  TaskHandle,
  TaskListPage,
  TaskCapabilities,
  TaskExecutionEvent,
  TaskOptions,
  TaskOutcome,
  TaskPreference,
  TaskRetentionPolicy,
  TaskState,
  TaskView,
  TaskResultOptions,
  TaskRecoveryOptions,
  TaskSessionEndpointId,
  ToolCallOptions,
  ToolDeclaration,
  ToolDeclarationProvider,
  ToolExecution,
  ToolExecutionCommon,
  WithTasksOptions,
  ToolExecutionSettleOptions,
  ToolExecutionSettlement,
} from "./api.js";
export { createApplicationInputHandler } from "./input-routing.js";
export { DispatchError } from "./port.js";
export type {
  ConnectedMcpSessionPort,
  DispatchContext,
  DispatchOptions,
  IncomingServerRequest,
  JsonRpcResponse,
  SessionTaskCapabilities,
} from "./port.js";
export {
  createSessionPortFromClient,
  createTaskSessionFromClient,
  toolDeclarationFromMcpTool,
} from "./sdk-client-adapter.js";
export type {
  ClientSessionPortOptions,
  CreateTaskSessionFromClientOptions,
  V2RequestFraming,
  RawClientDispatch,
} from "./sdk-client-adapter.js";
export { withTasks } from "./session.js";
export type { TaskEligibleMethodV2 } from "../core/v2/index.js";
