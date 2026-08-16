# pi-workspace-ledger

A passive Pi extension that tracks whether supported tool evidence is still valid for the current workspace.

The project generalizes the freshness principle behind hashline edits: a write should not rely on a stale location, and an Agent decision should not silently rely on stale observations.

## Current Scope

The initial vertical slice:

- records exact file-content evidence for successful `read` calls when pre/post hashes match;
- records file-content changes from successful `edit` and `write` calls;
- marks affected reads stale;
- reconstructs state from the current Pi session branch before projection;
- re-hashes active file dependencies to detect out-of-band changes;
- persists one bounded notice when the abnormal projection changes;
- appends in-band notices after the final tool result while preserving its original content;
- uses per-call context injection only as a race-window safety fallback;
- exposes `/freshness` for human inspection.

The extension is passive. It does not block tools, skip tests, cache commands, add configuration modes, or add LLM calls. When all evidence is current, it adds no model-visible tokens.

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

Only stale and unverified evidence is added to model context. Opaque stamps and session entry IDs remain host-only.

## Documents

- [Development plan](./PLAN.md)
- [Research record](./docs/research.md)
- [Concept and protocol notes](./docs/concept.md)
- [Implementation progress](./PROGRESS.md)

## Project Policy

The repository is private-package marked while the wire contract is experimental. A public license and compatibility policy will be chosen after the first conformance and Pi smoke tests.
