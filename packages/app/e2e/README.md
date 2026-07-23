# Electron e2e harness

The root `pnpm test:e2e` script builds the unpackaged Electron app and launches the Playwright
smoke with an isolated `--user-data-dir`. On Linux without `DISPLAY`, it automatically uses
`xvfb-run -a`; CI images must install Xvfb. Tests use `data-testid` selectors and Playwright
conditions only—fixed sleeps are not allowed.

## Workflow phase traceability

- **FR-900 / Amendment 005:** `phase-tabs.spec.ts` covers the five phase presets,
  per-tab persisted customization, and the §10.9-consistent `Ctrl+Alt+1` through
  `Ctrl+Alt+5` bindings (`Cmd` replaces `Ctrl` on macOS).
- **FR-907:** the same suite covers Review badge surfacing from the shared
  `JobQueue.overview()` waiting-on data and its jump to the pending proposal.
