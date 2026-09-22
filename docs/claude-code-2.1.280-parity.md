# Claude Code 2.1.280 compatibility

Validated on macOS arm64 on 2026-09-22 with Claude Agent SDK 0.3.280 and
Claude ACP 0.81.0-jaz.2, using the same subscription OAuth profile as the native CLI.

| Check                                | Native CLI            | ACP                   |
| ------------------------------------ | --------------------- | --------------------- |
| `opus[1m]` resolution                | `claude-opus-5-5[1m]` | `claude-opus-5-5[1m]` |
| Provider context window              | 1,000,000             | 1,000,000             |
| First user prompt                    | One, 79 bytes         | One, 79 bytes         |
| First request input, including cache | 22,213 tokens         | 20,367 tokens         |
| Read a fixture with a file tool      | Correct token         | Correct token         |
| Resume in a fresh process and recall | Correct token         | Correct token         |
| `/compact` and subsequent recall     | Correct token         | Correct token         |
| Subscription authentication          | Successful            | Successful            |

The first-request totals are measured CLI and SDK totals, not an assertion of
byte-identical provider requests. The adapter uses the native Claude Code system
prompt preset, retains Default effort, and leaves context size unknown until
reported by the provider. The provider model catalog supplies the Opus 5.5 name
and all five effort levels. No API key was used.

The macOS standalone archive also completed a real Opus 5.5 prompt through Jaz's
Go ACP client. All five platform archives contain the adapter and pinned native
runtime; only macOS arm64 binaries were executed in this validation.

An initial login diagnostic inherited a missing `USER` and incorrect `LOGNAME`.
It could not read the logged-in user's Keychain and fell back to an expired
Anthropic profile. Live validation uses the same user identity as the host app.

The unit suite passes 1,386 tests. TypeScript compilation, lint, formatting,
and the live SDK model-catalog test pass.
