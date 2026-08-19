# pi-workspace-ledger

A passive Pi extension that tracks whether recent supported tool evidence is still valid for the current workspace.

The project generalizes the freshness principle behind hashline edits: a write should not rely on a stale location, and an Agent decision should not silently rely on stale observations.

## Current Scope

The initial vertical slice:

- records exact whole-file content evidence in the current extension runtime only when a local built-in `read` result matches the captured input and output and the observed source hash still matches;
- keeps each recognized built-in read active for the next three live `role: user` messages, independently of other reads;
- clears all freshness state on `/reload`, session start/resume, `/tree`, `/fork`, `/clone`, compaction, and shutdown;
- records file-content changes from successful `edit` and `write` calls in memory;
- never replays the Pi session branch or writes Envelope/notice metadata back to tool results or session entries;
- streams SHA-256 over active dependencies and hashes a shared physical target once per projection;
- detects out-of-band changes, including a workspace symlink being retargeted;
- injects only an ephemeral current notice at the model context boundary;
- exposes `/freshness` for human inspection.

The extension is passive. It does not block tools, skip tests, cache commands, add configuration modes, start file watchers, or add LLM calls. When no active evidence is stale or unverified, it adds no model-visible tokens.

## Read Lifetime

Freshness state exists only in the current extension instance. It is not restored from session JSONL, so restarting, resuming, forking, switching branches, compacting, or reloading always requires a new read. Historical tool outputs can remain in Pi's conversation log, but this extension neither validates nor projects them. Partial reads still depend on the whole file, and every live `role: user` message counts toward the window. A read made while handling the current user message does not consume that message; it expires before the fourth subsequent user message is projected.

## Development

Requirements: Node.js 22.19 or newer and Pi 0.84 or newer.

```bash
npm install
npm run check
npm run pack:check
```

Load the local package:

```bash
pi install E:/Github/pi-workspace-ledger
```

Then restart or reload Pi and run:

```text
/freshness
```

## Status Semantics

- `current`: all exact dependencies still match.
- `current-conservative`: all declared dependencies and conservative fallback scopes match.
- `stale`: at least one dependency changed.
- `unverified`: dependency coverage is incomplete or cannot be resolved.
- `superseded`: newer evidence replaced the same subject.

Only currently active stale and unverified evidence is projected into model context. Opaque stamps and runtime IDs remain in memory only.


## Project Policy

The repository is private-package marked while the wire contract is experimental. A public license and compatibility policy will be chosen after the first conformance and Pi smoke tests.
