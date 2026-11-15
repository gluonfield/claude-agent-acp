import type { SessionNotification } from "@agentclientprotocol/sdk";
import type {
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKTaskUpdatedMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { isSubagentTask } from "./async-tasks.js";
import { isNativeSubagentControlTool } from "./native-subagents.js";

/** `cancelled` also covers an agent that stopped for a reason Claude Code did
 *  not report, as Jaz closes an agent whose process went away. */
type SubagentStatus = "running" | "completed" | "failed" | "cancelled";

/** The Jaz Subtasks record of one Claude subagent, keyed by its agent id (the
 *  SDK task id), which a resumed agent keeps, also after an adapter restart. */
export type JazProviderSubagent = {
  provider: "claude";
  id: string;
  status: SubagentStatus;
  name?: string;
  role?: string;
  prompt?: string;
  summary?: string;
};

type TrackedSubagent = {
  status: SubagentStatus;
  summary?: string;
};

/**
 * Reports Claude subagents to Jaz from the SDK task lifecycle: identity from
 * `task_started`, activity from `task_progress`, and the end from
 * `task_notification` or a terminal `task_updated` patch. Each change goes out
 * as a `session_info_update` that carries only `_meta.jaz.providerSubagent`.
 */
export class JazSubagentReporter {
  /** Subagent tasks by task id. `task_updated` names only the task, and only
   *  `task_started` says that a task is an agent. */
  private readonly tasks = new Map<string, TrackedSubagent>();

  constructor(
    private readonly sessionId: string,
    private readonly send: (notification: SessionNotification) => Promise<void>,
    private readonly toolNameOf: (toolCallId: string) => string | undefined,
  ) {}

  async taskStarted(message: SDKTaskStartedMessage): Promise<void> {
    if (!isSubagentTask(message)) {
      return;
    }
    this.tasks.set(message.task_id, { status: "running" });
    // A SendMessage that resumes an agent, also one that an earlier adapter
    // process launched, keeps the name and prompt of the Agent call.
    const launcher = message.tool_use_id ? this.toolNameOf(message.tool_use_id) : undefined;
    if (launcher !== undefined && !isNativeSubagentControlTool(launcher)) {
      await this.publish({ provider: "claude", id: message.task_id, status: "running" });
      return;
    }
    const name = nonBlank(message.description);
    const role = nonBlank(message.subagent_type);
    const prompt = nonBlank(message.prompt);
    await this.publish({
      provider: "claude",
      id: message.task_id,
      status: "running",
      ...(name ? { name } : {}),
      ...(role ? { role } : {}),
      ...(prompt ? { prompt } : {}),
    });
  }

  async taskProgress(message: SDKTaskProgressMessage): Promise<void> {
    const task = this.tasks.get(message.task_id);
    if (!task || task.status !== "running") {
      return;
    }
    const summary = nonBlank(message.summary) ?? nonBlank(message.last_tool_name);
    if (!summary || summary === task.summary) {
      return;
    }
    await this.publish({ provider: "claude", id: message.task_id, status: "running", summary });
    task.summary = summary;
  }

  async taskNotification(message: SDKTaskNotificationMessage): Promise<void> {
    await this.setStatus(
      message.task_id,
      message.status === "stopped" ? "cancelled" : message.status,
    );
  }

  async taskUpdated(message: SDKTaskUpdatedMessage): Promise<void> {
    const status = patchStatus(message.patch.status);
    if (status) {
      await this.setStatus(message.task_id, status);
    }
  }

  /** Ends every running agent: the Claude stream ended with them. */
  async finishAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const [taskId, task] of this.tasks) {
      if (task.status !== "running") {
        continue;
      }
      try {
        await this.setStatus(taskId, "cancelled");
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to publish Jaz subagent state");
    }
  }

  /** Forgets every task: a new conversation starts its own task ids. */
  clear(): void {
    this.tasks.clear();
  }

  private async setStatus(taskId: string, status: SubagentStatus): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || task.status === status) {
      return;
    }
    await this.publish({ provider: "claude", id: taskId, status });
    task.status = status;
  }

  private async publish(providerSubagent: JazProviderSubagent): Promise<void> {
    await this.send({
      sessionId: this.sessionId,
      update: { sessionUpdate: "session_info_update", _meta: { jaz: { providerSubagent } } },
    });
  }
}

/** The SDK resumes a finished subagent under the same task id with a running patch. */
function patchStatus(status: SDKTaskUpdatedMessage["patch"]["status"]): SubagentStatus | undefined {
  switch (status) {
    case "pending":
    case "running":
      return "running";
    case "completed":
    case "failed":
      return status;
    case "killed":
      return "cancelled";
    default:
      return undefined;
  }
}

function nonBlank(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}
