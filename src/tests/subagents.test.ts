/**
 * Drives the real agent with SDK task lifecycle streams and checks the Jaz
 * Subtasks records (`_meta.jaz.providerSubagent`) that it sends. The client
 * declares the capabilities that Jaz declares.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  activeSdkSessionId,
  assistantTurn,
  PROFILES,
  type Recorded,
  resetIds,
  result,
  runScenario,
  type Scenario,
  system,
  toolCall,
  toolResult,
} from "./acp-scenarios/harness.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  const harness = await import("./acp-scenarios/harness.js");
  return {
    ...actual,
    query: harness.mockedQuery,
    getSessionMessages: harness.mockedSessionMessages,
  };
});

/** The client capabilities of Jaz (backend/internal/acp/manager.go). */
const JAZ_CAPABILITIES: Scenario["capabilities"] = {
  terminal: false,
  _meta: {
    "terminal-auth": true,
    terminal_output_delta: true,
    jetbrains: { air: { version: 1, capabilities: ["asyncTasks", "recommendedValue"] } },
    "jaz.dev/widget": { version: 1 },
  },
};

const idle = () => system("session_state_changed", { state: "idle" });
const running = () => system("session_state_changed", { state: "running" });

const agentInput = (description: string, prompt: string, subagentType: string) => ({
  description,
  prompt,
  subagent_type: subagentType,
});

const taskStarted = (
  taskId: string,
  toolUseId: string | undefined,
  input: ReturnType<typeof agentInput>,
  fields: Record<string, unknown> = {},
) =>
  system("task_started", {
    task_id: taskId,
    task_type: "local_agent",
    tool_use_id: toolUseId,
    description: input.description,
    subagent_type: input.subagent_type,
    prompt: input.prompt,
    is_backgrounded: false,
    ...fields,
  });

const taskProgress = (taskId: string, toolUseId: string, lastToolName: string) =>
  system("task_progress", {
    task_id: taskId,
    tool_use_id: toolUseId,
    description: "working",
    last_tool_name: lastToolName,
    usage: { total_tokens: 10, tool_uses: 1, duration_ms: 5 },
  });

const taskNotification = (
  taskId: string,
  toolUseId: string | undefined,
  status: "completed" | "failed" | "stopped",
  fields: Record<string, unknown> = {},
) =>
  system("task_notification", {
    task_id: taskId,
    tool_use_id: toolUseId,
    status,
    summary: `Task ${status}`,
    output_file: `/tmp/tasks/${taskId}.output`,
    ...fields,
  });

const taskUpdated = (taskId: string, status: string) =>
  system("task_updated", { task_id: taskId, patch: { status } });

/** A tool call that a subagent makes. */
function* subagentRead(parent: string, id: string) {
  yield* assistantTurn(
    `msg_${id}`,
    [{ type: "tool_use", id, name: "Read", input: { file_path: "/src/main.ts" } }],
    parent,
  );
  yield toolResult(id, "1\tmain", { parent });
}

const foreground = agentInput("Explore the code", "Find the entry point", "Explore");
const background = agentInput("Review the diff", "Review it", "general-purpose");
const outer = agentInput("Plan the work", "Plan it", "Plan");
const inner = agentInput("Read the spec", "Read spec.md", "Explore");

const asyncLaunch = (taskId: string, input: ReturnType<typeof agentInput>) => ({
  content: `Async agent launched successfully.\nagentId: ${taskId} (use SendMessage to continue)`,
  structured: { status: "async_launched", agentId: taskId, ...input },
});

