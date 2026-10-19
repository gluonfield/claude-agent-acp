import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { ForegroundEvents } from "./turn-events.js";
import { v2Foreground } from "./v2/prompt.js";

/**
 * Reports the foreground work of the session `sessionId` to an ACP v1 client
 * as the `state_update`s that ACP v2 sends (see `v2Foreground`), each one in a
 * `session_info_update` that carries only `_meta.jaz.stateUpdate`. v1 has no
 * session state, so without it a client sees a model cycle that Claude Code
 * starts on its own, such as its follow-up after a background command
 * finished, only as output, with nothing to say when the cycle ends.
 */
export function jazWorkState(
  sessionId: string,
  send: (notification: SessionNotification) => Promise<void>,
): ForegroundEvents {
  return v2Foreground(({ sessionUpdate: _, ...stateUpdate }) => {
    void send({
      sessionId,
      update: { sessionUpdate: "session_info_update", _meta: { jaz: { stateUpdate } } },
    });
  });
}
