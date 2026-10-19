import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { isTaskNotificationRecord, type Session } from "./acp-agent.js";
import type { ForegroundEvents } from "./turn-events.js";
import { v2Foreground } from "./v2/prompt.js";

/**
 * Reports the foreground work of the session `sessionId` to an ACP v1 client
 * as the `state_update`s that ACP v2 sends (see `v2Foreground`), each one in a
 * `session_info_update` that carries only `_meta.jaz.stateUpdate`. v1 has no
 * session state, so without it a client sees a model cycle that Claude Code
 * starts on its own, such as its follow-up after a background command
 * finished, only as output, with nothing to say when the cycle ends. Each
 * report names, as `tasks`, the background tasks whose end the work took in
 * since the session's last report, so a client knows whom the work answers.
 */
export function jazWorkState(
  sessionId: string,
  send: (notification: SessionNotification) => Promise<void>,
  session: () => Pick<Session, "tasksTakenIn"> | undefined,
): ForegroundEvents {
  return v2Foreground(({ sessionUpdate: _, ...stateUpdate }) => {
    const current = session();
    const tasks = current?.tasksTakenIn ?? [];
    if (current) {
      current.tasksTakenIn = [];
    }
    void send({
      sessionId,
      update: {
        sessionUpdate: "session_info_update",
        _meta: { jaz: { stateUpdate: { ...stateUpdate, tasks } } },
      },
    });
  });
}

/**
 * Records the task whose end `message` tells the model of, for the next report
 * of `jazWorkState`. Claude Code echoes each task notification it takes into
 * a model call, and names the notification a run of its own began with in the
 * run's result; both carry the task run's id as `origin.runId`, which
 * `taskRunIds` maps to its task.
 */
export function noteTaskTakenIn(session: Session, message: SDKMessage): void {
  if (
    (message.type !== "user" && message.type !== "result") ||
    !isTaskNotificationRecord(message)
  ) {
    return;
  }
  const runId = (message as { origin: { runId?: string } }).origin.runId;
  for (const [task, run] of session.taskRunIds ?? []) {
    if (run === runId) {
      (session.tasksTakenIn ??= []).push(task);
      return;
    }
  }
}
