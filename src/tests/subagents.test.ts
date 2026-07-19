import type { SessionNotification } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import { jazProviderSubagent } from "../subagents.js";

type Update = SessionNotification["update"];

describe("jazProviderSubagent", () => {
  it("names the subagent from the Agent tool call", () => {
    const update = {
      sessionUpdate: "tool_call",
      toolCallId: "task-1",
      status: "pending",
      rawInput: {
        description: "Explore the codebase",
        prompt: "Look around.",
        subagent_type: "Explore",
      },
      _meta: { claudeCode: { toolName: "Agent" } },
    } as unknown as Update;

    expect(jazProviderSubagent(update, null)).toEqual({
      provider: "claude",
      id: "task-1",
      status: "running",
      name: "Explore the codebase",
      role: "Explore",
      prompt: "Look around.",
    });
  });

  it("maps completion to completed status", () => {
    const update = {
      sessionUpdate: "tool_call_update",
      toolCallId: "task-1",
      status: "completed",
      _meta: { claudeCode: { toolName: "Agent" } },
    } as unknown as Update;

    expect(jazProviderSubagent(update, null)).toEqual({
      provider: "claude",
      id: "task-1",
      status: "completed",
    });
  });

  it("reports a nested call as current activity", () => {
    const update = {
      sessionUpdate: "tool_call",
      toolCallId: "nested-1",
      title: "Read main.ts",
      _meta: { claudeCode: { toolName: "Read" } },
    } as unknown as Update;

    expect(jazProviderSubagent(update, "task-1")).toEqual({
      provider: "claude",
      id: "task-1",
      status: "running",
      summary: "Read main.ts",
    });
  });

  it("ignores unrelated updates", () => {
    const update = {
      sessionUpdate: "tool_call",
      toolCallId: "read-1",
      _meta: { claudeCode: { toolName: "Read" } },
    } as unknown as Update;

    expect(jazProviderSubagent(update, null)).toBeNull();
  });
});
