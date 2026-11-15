import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeAcpAgent } from "../../v1/acp-agent.js";
import type { AcpClient } from "../../acp-client.js";
import { initializeClient } from "../helpers.js";
import { successfulResultMessage } from "./session-doubles.js";

const execFileSpy = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: execFileSpy };
});

/** What the mocked Claude Agent SDK answers. Reset before each test. */
const sdk = vi.hoisted(() => ({
  run: async function* (
    _prompts: AsyncIterable<SDKUserMessage>,
    _options: Options,
  ): AsyncGenerator<Record<string, unknown>> {},
  models: [
    { value: "claude-sonnet-4-6", displayName: "Claude Sonnet", description: "Fast" },
    { value: "claude-opus-4-6", displayName: "Claude Opus", description: "Smart" },
  ] as Array<Record<string, unknown>>,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  const { makeMockQuery } = await import("../helpers.js");
  return {
    ...actual,
    query: ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      const messages = sdk.run(prompt, options);
      const controls = makeMockQuery({
        [Symbol.asyncIterator]: () => messages,
        initializationResult: async () => ({ models: sdk.models }),
      });
      return Object.assign(messages, controls);
    },
    getSessionMessages: vi.fn(async () => []),
  };
});

vi.mock("../../tools.js", async () => ({
  ...(await vi.importActual<typeof import("../../tools.js")>("../../tools.js")),
  registerHookCallback: vi.fn(),
}));

const MINUTE_MS = 60_000;
const AIR_CLIENT_CAPABILITIES = {
  _meta: { jetbrains: { air: { version: 1, capabilities: [] as string[] } } },
};

/** As the CLI reports a request whose prompt cache lives one hour: 250k tokens of context. */
const LARGE_ONE_HOUR_USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 250_000,
  cache_creation: { ephemeral_1h_input_tokens: 250_000, ephemeral_5m_input_tokens: 0 },
};

let tempDir: string;
let cwd: string;

beforeEach(async () => {
  execFileSpy.mockImplementation((...invocation: unknown[]) => {
    const callback = invocation[invocation.length - 1] as (...a: unknown[]) => void;
    callback(null, { stdout: "", stderr: "" });
  });
  tempDir = await mkdtemp(path.join(os.tmpdir(), "provider-compaction-"));
  cwd = await mkdtemp(path.join(tempDir, "project-"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(tempDir, "claude"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(async () => {
  vi.useRealTimers();
  execFileSpy.mockReset();
  vi.unstubAllEnvs();
  await rm(tempDir, { recursive: true, force: true, maxRetries: 10 });
});

function assistant(
  options: Options,
  usage: Record<string, unknown>,
  parent: string | null = null,
  id = `msg_${randomUUID()}`,
) {
  return {
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "Done." }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage,
    },
    parent_tool_use_id: parent,
    uuid: randomUUID(),
    session_id: options.sessionId,
  };
}

function system(options: Options, subtype: string, fields: Record<string, unknown>) {
  return { type: "system", subtype, ...fields, uuid: randomUUID(), session_id: options.sessionId };
}

/** The `user` message Claude Code replays for a prompt it took in. */
function echo(value: SDKUserMessage, options: Options) {
  return {
    type: "user",
    message: value.message,
    parent_tool_use_id: null,
    uuid: value.uuid,
    session_id: options.sessionId,
    isReplay: true,
  };
}

function scriptClaudeCode(trigger: "manual" | "auto" = "manual") {
  const received: string[] = [];
  /** Resolves each time the consumer has handled an `idle` message. */
  let idleHandled = Promise.withResolvers<void>();
  sdk.run = async function* (prompts, options) {
    const input = prompts[Symbol.asyncIterator]();
    for (;;) {
      const { value, done } = await input.next();
      if (done) return;
      const text = (value.message.content as Array<{ text: string }>)[0].text;
      received.push(text);
      if (text === "/compact" || trigger === "auto") {
        yield system(options, "status", { status: "compacting" });
        yield system(options, "compact_boundary", {
          compact_metadata: { trigger, pre_tokens: 250_000, post_tokens: 12_000 },
        });
        yield system(options, "status", { status: null, compact_result: "success" });
      } else {
        yield echo(value, options);
        yield assistant(options, LARGE_ONE_HOUR_USAGE);
      }
      yield successfulResultMessage({ session_id: options.sessionId });
      yield system(options, "session_state_changed", { state: "idle" });
      idleHandled.resolve();
    }
  };
  return {
    received,
    /** Waits until the consumer has handled an `idle`, then re-arms for the next. */
    async untilIdle() {
      await idleHandled.promise;
      idleHandled = Promise.withResolvers();
    },
  };
}

async function connect(
  clientCapabilities: Record<string, unknown> = {},
  sessionMeta?: Record<string, unknown>,
) {
  vi.resetModules();
  const { ClaudeAcpAgent } = await import("../../v1/acp-agent.js");
  const updates: Array<{ update: Record<string, any> }> = [];
  const client = {
    sessionUpdate: async (notification: { update: Record<string, any> }) => {
      updates.push(notification);
    },
  } as unknown as AcpClient;
  const agent: ClaudeAcpAgent = new ClaudeAcpAgent(client, {
    log: () => {},
    error: () => {},
  });
  await initializeClient(agent, clientCapabilities);
  const session = await agent.newSession({ cwd, mcpServers: [], _meta: sessionMeta });
  return { agent, sessionId: session.sessionId, updates };
}

async function promptHi(agent: ClaudeAcpAgent, id: string) {
  await agent.prompt({ sessionId: id, prompt: [{ type: "text", text: "hi" }] });
}

describe("provider-owned compaction", () => {
  it("adds no prompt when a large one-hour request becomes idle", async () => {
    const claude = scriptClaudeCode();
    const { agent, sessionId } = await connect();
    await promptHi(agent, sessionId);
    await claude.untilIdle();
    await vi.advanceTimersByTimeAsync(60 * MINUTE_MS);
    expect(claude.received).toEqual(["hi"]);
    await agent.dispose();
  });

  it.each([
    { prompt: "/compact", trigger: "manual", expected: "manual" },
    { prompt: "hi", trigger: "auto", expected: "automatic" },
  ] as const)("forwards the native $trigger compaction", async ({ prompt, trigger, expected }) => {
    const claude = scriptClaudeCode(trigger);
    const { agent, sessionId, updates } = await connect(AIR_CLIENT_CAPABILITIES);
    await agent.prompt({ sessionId, prompt: [{ type: "text", text: prompt }] });
    await claude.untilIdle();
    const triggers = updates.flatMap(({ update }) => {
      const value = update._meta?.jetbrains?.air?.contextCompaction?.trigger;
      return value ? [value] : [];
    });
    expect(triggers).toEqual([expected]);
    expect(claude.received).toEqual([prompt]);
    await agent.dispose();
  });
});
