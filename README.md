# pi-workspace-ledger

A passive Pi extension that tracks whether recent supported tool evidence is still valid for the current workspace.

The project generalizes the freshness principle behind hashline edits: a write should not rely on a stale location, and an Agent decision should not silently rely on stale observations.

## Current Scope

The initial vertical slice:

- records exact whole-file content evidence for successful `read` calls on logical paths inside the current workspace when pre/post hashes match;
- keeps each plugin-produced read active for the next three `role: user` session entries, independently of other reads;
- starts a new read epoch after session restore, `/resume`, `/tree`, `/fork`, `/clone`, and every compaction;
- preserves the current read epoch across `/reload`;
- records file-content changes from successful `edit` and `write` calls;
- reconstructs state from the current Pi session branch before projection;
- streams SHA-256 over active dependencies and hashes a shared physical target once per projection;
- detects out-of-band changes, including a workspace symlink being retargeted;
- retains notice markers for session audit while filtering obsolete notices from model context;
- exposes `/freshness` for human inspection.

The extension is passive. It does not block tools, skip tests, cache commands, add configuration modes, start file watchers, or add LLM calls. When no active evidence is stale or unverified, it adds no model-visible tokens.

## Read Lifetime

The three-entry window applies only to reads produced by this extension after the bounded policy was introduced. Existing unmarked session evidence and third-party Envelope v1 producers retain their original lifecycle. Partial reads still depend on the whole file, and every persisted `role: user` entry counts toward the window. A read made while handling the current user entry does not consume that entry; it expires before the fourth subsequent user entry is projected.

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

Only currently active stale and unverified evidence is projected into model context. Opaque stamps, retention markers, and session entry/evidence IDs remain host-only.


## Project Policy

The repository is private-package marked while the wire contract is experimental. A public license and compatibility policy will be chosen after the first conformance and Pi smoke tests.