const scenarios: Scenario[] = [
  {
    name: "foreground",
    turns: [
      async function* () {
        yield* assistantTurn("msg_fg", [
          { type: "tool_use", id: "toolu_fg", name: "Agent", input: foreground },
        ]);
        yield taskStarted("agent_fg", "toolu_fg", foreground);
        yield* subagentRead("toolu_fg", "toolu_fg_read");
        yield taskProgress("agent_fg", "toolu_fg", "Read");
        yield taskProgress("agent_fg", "toolu_fg", "Read");
        yield toolResult("toolu_fg", [{ type: "text", text: "It starts in main.ts." }]);
        // A settling task reports a terminal patch and a notification.
        yield taskUpdated("agent_fg", "completed");
        yield taskNotification("agent_fg", "toolu_fg", "completed");
        yield result();
        yield idle();
      },
    ],
  },
  {
    // The launch call completes at once; the subagent works and ends after the
    // turn that launched it, then a SendMessage resumes it.
    name: "background",
    turns: [
      async function* (ctx) {
        yield* toolCall(
          ctx,
          { id: "toolu_bg", name: "Agent", input: { ...background, run_in_background: true } },
          asyncLaunch("agent_bg", background),
        );
        yield taskStarted("agent_bg", "toolu_bg", background, { is_backgrounded: true });
        yield* assistantTurn("msg_bg_launched", [{ type: "text", text: "A reviewer is on it." }]);
        yield result();
        yield idle();
        yield* subagentRead("toolu_bg", "toolu_bg_read");
        yield taskProgress("agent_bg", "toolu_bg", "Read");
        yield taskNotification("agent_bg", "toolu_bg", "completed");
        yield running();
        yield* assistantTurn("msg_bg_done", [{ type: "text", text: "The review is done." }]);
        yield result({ origin: { kind: "task-notification" } });
        yield idle();
      },
      async function* () {
        yield* assistantTurn("msg_bg_resume", [{ type: "text", text: "Asking for more." }]);
        yield taskUpdated("agent_bg", "running");
        yield taskProgress("agent_bg", "toolu_bg", "Grep");
        yield taskUpdated("agent_bg", "completed");
        yield taskNotification("agent_bg", "toolu_bg", "completed");
        // A second resume registers the task again without naming a tool call.
        yield taskStarted("agent_bg", undefined, background, {
          is_backgrounded: true,
        });
        yield taskNotification("agent_bg", undefined, "completed");
        yield result();
        yield idle();
      },
    ],
  },
  {
    name: "stopped",
    turns: [
      async function* (ctx) {
        yield* toolCall(
          ctx,
          { id: "toolu_stop", name: "Agent", input: { ...background, run_in_background: true } },
          asyncLaunch("agent_stop", background),
        );
        yield taskStarted("agent_stop", "toolu_stop", background, { is_backgrounded: true });
        yield* subagentRead("toolu_stop", "toolu_stop_read");
        yield taskNotification("agent_stop", "toolu_stop", "stopped");
        // A progress beat that raced the stop must not reopen the agent.
        yield taskProgress("agent_stop", "toolu_stop", "Read");
        yield result();
        yield idle();
      },
    ],
  },
  {
    // An interrupt kills a foreground agent; only the patch reports it.
    name: "killed",
    turns: [
      async function* () {
        yield* assistantTurn("msg_kill", [
          { type: "tool_use", id: "toolu_kill", name: "Agent", input: foreground },
        ]);
        yield taskStarted("agent_kill", "toolu_kill", foreground);
        yield taskUpdated("agent_kill", "killed");
        yield result();
        yield idle();
      },
    ],
  },
  {
    // Only the terminal patch is guaranteed for a transition.
    name: "failed",
    turns: [
      async function* () {
        yield* assistantTurn("msg_fail", [
          { type: "tool_use", id: "toolu_fail", name: "Agent", input: foreground },
        ]);
        yield taskStarted("agent_fail", "toolu_fail", foreground);
        yield* subagentRead("toolu_fail", "toolu_fail_read");
        yield toolResult("toolu_fail", [{ type: "text", text: "Rate limited." }], {
          isError: true,
        });
        yield taskUpdated("agent_fail", "failed");
        yield result();
        yield idle();
      },
    ],
  },
  {
    // A reset starts a new conversation; the old one's agents report no end.
    name: "conversation-reset",
    turns: [
      async function* (ctx) {
        yield* toolCall(
          ctx,
          { id: "toolu_before", name: "Agent", input: { ...background, run_in_background: true } },
          asyncLaunch("agent_before", background),
        );
        yield taskStarted("agent_before", "toolu_before", background, { is_backgrounded: true });
        yield {
          type: "conversation_reset",
          new_conversation_id: "22222222-3333-4444-8555-666666666666",
          trigger: "clear",
          uuid: "00000000-0000-4000-8000-0000000000c1",
          session_id: activeSdkSessionId(),
        };
        yield system("background_tasks_changed", { tasks: [] });
        // A late report of the old conversation's agent changes nothing.
        yield taskNotification("agent_before", "toolu_before", "completed");
        yield result();
        yield idle();
      },
      async function* () {
        yield* assistantTurn("msg_after", [
          { type: "tool_use", id: "toolu_after", name: "Agent", input: foreground },
        ]);
        yield taskStarted("agent_after", "toolu_after", foreground);
        yield toolResult("toolu_after", [{ type: "text", text: "Done." }]);
        yield taskUpdated("agent_after", "completed");
        yield result();
        yield idle();
      },
    ],
  },
  {
    // The Claude worker restarted and found the agent orphaned.
    name: "worker-restart",
    turns: [
      async function* (ctx) {
        yield* toolCall(
          ctx,
          { id: "toolu_orphan", name: "Agent", input: { ...background, run_in_background: true } },
          asyncLaunch("agent_orphan", background),
        );
        yield taskStarted("agent_orphan", "toolu_orphan", background, { is_backgrounded: true });
        yield taskNotification("agent_orphan", "toolu_orphan", "stopped", {
          reason: "worker_restart",
        });
        yield result();
        yield idle();
      },
    ],
  },
  {
    // After an adapter restart, SendMessage resumes an agent of an earlier
    // process: Claude registers it again under the SendMessage call.
    name: "resumed-after-restart",
    turns: [
      async function* (ctx) {
        yield* toolCall(
          ctx,
          { id: "toolu_send", name: "SendMessage", input: { to: "agent_old", message: "Go on" } },
          { content: "Message sent.", structured: { success: true } },
        );
        yield taskStarted(
          "agent_old",
          "toolu_send",
          { ...background, prompt: "Go on" },
          {
            is_backgrounded: true,
          },
        );
        yield taskNotification("agent_old", "toolu_send", "completed");
        yield result();
        yield idle();
      },
    ],
  },
  {
    name: "nested",
    turns: [
      async function* () {
        yield* assistantTurn("msg_outer", [
          { type: "tool_use", id: "toolu_outer", name: "Agent", input: outer },
        ]);
        yield taskStarted("agent_outer", "toolu_outer", outer);
        yield* assistantTurn(
          "msg_inner",
          [{ type: "tool_use", id: "toolu_inner", name: "Agent", input: inner }],
          "toolu_outer",
        );
        yield taskStarted("agent_inner", "toolu_inner", inner, {
          parent_task_id: "agent_outer",
          spawn_depth: 2,
        });
        yield* subagentRead("toolu_inner", "toolu_inner_read");
        yield taskProgress("agent_inner", "toolu_inner", "Read");
        yield toolResult("toolu_inner", [{ type: "text", text: "The spec says X." }], {
          parent: "toolu_outer",
        });
        yield taskNotification("agent_inner", "toolu_inner", "completed");
        yield toolResult("toolu_outer", [{ type: "text", text: "Plan: do X." }]);
        yield taskNotification("agent_outer", "toolu_outer", "completed");
        yield result();
        yield idle();
      },
    ],
  },
  {
    name: "background-bash",
    turns: [
      async function* (ctx) {
        yield* toolCall(
          ctx,
          {
            id: "toolu_bash",
            name: "Bash",
            input: { command: "npm test", description: "Run the tests", run_in_background: true },
          },
          {
            content: "Command running in background with ID: bash_1.",
            structured: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "bash_1" },
          },
        );
        yield system("task_started", {
          task_id: "bash_1",
          task_type: "local_bash",
          description: "Run the tests",
          tool_use_id: "toolu_bash",
          is_backgrounded: true,
        });
        yield taskProgress("bash_1", "toolu_bash", "Bash");
        yield taskNotification("bash_1", "toolu_bash", "completed");
        yield result();
        yield idle();
      },
    ],
  },
  {
    // The Claude process dies while a subagent runs.
    name: "process-died",
    turns: [
      async function* () {
        yield* assistantTurn("msg_died", [
          { type: "tool_use", id: "toolu_died", name: "Agent", input: foreground },
        ]);
        yield taskStarted("agent_died", "toolu_died", foreground);
        yield* subagentRead("toolu_died", "toolu_died_read");
        throw new Error("Claude Code process exited with code 1");
      },
    ],
  },
];

