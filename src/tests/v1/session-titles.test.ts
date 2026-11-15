import { describe, it, expect, beforeEach, vi } from "vitest";
import { ClaudeAcpAgent } from "../../v1/acp-agent.js";
import type { AcpClient } from "../../acp-client.js";
import { sanitizeTitle } from "../../session-titles.js";
import { Pushable } from "../../utils.js";
import { getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  mockSessionState,
  successfulResultMessage,
  userEcho,
  wrapQuery,
} from "./session-doubles.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...actual, getSessionInfo: vi.fn() };
});

describe("sanitizeTitle", () => {
  /** The sanitizer before it learned to read only the start of a long text. */
  function fullScanTitle(text: string): string {
    const sanitized = text
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return sanitized.length <= 256 ? sanitized : sanitized.slice(0, 255) + "…";
  }

  it("gives a long text the same title as a scan of the whole text", () => {
    const texts = [
      "lorem ipsum dolor sit amet\n".repeat(400_000),
      " \n\t".repeat(3000) + "word ".repeat(2000),
      // The cut of the scanned prefix falls inside a run of whitespace.
      "x".repeat(300) + " ".repeat(5000) + "tail",
      // Mostly whitespace: the prefix collapses below a title's length.
      "a ".repeat(100) + " ".repeat(10_000) + "b".repeat(300),
      " ".repeat(10_000) + "short",
      "\u00a0\ufeff".repeat(2100) + "😀".repeat(2000),
      "y".repeat(4095) + "😀".repeat(10),
      "z".repeat(257) + " ".repeat(4096),
      "z".repeat(256) + " ".repeat(4096),
    ];
    for (const text of texts) {
      expect(sanitizeTitle(text)).toBe(fullScanTitle(text));
    }
  });
});

