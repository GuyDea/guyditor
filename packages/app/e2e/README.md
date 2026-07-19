# Electron e2e harness

The root `pnpm test:e2e` script builds the unpackaged Electron app and launches the Playwright
smoke with an isolated `--user-data-dir`. On Linux without `DISPLAY`, it automatically uses
`xvfb-run -a`; CI images must install Xvfb. Tests use `data-testid` selectors and Playwright
conditions only—fixed sleeps are not allowed.
