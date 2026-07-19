import type { AgentInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import type { SessionNotification } from "@agentclientprotocol/sdk";

type Update = SessionNotification["update"];

export type JazProviderSubagent = {
  provider: "claude";
  id: string;
  status: "running" | "completed" | "failed";
  name?: string;
  role?: string;
  prompt?: string;
  model?: string;
  summary?: string;
};

const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

export function jazProviderSubagent(
  update: Update,
  parentToolUseId: string | null | undefined,
): JazProviderSubagent | null {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
    return null;
  }
  if (parentToolUseId) {
    const summary = typeof update.title === "string" ? update.title.trim() : "";
    return {
      provider: "claude",
      id: parentToolUseId,
      status: "running",
      ...(summary ? { summary } : {}),
    };
  }
  const toolName = (update._meta as { claudeCode?: { toolName?: string } } | undefined)?.claudeCode
    ?.toolName;
  if (!toolName || !SUBAGENT_TOOLS.has(toolName) || !update.toolCallId) return null;

  const input = (update.rawInput ?? {}) as Partial<AgentInput>;
  return {
    provider: "claude",
    id: update.toolCallId,
    status: subagentStatus(update.status),
    ...(input.description ? { name: input.description } : {}),
    ...(input.subagent_type ? { role: input.subagent_type } : {}),
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.model ? { model: input.model } : {}),
  };
}

function subagentStatus(status: string | null | undefined): JazProviderSubagent["status"] {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "running";
}
