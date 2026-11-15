import { RequestError, type SessionNotification } from "@agentclientprotocol/sdk/unstable";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { resultEnd } from "../result-end.js";
import { isTaskNotificationRecord } from "../task-notifications.js";
import { quotaMeta, tallyTotal, type ModelTokenTally } from "../session-usage.js";
import type { TurnOutcome } from "./turn-events.js";

export type WorkEnd = { outcome: TurnOutcome } | { error: unknown };

type WorkState =
  | { state: "running" | "requires_action" }
  | ({ state: "idle" } & TurnOutcome)
  | {
      state: "idle";
      stopReason: "error";
      error: { code: number; message: string; data?: unknown };
    };

type TaskState = {
  tasksTakenIn?: string[];
  taskRunIds?: Map<string, string>;
};

export function jazWorkState(
  sessionId: string,
  send: (notification: SessionNotification) => Promise<void>,
  session: () => TaskState | undefined,
) {
  const publish = (stateUpdate: WorkState) => {
    const current = session();
    const tasks = current?.tasksTakenIn ?? [];
    if (current) current.tasksTakenIn = [];
    void send({
      sessionId,
      update: {
        sessionUpdate: "session_info_update",
        _meta: { jaz: { stateUpdate: { ...stateUpdate, tasks } } },
      },
    });
  };
  return {
    running() {
      publish({ state: "running" });
    },
    awaitingUser() {
      publish({ state: "requires_action" });
    },
    end(end: WorkEnd) {
      if ("outcome" in end) {
        publish({ state: "idle", ...end.outcome });
      } else {
        const error = end.error;
        publish({
          state: "idle",
          stopReason: "error",
          error:
            error instanceof RequestError
              ? {
                  code: error.code,
                  message: error.message,
                  ...(error.data !== undefined ? { data: error.data } : {}),
                }
              : {
                  code: RequestError.internalError().code,
                  message: error instanceof Error ? error.message : String(error),
                },
        });
      }
    },
  };
}

export function noteTaskTakenIn(session: TaskState, message: SDKMessage): void {
  if ((message.type !== "user" && message.type !== "result") || !isTaskNotificationRecord(message))
    return;
  const origin = message.origin;
  for (const [task, run] of session.taskRunIds ?? []) {
    if (run === origin?.runId) {
      (session.tasksTakenIn ??= []).push(task);
      return;
    }
  }
}

export function autonomousCycleEnd(
  result: Extract<SDKMessage, { type: "result" }>,
  modelUsage: ModelTokenTally,
  cancelled: boolean,
): WorkEnd {
  const end = cancelled ? { stopReason: "cancelled" as const } : resultEnd(result);
  if ("error" in end) return { error: RequestError.internalError(undefined, end.error) };
  const tally = {
    inputTokens: result.usage.input_tokens ?? 0,
    outputTokens: result.usage.output_tokens ?? 0,
    cachedReadTokens: result.usage.cache_read_input_tokens ?? 0,
    cachedWriteTokens: result.usage.cache_creation_input_tokens ?? 0,
  };
  return {
    outcome: {
      stopReason: end.stopReason,
      usage: { ...tally, totalTokens: tallyTotal(tally) },
      _meta: quotaMeta(tally, modelUsage),
    },
  };
}
