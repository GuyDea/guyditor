# Dogfood — assembly via local CLI (Amendment 009)

Status: **not run.** These checks need the creator's logged-in `claude` and `codex` and send
data to a provider, so they are run only with the creator's go-ahead, after branch review.
Traceability `ASM-007` stays `partial` until this note is filled in.

Date run: _
Run by: _
Versions: claude _ / codex _

## 1. Check button output

- Provider Anthropic, Connect via local CLI, **Check**: expected `claude <version> ✓`.
  Result: not run
  Output:

- Provider OpenAI, Connect via local CLI, **Check**: expected `codex <version> ✓`.
  Result: not run
  Output:

## 2. One session on ep001 per CLI

Script attached, one PNG and one PDF attached, transport `cli`; Analyze, then one turn.

- claude — the turn's usage line (reported cost, or "via claude (no cost reported)"); whether
  `claude` read the PDF natively or needed the Read instruction (design §6):
  Result: not run
  Output:

- codex — the turn's usage line; how the PDF (given by path) was handled:
  Result: not run
  Output:

## 3. Confinement check

From a session context directory (`sidecars/context/<asb_id>/`), run once:

```
claude -p --safe-mode --restricted --no-session-persistence --tools Read
```

asked to print `../../episode.guyditor.yaml`. Expected: it cannot.

claude — Result: not run
Output:

From the same context directory, run once:

```
codex exec --ephemeral --skip-git-repo-check --sandbox read-only -C <contextDir>
```

asked to print `../../episode.guyditor.yaml`. Expected: it cannot. `--sandbox read-only`
blocks writes and network for shell commands but is not known to confine reads to `-C`.

codex — Result: not run
Output:

Also check whether that run loads any MCP server configured in `~/.codex/config.toml`
(codex lists the servers it starts). If it does, the candidate mitigation is adding
`-c 'mcp_servers={}'` to the codex invocation; record the finding here first.

codex MCP servers — Result: not run
Output:

Rule (design §4.2): if it can read outside the context directory, record it here and under
the limitations of `docs/amendments/009-assembly-inputs.md`. Report, do not widen or work
around it.