describe("session titles", () => {
  beforeEach(() => {
    vi.mocked(getSessionInfo).mockReset();
  });

  /** Collect every `session_info_update` an agent pushes. */
  function titleRecorder() {
    const updates: any[] = [];
    const client = {
      sessionUpdate: async (u: any) => {
        if (u.update?.sessionUpdate === "session_info_update") updates.push(u.update);
      },
    } as unknown as AcpClient;
    return { client, titles: () => updates.map((u) => u.title) };
  }

  /** One turn: echo the pushed prompt, succeed, go idle. */
  async function* oneTurn(input: Pushable<any>, turns = 1) {
    const iter = input[Symbol.asyncIterator]();
    for (let i = 0; i < turns; i++) {
      const { value: userMessage } = await iter.next();
      yield userEcho(userMessage);
      yield successfulResultMessage();
      yield { type: "system", subtype: "session_state_changed", state: "idle" };
    }
  }

  function newAgent(client: AcpClient) {
    return new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
  }

  /** Sends the current title of `test-session` (see `SessionTitles.publishCurrent`). */
  async function publishCurrentSessionInfo(agent: ClaudeAcpAgent) {
    const session = agent.sessions["test-session"]!;
    await session.titles.publishCurrent(session);
  }

  it.each([false, true])(
    "publishes the stored summary without model calls (resumed: %s)",
    async (resumedFromHistory) => {
      const sessionUpdates: any[] = [];
      const agent = newAgent({
        sessionUpdate: async (u: any) => {
          sessionUpdates.push(u);
        },
      } as unknown as AcpClient);

      vi.mocked(getSessionInfo).mockResolvedValue({
        sessionId: "test-session",
        summary: "Fix the flaky title test",
        lastModified: 1_700_000_000_000,
      } as any);

      const input = new Pushable<any>();
      const generateSessionTitle = vi.fn(async () => "Adapter-generated title");
      agent.sessions["test-session"] = mockSessionState(
        {
          query: Object.assign(wrapQuery(oneTurn(input)), { generateSessionTitle }),
          input,
          resumedFromHistory,
        },
        agent,
      );

      await agent.prompt({
        sessionId: "test-session",
        prompt: [{ type: "text", text: "Please fix the flaky title test" }],
      });
      await agent.sessions["test-session"]?.consumer;

      const titleUpdate = sessionUpdates.find(
        (u) => u.update?.sessionUpdate === "session_info_update",
      );
      expect(titleUpdate?.update).toEqual({
        sessionUpdate: "session_info_update",
        title: "Fix the flaky title test",
        updatedAt: new Date(1_700_000_000_000).toISOString(),
      });
      expect(generateSessionTitle).not.toHaveBeenCalled();
      expect(getSessionInfo).toHaveBeenCalledWith("test-session", { dir: "/test" });
    },
  );

  it("does not re-push session_info_update when the title is unchanged", async () => {
    const { client, titles } = titleRecorder();
    const agent = newAgent(client);

    vi.mocked(getSessionInfo).mockResolvedValue({
      sessionId: "test-session",
      summary: "Stable title",
      lastModified: 1_700_000_000_000,
    } as any);

    const input = new Pushable<any>();
    agent.sessions["test-session"] = mockSessionState(
      {
        query: wrapQuery(oneTurn(input, 2)),
        input,
      },
      agent,
    );

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "one" }] });
    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "two" }] });
    await agent.sessions["test-session"]?.consumer;

    expect(titles()).toEqual(["Stable title"]);
  });

  it("sends the current title and updatedAt on request, even when already sent", async () => {
    const updates: any[] = [];
    const agent = newAgent({
      sessionUpdate: async (u: any) => {
        updates.push(u.update);
      },
    } as unknown as AcpClient);
    vi.mocked(getSessionInfo).mockResolvedValue({
      sessionId: "test-session",
      summary: "Fix the\nbuild",
      lastModified: 1_700_000_000_000,
    } as any);
    const input = new Pushable<any>();
    agent.sessions["test-session"] = mockSessionState(
      { query: wrapQuery(oneTurn(input)), input },
      agent,
    );

    await publishCurrentSessionInfo(agent);
    await publishCurrentSessionInfo(agent);

    const current = {
      sessionUpdate: "session_info_update",
      title: "Fix the build",
      updatedAt: new Date(1_700_000_000_000).toISOString(),
    };
    expect(updates).toEqual([current, current]);
    expect(getSessionInfo).toHaveBeenCalledWith("test-session", { dir: "/test" });
  });

  it("sends the last published title without updatedAt when the session has no file", async () => {
    const { client, titles } = titleRecorder();
    const agent = newAgent(client);
    const input = new Pushable<any>();
    agent.sessions["test-session"] = mockSessionState(
      { query: wrapQuery(oneTurn(input)), input },
      agent,
    );

    // No file and no title yet: nothing to send.
    vi.mocked(getSessionInfo).mockResolvedValue(undefined);
    await publishCurrentSessionInfo(agent);
    expect(titles()).toEqual([]);

    await agent.sessions["test-session"]!.titles.setExplicitTitle("Renamed", async () => undefined);
    await publishCurrentSessionInfo(agent);
    expect(titles()).toEqual(["Renamed", "Renamed"]);
  });

  it("sends a published title that isn't stored yet instead of the raw first prompt", async () => {
    const { client, titles } = titleRecorder();
    const agent = newAgent(client);
    const input = new Pushable<any>();
    agent.sessions["test-session"] = mockSessionState(
      { query: wrapQuery(oneTurn(input)), input },
      agent,
    );
    await agent.sessions["test-session"]!.titles.setExplicitTitle("Renamed", async () => undefined);

    // The file has no custom title yet, so `summary` is the raw first prompt.
    vi.mocked(getSessionInfo).mockResolvedValue({
      sessionId: "test-session",
      summary: "please fix the build",
      lastModified: 1_700_000_000_000,
    } as any);
    await publishCurrentSessionInfo(agent);

    expect(titles()).toEqual(["Renamed", "Renamed"]);
  });
});
