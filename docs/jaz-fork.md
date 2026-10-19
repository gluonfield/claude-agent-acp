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
| v1 work state             | `src/work-state.ts`, `v1AgentApp`, `workEndReported`                             | v1 has no session state, so Jaz cannot tell when a model cycle that Claude Code starts on its own begins and ends. See below.                                                           |
| Standalone releases       | `.github/workflows/release-standalone.yml`, `script/build-standalone-release.sh` | Jaz installs platform archives that bundle Claude Code. The npm, release-please and preview workflows are upstream's and are removed.                                                   |

The scenario baseline comparison drops these wire differences in one call, `withoutJazFork` in
`src/tests/acp-scenarios/compare.ts`.

## Work state

`jazWorkState` reports a v1 session's foreground work as the `state_update`s that ACP v2 sends,
each in a `session_info_update` that carries only `_meta.jaz.stateUpdate`: `running` when a
prompt's turn is taken in, or when a cycle that Claude Code starts on its own (such as its
follow-up after a background command finished) gives its first output; `requires_action` while a
request waits; `idle` with the stop reason, usage and `_meta`, or with the `error` stop reason and
the JSON-RPC error, at the work's result. A turn's `idle` comes before its v1 prompt response. A
prompt taken in while a cycle runs takes the cycle over, and the work reports its `idle` at the
turn's result. `workEndReported` keys on `this.v2` rather than on the reporter, so the report
leaves v1's cancel handling as upstream has it. Upstream reports this state only under ACP v2; drop
the patch once Jaz speaks v2.

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

Validated on macOS arm64 on 2026-10-18 with the subscription OAuth profile Jaz uses. No API key
was used. Each run selects `opus[1m]` and asks Claude to read a fixture with its file tool; the ACP
runs declare Jaz's client capabilities.

| Check                             | Claude Code 2.1.300, `-p` | 0.93.0-jaz.1             | 0.89.1-jaz.2             |
| --------------------------------- | ------------------------- | ------------------------ | ------------------------ |
| Claude Code                       | 2.1.300                   | 2.1.300                  | 2.1.296                  |
| Model                             | `claude-opus-5-5[1m]`     | `claude-opus-5-5[1m]`    | `claude-opus-5-5[1m]`    |
| Context window                    | 1,000,000                 | unknown, then 1,000,000  | unknown, then 1,000,000  |
| Tools                             | 39                        | 28                       | the same 28              |
| First user prompt                 | one, the same text        | one, the same text       | one, the same text       |
| First turn input, including cache | 54,132 tokens             | 55,835 tokens            | 55,607 tokens            |
| File read                         | fixture token             | fixture token            | fixture token            |
| Resume in a fresh process, recall | fixture token             | fixture token            | not rerun                |
| `/compact`, then recall           | fixture token             | fixture token            | not rerun                |
| Authentication                    | subscription, no API key  | subscription, no API key | subscription, no API key |

The adapters pass Claude Code identical arguments and environment variable names. The tool sets
differ by mode: headless `-p` drops AskUserQuestion, EnterPlanMode and ExitPlanMode, which an ACP
host keeps, and lists the claude.ai MCP tools that had connected before its first turn. The
228-token difference between the adapters is Claude Code's: in a paired run, 0.89.1-jaz.2 driving
Claude Code 2.1.300 sent the same 55,793 tokens as 0.93.0-jaz.1.

The only other difference in what the adapter sends Claude Code is `promptSuggestions: true` in its
`initialize` request, upstream's default since 0.92.0. Claude Code 2.1.300 skips a suggestion while
the conversation has fewer than two assistant messages, after an API error, in plan mode or with a
permission pending, when its rate limit is not "allowed", and after a turn of more than 10k tokens.
Otherwise it makes one extra request (`source=prompt_suggestion`) over the cached prefix, about
$0.01 per turn at 33k context, and the adapter forwards the result to AIR clients as
`session_info_update._meta.promptSuggestions`. In nine live turns four suggestions survived its
filters. An earlier three-turn probe saw none because every turn hit a gate, and it compared totals
that leave out the request after the last turn. Jaz shows the suggestion as composer ghost text.