const runs = new Map<string, Recorded[]>();
let configDir: string;

beforeAll(async () => {
  for (const name of ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "NO_BROWSER"]) {
    vi.stubEnv(name, "");
  }
  vi.stubEnv("CLAUDE_CODE_REMOTE", "");
  vi.stubEnv("ANTHROPIC_MODEL", "");
  vi.stubEnv("IS_SANDBOX", "1");
  vi.stubEnv("CLAUDE_CODE_EXECUTABLE", "/usr/bin/false");
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-subagents-config-"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
  const { ClaudeAcpAgent } = await import("../acp-agent.js");
  for (const scenario of scenarios) {
    resetIds();
    const run = await runScenario(ClaudeAcpAgent, PROFILES.plain, {
      ...scenario,
      capabilities: JAZ_CAPABILITIES,
    });
    runs.set(scenario.name, run.raw);
  }
}, 30_000);

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(configDir, { recursive: true, force: true });
});

type Update = Record<string, any>;

function updates(scenario: string): Update[] {
  const recorded = runs.get(scenario);
  if (!recorded) {
    throw new Error(`scenario ${scenario} did not run`);
  }
  return recorded.flatMap((record) =>
    record.kind === "sessionUpdate" ? [(record.payload as { update: Update }).update] : [],
  );
}

