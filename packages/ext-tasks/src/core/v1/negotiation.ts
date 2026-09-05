/** MCP Tasks V1 capability negotiation and task request helpers. */
import { type JsonValue } from "../index.js";
import {
  type CallToolAsTaskRequestV1,
  type ServerTaskCapabilitiesV1,
  type TaskEligibleMethodV1,
  type ToolV1,
} from "./wire.js";
/** Checks whether the server advertises task listing by defining its list capability. */
export function hasTaskListCapabilityV1(
  capabilities: ServerTaskCapabilitiesV1,
): boolean {
  return capabilities.list !== undefined;
}
/** Checks whether the server advertises task cancellation by defining its cancel capability. */
export function hasTaskCancelCapabilityV1(
  capabilities: ServerTaskCapabilitiesV1,
): boolean {
  return capabilities.cancel !== undefined;
}
/** Checks whether the server defines task support for tool-call requests. */
export function hasTaskToolCallCapabilityV1(
  capabilities: ServerTaskCapabilitiesV1,
): boolean {
  return capabilities.requests?.tools?.call !== undefined;
}
/** Narrows a method string to the sole V1 task-eligible method, `tools/call`. */
export function isTaskEligibleMethodV1(
  method: string,
): method is TaskEligibleMethodV1 {
  return method === "tools/call";
}
/**
 * Chooses task execution only when the server supports task tool calls and the tool
 * requires tasks, or optionally supports them while the caller explicitly prefers tasks.
 */
export function shouldCallToolAsTaskV1(
  capabilities: ServerTaskCapabilitiesV1,
  tool: ToolV1,
  preferTask = false,
): boolean {
  if (!hasTaskToolCallCapabilityV1(capabilities)) return false;
  return (
    tool.execution?.taskSupport === "required" ||
    (tool.execution?.taskSupport === "optional" && preferTask)
  );
}
/**
 * Builds a `tools/call` task request, omitting `arguments` when none are supplied.
 */
export function callToolAsTaskV1(
  name: string,
  arguments_?: Readonly<Record<string, JsonValue>>,
): CallToolAsTaskRequestV1 {
  return {
    method: "tools/call",
    params: {
      name,
      ...(arguments_ === undefined ? {} : { arguments: arguments_ }),
      task: {},
    },
  };
}
