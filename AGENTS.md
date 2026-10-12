# Agent guide

An ACP-compatible coding agent powered by the Claude Agent SDK. Source in `src/`,
TypeScript, ESM, Node >= 22.

## Commands

```sh
npm run build         # tsc
npm run test:run      # vitest, single pass
npm run check         # eslint + prettier --check
npm run lint:fix      # eslint --fix
npm run format        # prettier --write
```

CI runs `format:check`, `lint`, `build` and `test:run`. Run `npm run check` before
opening a PR.

## Code comments

Keep comments straightforward, concise, and concrete. Say what the code does and
why, in plain terms: name the actual state, call, or failure involved instead of
alluding to it. Prefer a short concrete example over an abstract description.
Don't use vague phrases like "keeps it honest" or "the residual case" that make
the reader reconstruct the meaning.

## Pull requests

Use conventional commit titles: `feat`, `fix`, `perf`, `revert`, `docs`, `style`,
`chore`, `refactor`, `test`, `build`, or `ci`.

## Releasing

This Jaz fork uses the manual [Release Standalone](.github/workflows/release-standalone.yml)
workflow. Keep the fork version and pinned native SDK explicit, and complete
native-parity validation before publishing. See [docs/RELEASES.md](docs/RELEASES.md).
