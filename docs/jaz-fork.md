# Jaz fork

This fork is upstream [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp)
plus the patches below. Keep each one through an upstream merge until upstream covers it.

| Patch                     | Where                                                                            | Why it stays                                                                                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_session/mcp/refresh`    | `src/mcp-refresh.ts`, `refreshMcpServers`                                        | Before a turn, Jaz reconnects the native MCP servers whose configuration changed. Upstream reconnects only through the `/mcp reconnect` slash command, which is a prompt turn.          |
| Context window unknown    | `cachedContextWindow`, `getMatchingModelUsage`                                   | The window is `0` until Claude reports it. Upstream seeds 200,000 or guesses 1,000,000 from a "1m" in the model name, and reads `getContextUsage` in the background.                    |
| Native Default effort     | `src/session-effort.ts`, `applyConfigOptionValue`                                | The effort selector keeps `default`, so Claude Code resolves effort itself. Upstream recommends `medium` to a `recommendedValue` client and writes it to the SDK.                       |
| Reported model resolution | `resolveReportedModel` in `src/session-model.ts`                                 | A model that Claude reports maps to the row with that id or resolved model, then to one that differs only by the context suffix. Upstream's preference matching can pick a sibling row. |
| Jaz Subtasks records      | `src/subagents.ts`                                                               | See below.                                                                                                                                                                              |
| Standalone releases       | `.github/workflows/release-standalone.yml`, `script/build-standalone-release.sh` | Jaz installs platform archives that bundle Claude Code. The npm, release-please and preview workflows are upstream's and are removed.                                                   |

The scenario baseline comparison drops these wire differences in one call, `withoutJazFork` in
`src/tests/acp-scenarios/compare.ts`.

## Subagents

`JazSubagentReporter` turns Claude Code's `task_started`, `task_progress`, `task_notification` and
`task_updated` for agent tasks into a `session_info_update` that carries only
`_meta.jaz.providerSubagent`. A record is keyed by Claude's agent id, the SDK task id, which a
resumed agent keeps across adapter restarts. An agent still running when the Claude stream ends is
`cancelled`, which is how Jaz closes an agent whose process went away.

Upstream's native subagent sessions do not replace it yet:

- Jaz declares `_meta.jetbrains.air` for `asyncTasks`, `recommendedValue` and AIR's custom answers.
  Upstream gives any AIR client the earlier AIR draft (`subagent_spawned`), never the subagents RFD.
- The RFD form declares `perTaskStopAffordance`, so a parent cancel no longer stops background
  subagents. A client must stop each one with `session/cancel` on its child session.
- Both forms move a child's updates and its permission and question requests to the child session
  id. Jaz routes one ACP session per thread and rejects requests for an unknown session.

Move to the RFD once Jaz routes child sessions, offers a Stop for each subagent, and upstream gives
the RFD to a client with AIR extensions or Jaz no longer needs them. Then delete `src/subagents.ts`.

## Native parity, 0.93.0-jaz.1

Validated on macOS arm64 on 2026-10-18 with the subscription OAuth profile Jaz uses, against the
released 0.89.1-jaz.2. The probe declares Jaz's client capabilities, selects `opus[1m]`, and asks
Claude to read a fixture with its file tool. No API key was used.

| Check                               | 0.89.1-jaz.2             | 0.93.0-jaz.1                |
| ----------------------------------- | ------------------------ | --------------------------- |
| Claude Code                         | 2.1.296                  | 2.1.300                     |
| Claude Code arguments and env names | identical                | identical                   |
| Model                               | `claude-opus-5-5`, 1M    | `claude-opus-5-5`, 1M       |
| Context window shown                | unknown, then 1,000,000  | unknown, then 1,000,000     |
| Tools and agents                    | 28 tools, 5 agents       | the same 28 tools, 5 agents |
| First user prompt                   | one, 107 bytes           | one, 107 bytes              |
| First turn input, including cache   | 55,607 tokens            | 55,835 tokens               |
| File read                           | fixture token            | fixture token               |
| Authentication                      | subscription, no API key | subscription, no API key    |

The 228-token difference is Claude Code's: 0.89.1-jaz.2 running Claude Code 2.1.300 sends the same
55,835. The only other difference in what the adapter sends Claude Code is `promptSuggestions: true`
in its `initialize` request, upstream's default since 0.92.0. Over three turns with suggestions on,
Claude Code 2.1.300 sent no suggestion and used the same tokens as with them off.
