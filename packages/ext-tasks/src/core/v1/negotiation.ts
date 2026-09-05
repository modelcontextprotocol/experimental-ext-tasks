/** MCP Tasks V1 capability negotiation and task request helpers. */
import { type JsonValue } from "../index.js";
import {
  type CallToolAsTaskRequestV1,
  type ServerTaskCapabilitiesV1,
  type TaskEligibleMethodV1,
  type ToolV1,
} from "./wire.js";
export function hasTaskListCapabilityV1(
  capabilities: ServerTaskCapabilitiesV1,
): boolean {
  return capabilities.list !== undefined;
}
export function hasTaskCancelCapabilityV1(
  capabilities: ServerTaskCapabilitiesV1,
): boolean {
  return capabilities.cancel !== undefined;
}
export function hasTaskToolCallCapabilityV1(
  capabilities: ServerTaskCapabilitiesV1,
): boolean {
  return capabilities.requests?.tools?.call !== undefined;
}
export function isTaskEligibleMethodV1(
  method: string,
): method is TaskEligibleMethodV1 {
  return method === "tools/call";
}
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