/** The Subtasks records in the order that the agent sent them. */
function subagentRecords(scenario: string): Update[] {
  return updates(scenario).flatMap((update) =>
    update._meta?.jaz?.providerSubagent ? [update._meta.jaz.providerSubagent] : [],
  );
}

const identity = (id: string, input: ReturnType<typeof agentInput>) => ({
  provider: "claude",
  id,
  status: "running",
  name: input.description,
  role: input.subagent_type,
  prompt: input.prompt,
});

describe("Jaz subagent records", () => {
  it("reports a foreground agent from start to completion", () => {
    expect(subagentRecords("foreground")).toEqual([
      identity("agent_fg", foreground),
      { provider: "claude", id: "agent_fg", status: "running", summary: "Read" },
      { provider: "claude", id: "agent_fg", status: "completed" },
    ]);
  });

  it("sends each record alone on a session_info_update", () => {
    for (const scenario of scenarios.map((s) => s.name)) {
      for (const update of updates(scenario)) {
        if (!update._meta?.jaz) {
          continue;
        }
        expect(Object.keys(update).sort()).toEqual(["_meta", "sessionUpdate"]);
        expect(update.sessionUpdate).toBe("session_info_update");
        expect(Object.keys(update._meta)).toEqual(["jaz"]);
      }
    }
  });

  it("completes a background agent after its launch call returned, and reopens it on resume", () => {
    const sent = updates("background");
    const launchDone = sent.findIndex(
      (update) => update.toolCallId === "toolu_bg" && update.status === "completed",
    );
    const completed = sent.findIndex(
      (update) => update._meta?.jaz?.providerSubagent?.status === "completed",
    );
    expect(launchDone).toBeGreaterThanOrEqual(0);
    expect(completed).toBeGreaterThan(launchDone);
    expect(subagentRecords("background")).toEqual([
      identity("agent_bg", background),
      { provider: "claude", id: "agent_bg", status: "running", summary: "Read" },
      { provider: "claude", id: "agent_bg", status: "completed" },
      { provider: "claude", id: "agent_bg", status: "running" },
      { provider: "claude", id: "agent_bg", status: "running", summary: "Grep" },
      { provider: "claude", id: "agent_bg", status: "completed" },
      identity("agent_bg", background),
      { provider: "claude", id: "agent_bg", status: "completed" },
    ]);
  });

  it("reports a stopped agent as cancelled", () => {
    expect(subagentRecords("stopped")).toEqual([
      identity("agent_stop", background),
      { provider: "claude", id: "agent_stop", status: "cancelled" },
    ]);
    expect(subagentRecords("killed")).toEqual([
      identity("agent_kill", foreground),
      { provider: "claude", id: "agent_kill", status: "cancelled" },
    ]);
  });

  it("reports a failed agent from its terminal patch", () => {
    expect(subagentRecords("failed")).toEqual([
      identity("agent_fail", foreground),
      { provider: "claude", id: "agent_fail", status: "failed" },
    ]);
  });

  it("names a nested agent itself instead of crediting its parent", () => {
    expect(subagentRecords("nested")).toEqual([
      identity("agent_outer", outer),
      identity("agent_inner", inner),
      { provider: "claude", id: "agent_inner", status: "running", summary: "Read" },
      { provider: "claude", id: "agent_inner", status: "completed" },
      { provider: "claude", id: "agent_outer", status: "completed" },
    ]);
  });

  it("leaves background shell tasks out", () => {
    expect(subagentRecords("background-bash")).toEqual([]);
  });

  it("interrupts running agents on a conversation reset and ignores their late reports", () => {
    expect(subagentRecords("conversation-reset")).toEqual([
      identity("agent_before", background),
      { provider: "claude", id: "agent_before", status: "interrupted" },
      identity("agent_after", foreground),
      { provider: "claude", id: "agent_after", status: "completed" },
    ]);
  });

  it("interrupts a running agent when the Claude process dies", () => {
    expect(subagentRecords("process-died")).toEqual([
      identity("agent_died", foreground),
      { provider: "claude", id: "agent_died", status: "interrupted" },
    ]);
  });

  it("reports an agent that a worker restart orphaned as interrupted, not cancelled", () => {
    expect(subagentRecords("worker-restart")).toEqual([
      identity("agent_orphan", background),
      { provider: "claude", id: "agent_orphan", status: "interrupted" },
    ]);
  });

  it("keeps an agent's record when SendMessage resumes it after an adapter restart", () => {
    expect(subagentRecords("resumed-after-restart")).toEqual([
      identity("agent_old", { ...background, prompt: "Go on" }),
      { provider: "claude", id: "agent_old", status: "completed" },
    ]);
  });
});
