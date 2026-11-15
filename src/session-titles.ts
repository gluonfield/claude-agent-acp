import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";
import { getSessionInfo, type Query, type SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { ExplicitTitle } from "./session-index/explicit-title.js";

export interface TitledSession {
  readonly query: Query;
  readonly queryClosed?: boolean;
  readonly cwd: string;
}

export interface TitleOwner {
  readonly client: { sessionUpdate(notification: SessionNotification): Promise<void> };
  readonly logger: { error: (...args: any[]) => void };
  clientTitle?(title: string): string;
}

const MAX_TITLE_LENGTH = 256;

/** How much of a long text {@link sanitizeTitle} reads first. Collapsed, it
 *  is longer than a title unless it is mostly whitespace. */
const TITLE_SCAN_LENGTH = 4096;

export function sanitizeTitle(text: string): string {
  if (text.length > TITLE_SCAN_LENGTH) {
    // A stored summary can be a whole first prompt of megabytes. The title
    // depends only on the start of the text: collapsing the whitespace of a
    // prefix gives a prefix of the collapsed text. Two more characters than a
    // title hold at least one that is not a space (spaces are collapsed), so
    // the full text is longer than a title and gets the same cut.
    const head = text.slice(0, TITLE_SCAN_LENGTH).replace(/\s+/g, " ").trimStart();
    if (head.length >= MAX_TITLE_LENGTH + 2) {
      return head.slice(0, MAX_TITLE_LENGTH - 1) + "…";
    }
  }
  // Replace newlines and collapse whitespace
  const sanitized = text
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (sanitized.length <= MAX_TITLE_LENGTH) {
    return sanitized;
  }
  return sanitized.slice(0, MAX_TITLE_LENGTH - 1) + "…";
}

export class SessionTitles {
  private lastTitle?: string;
  private settled = false;
  private readonly explicit = new ExplicitTitle();
  private persistedTitle?: string;

  get storedTitle(): string | undefined {
    return this.persistedTitle;
  }

  get shownTitle(): string | undefined {
    return this.lastTitle;
  }

  constructor(
    private readonly agent: TitleOwner,
    private readonly sessionId: string,
  ) {}

  reset(): void {
    this.settled = false;
    this.explicit.reset();
    this.lastTitle = undefined;
    this.persistedTitle = undefined;
  }

  async onTurnEnd(session: TitledSession): Promise<void> {
    if (this.explicit.settledByClient) {
      const renames = this.explicit.renames;
      const info = await this.readSessionInfo(session);
      const stored = info?.customTitle;
      if (stored && this.explicit.settledByClient && this.explicit.renames === renames) {
        await this.publish(stored, info.lastModified);
      }
      return;
    }
    if (this.explicit.active) return;
    const renames = this.explicit.renames;
    const info = await this.readSessionInfo(session);
    if (this.explicit.active || this.explicit.renames !== renames) return;
    if (info?.customTitle) {
      this.settled = true;
      await this.publish(info.customTitle, info.lastModified);
    } else if (info?.summary && !this.settled) {
      await this.publish(info.summary, info.lastModified);
    }
  }

  async setExplicitTitle(
    publish: string | ((stored: string | undefined) => string) | undefined,
    persist: () => Promise<string | undefined | void>,
  ): Promise<void> {
    let stored: string | undefined;
    await this.explicit.apply(async () => {
      stored = (await persist()) ?? undefined;
      if (stored !== undefined) this.persistedTitle = stored;
      const named = stored !== undefined || publish !== undefined;
      if (named) this.settled = true;
      return named;
    });
    const title = typeof publish === "function" ? publish(stored) : publish;
    if (title === undefined) return;
    this.lastTitle = title;
    await this.agent.client.sessionUpdate({
      sessionId: this.sessionId,
      update: { sessionUpdate: "session_info_update", title },
    });
  }

  async publishCurrent(session: TitledSession): Promise<void> {
    const info = await this.readSessionInfo(session);
    const stored =
      info?.customTitle || (this.settled && this.lastTitle ? undefined : info?.summary);
    const title = stored
      ? sanitizeTitle(this.agent.clientTitle?.(stored) ?? stored)
      : this.lastTitle;
    if (!title) return;
    this.lastTitle = title;
    await this.agent.client.sessionUpdate({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "session_info_update",
        title,
        ...(info ? { updatedAt: new Date(info.lastModified).toISOString() } : {}),
      },
    });
  }

  rememberStoredTitle(title: string): void {
    this.persistedTitle = title;
  }

  private async readSessionInfo(session: TitledSession): Promise<SDKSessionInfo | undefined> {
    try {
      return await getSessionInfo(this.sessionId, { dir: session.cwd });
    } catch (error) {
      this.agent.logger.error(`Session ${this.sessionId}: failed to read session info: ${error}`);
      return undefined;
    }
  }

  private async publish(rawTitle: string, lastModified: number): Promise<void> {
    const title = sanitizeTitle(this.agent.clientTitle?.(rawTitle) ?? rawTitle);
    if (title === this.lastTitle) return;
    this.lastTitle = title;
    await this.agent.client.sessionUpdate({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "session_info_update",
        title,
        updatedAt: new Date(lastModified).toISOString(),
      },
    });
  }
}
