# Jaz standalone releases

Jaz publishes standalone adapter archives through
[Release Standalone](../.github/workflows/release-standalone.yml).
The workflow is dispatched manually with the fork version from `package.json`.
It runs the adapter tests, bundles the pinned Claude runtime, and publishes
platform archives and SHA256SUMS under `v<version>`.

Before dispatch, run `npm run check`, `npm run build`, and `npm run test:run`,
and complete native-parity validation for the pinned Claude runtime.
Update Jaz's adapter manifest only after the release assets are available and verified.
