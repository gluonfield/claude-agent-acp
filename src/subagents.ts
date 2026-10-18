import type { SessionNotification } from "@agentclientprotocol/sdk";
import type {
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKTaskUpdatedMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { isSubagentTask } from "./async-tasks.js";

/** `interrupted`: the agent stopped running for a reason Claude Code did not
 *  report, such as the Claude process exiting or restarting. */
type SubagentStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

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
  ) {}

  async taskStarted(message: SDKTaskStartedMessage): Promise<void> {
    if (!isSubagentTask(message)) {
      return;
    }
    this.tasks.set(message.task_id, { status: "running" });
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
    await this.setStatus(message.task_id, notificationStatus(message));
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
        await this.setStatus(taskId, "interrupted");
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

function notificationStatus(message: SDKTaskNotificationMessage): SubagentStatus {
  if (message.status !== "stopped") {
    return message.status;
  }
  // A worker restart found the task orphaned; nobody stopped it.
  return message.reason === "worker_restart" ? "interrupted" : "cancelled";
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
