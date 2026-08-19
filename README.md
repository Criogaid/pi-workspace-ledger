# pi-workspace-ledger

A runtime-only freshness advisor for Pi coding agents. It tracks recent evidence from supported tools and reports when the workspace no longer matches what the agent observed.

The extension is deliberately narrow: it tracks active evidence and independently revalidates the file dependencies it supports. It is not a persistent ledger for the entire conversation.

> `Workspace freshness: no evidence recorded.` means there is no active tracked evidence. It does not mean every historical statement in the model context is current.

## How It Works

```text
local built-in read -> captured file snapshot -> runtime evidence
edit / write        -> content change        -> runtime evidence
live Envelope v1    -> producer evidence      -> runtime evidence
                                               |
before model context or /freshness <----------+
                 |
                 +-> re-hash active file dependencies
                 +-> inject a notice only for stale or unverified evidence
```

For an eligible built-in `read`, the extension uses Pi's read implementation to capture the resolved path, tool-result content, and SHA-256 stamp from the same file buffer. The result is `exact` only when the executed tool input and output match that capture and the file still has the captured stamp.

Before each model request, supported active file dependencies are resolved again and all active evidence is reprojected. When no evidence is stale or unverified, the extension adds no model-visible tokens. Otherwise it renders one ephemeral `role: custom` status message.

## Supported Tool Behavior

| Source | Behavior |
| --- | --- |
| Local built-in `read` on a logical path inside the workspace | Captures exact content evidence when input, output, and source stamp all match. |
| Partial built-in `read` | Tracks the selected observation, but depends on the whole file. |
| Supported image `read` | Uses the same captured-buffer and output comparison as text reads. |
| Overridden, SDK, or remote `read` | Does not receive built-in read evidence automatically. It may provide an Envelope v1 result. |
| Successful result from a tool named `edit` or `write` with a string `input.path` | Treats the supplied path as a local content change, resolving relative paths against the current working directory. |
| Other live tool results | Consumes a valid Envelope v1 from tool-result `details`. |

Direct built-in reads outside the workspace are ignored. A logical path inside the workspace remains tracked when it is a symlink to an outside target; retargeting that symlink is detected when the resulting content stamp changes.

## Install and Use

Declared runtime floor: Node.js 22.19 or newer and Pi 0.84 or newer.

Install this checkout as a local Pi package:

```bash
pi install /absolute/path/to/pi-workspace-ledger
```

Local package paths are referenced in place. Restart Pi or run `/reload` after changing the extension.

Use the extension normally; freshness checks happen automatically before model requests. For human inspection, run:

```text
/freshness
```

## Evidence Lifetime

- Each adapted built-in read stays active through the next three live `role: user` messages and expires before the fourth subsequent message is projected.
- A read made while handling the current user message does not consume that message's lifetime.
- Each adapted built-in read expires independently.
- Envelope-provided evidence has no message-count expiry; it remains until superseded or the runtime is reset.
- State lives only in the current extension instance and is never restored from session JSONL.
- Restarting, resuming, reloading, forking, or cloning starts with empty freshness state. Tree changes and compaction also clear current runtime state.
- Historical tool output may remain in Pi's conversation context after freshness state has been cleared; this extension does not reconstruct or validate evidence from that history.
- Active file dependencies are checked at context and command boundaries. There is no watcher, daemon, or continuous filesystem lock.

## Status Semantics

| Status | Meaning |
| --- | --- |
| `current` | No tracked contradiction exists, and every dependency covered by a built-in resolver currently matches. |
| `current-conservative` | The same condition as `current`, but the producer classified coverage as conservative. |
| `stale` | At least one dependency changed, disappeared, or has a different stamp. |
| `unverified` | The producer declared incomplete coverage, supplied no dependencies, or a supported resolver could not resolve a dependency. |
| `superseded` | Newer evidence replaced the same subject. Normal projection hides this status. |

Only active `stale` and `unverified` evidence is injected into model context. `/freshness` reports all normally projected active evidence, including current records. Opaque stamps and runtime IDs remain in memory.

For a resource or facet without an independent resolver, `current` means its producer-supplied stamp has not been contradicted by a later tracked change. It does not mean the extension re-read that resource.

## Experimental Envelope API

The package root exports the default extension, `LedgerState`, and the `FreshnessEnvelopeV1` type. Live tool producers attach an Envelope v1 value to tool-result `details`:

```json
{
  "pi-workspace-ledger/freshness": {
    "version": 1,
    "changes": [
      { "resource": "file:///workspace/source.ts", "facet": "content" }
    ],
    "evidence": [
      {
        "subject": "observed source.ts",
        "dependencies": [
          {
            "resource": "file:///workspace/source.ts",
            "facet": "content",
            "stamp": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
          }
        ],
        "assurance": "exact"
      }
    ]
  }
}
```

`changes` and `evidence` are optional arrays. A dependency may include a JSON `selector`; `assurance` is `exact`, `conservative`, or `unverified`. Malformed and future-version envelopes are ignored. New evidence supersedes older active evidence with the same `subject`.

Envelope evidence is consumed from live tool results, including error results, so producers should attach it only when the result semantics warrant it. It has no message-count expiry and remains active until superseded or the runtime is reset.

The current extension independently re-resolves selector-free `file:` dependencies with the `content` facet. Selector-bearing file dependencies cannot be independently revalidated: they are unverified unless a tracked change makes them stale. Other resource schemes and facets are not independently re-resolved. The wire contract is experimental.

## Non-Goals

The extension does not block tools, skip tests, cache commands, add configuration modes, start watchers, reconstruct historical state, or make LLM calls. It is a short-lived advisor for supported evidence, not a security boundary or a guarantee that the complete model context is fresh.

## Development

```bash
npm install
npm run check
npm run pack:check
```

`npm run check` runs strict TypeScript checking and the full test suite. `npm run pack:check` verifies the package contents without publishing.

## Project Status

The package is currently private. It declares Pi `>=0.84.0`; automated tests currently use Pi 0.84.1, and the APIs documented here were checked against Pi 0.84.2 documentation and package source. A public license and compatibility policy have not been selected.
