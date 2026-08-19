import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FreshnessEnvelopeV1 } from "../src/envelope.js";
import { LedgerState } from "../src/ledger.js";

const FILE = "file:///repo/src/parser.ts";

function readEnvelope(subject = "read src/parser.ts", stamp = "sha-a"): FreshnessEnvelopeV1 {
	return {
		version: 1,
		evidence: [
			{
				subject,
				dependencies: [{ resource: FILE, facet: "content", stamp }],
				assurance: "exact",
			},
		],
	};
}

describe("LedgerState", () => {
	it("marks matching evidence stale after a change", () => {
		const ledger = new LedgerState();
		ledger.apply({ kind: "envelope", entryId: "read-1", envelope: readEnvelope() });
		ledger.apply({
			kind: "envelope",
			entryId: "edit-1",
			envelope: { version: 1, changes: [{ resource: FILE, facet: "content" }] },
		});

		assert.equal(ledger.project()[0]?.status, "stale");
	});

	it("keeps unrelated evidence current", () => {
		const ledger = new LedgerState();
		ledger.apply({ kind: "envelope", entryId: "read-1", envelope: readEnvelope() });
		ledger.apply({
			kind: "envelope",
			entryId: "edit-1",
			envelope: { version: 1, changes: [{ resource: "file:///repo/src/other.ts", facet: "content" }] },
		});

		assert.equal(ledger.project()[0]?.status, "current");
	});

	it("supersedes earlier evidence with the same subject", () => {
		const ledger = new LedgerState();
		ledger.apply({ kind: "envelope", entryId: "read-1", envelope: readEnvelope() });
		ledger.apply({ kind: "envelope", entryId: "read-2", envelope: readEnvelope("read src/parser.ts", "sha-b") });

		assert.deepEqual(
			ledger.project({ includeSuperseded: true }).map((record) => record.status),
			["superseded", "current"],
		);
	});

	it("retires evidence without reviving the superseded subject", () => {
		const ledger = new LedgerState();
		ledger.apply({ kind: "envelope", entryId: "legacy-read", envelope: readEnvelope() });
		ledger.apply({
			kind: "envelope",
			entryId: "expired-read",
			envelope: readEnvelope("read src/parser.ts", "sha-b"),
			retiredEvidenceIndexes: [0],
		});

		assert.deepEqual(ledger.project(), []);
		assert.equal(ledger.project({ includeSuperseded: true })[0]?.status, "superseded");
	});

	it("never treats dependencyless evidence as current", () => {
		const ledger = new LedgerState();
		ledger.apply({
			kind: "envelope",
			entryId: "debug-1",
			envelope: {
				version: 1,
				evidence: [{ subject: "debugger locals", dependencies: [], assurance: "exact" }],
			},
		});

		assert.equal(ledger.project()[0]?.status, "unverified");
		assert.deepEqual(ledger.project()[0]?.reasons, ["producer declared no dependencies"]);
	});

	it("distinguishes producer-declared unverified evidence", () => {
		const ledger = new LedgerState();
		ledger.apply({
			kind: "envelope",
			entryId: "partial",
			envelope: {
				version: 1,
				evidence: [
					{
						subject: "partial read",
						dependencies: [{ resource: FILE, facet: "content", stamp: "sha-a" }],
						assurance: "unverified",
					},
				],
			},
		});

		assert.deepEqual(ledger.project()[0]?.reasons, ["producer marked evidence unverified"]);
	});

	it("applies a persisted entry only once", () => {
		const ledger = new LedgerState();
		const event = { kind: "envelope" as const, entryId: "read-1", envelope: readEnvelope() };
		ledger.apply(event);
		ledger.apply(event);

		assert.equal(ledger.project({ includeSuperseded: true }).length, 1);
	});

	it("can restore content evidence after resolving the original stamp", () => {
		const ledger = new LedgerState();
		ledger.apply({ kind: "envelope", entryId: "read-1", envelope: readEnvelope() });
		ledger.apply({
			kind: "envelope",
			entryId: "edit-1",
			envelope: { version: 1, changes: [{ resource: FILE, facet: "content" }] },
		});
		ledger.apply({ kind: "resolved", resource: FILE, facet: "content", stamp: "sha-a" });

		assert.equal(ledger.project()[0]?.status, "current");
	});

	it("invalidates selector evidence conservatively on the same resource facet", () => {
		const ledger = new LedgerState();
		ledger.apply({
			kind: "envelope",
			entryId: "read-range",
			envelope: {
				version: 1,
				evidence: [
					{
						subject: "read parser range",
						dependencies: [
							{ resource: FILE, facet: "content", selector: { start: 1, end: 10 }, stamp: "sha-a" },
						],
						assurance: "exact",
					},
				],
			},
		});
		ledger.apply({
			kind: "envelope",
			entryId: "edit-range",
			envelope: {
				version: 1,
				changes: [{ resource: FILE, facet: "content", selector: { start: 5, end: 6 } }],
			},
		});

		assert.equal(ledger.project()[0]?.status, "stale");
	});

	it("uses partial dependencies to prove staleness", () => {
		const ledger = new LedgerState();
		ledger.apply({
			kind: "envelope",
			entryId: "partial",
			envelope: {
				version: 1,
				evidence: [
					{
						subject: "partial search",
						dependencies: [{ resource: FILE, facet: "content", stamp: "sha-a" }],
						assurance: "unverified",
					},
				],
			},
		});
		ledger.apply({
			kind: "envelope",
			entryId: "edit-1",
			envelope: { version: 1, changes: [{ resource: FILE, facet: "content" }] },
		});

		assert.equal(ledger.project()[0]?.status, "stale");
	});

	it("treats a disappeared dependency as stale", () => {
		const ledger = new LedgerState();
		ledger.apply({ kind: "envelope", entryId: "read-1", envelope: readEnvelope() });
		ledger.apply({ kind: "resolved", resource: FILE, facet: "content", stamp: null, missing: true });

		assert.equal(ledger.project()[0]?.status, "stale");
	});

	it("marks an unsupported resolution unverified", () => {
		const ledger = new LedgerState();
		ledger.apply({ kind: "envelope", entryId: "read-1", envelope: readEnvelope() });
		ledger.apply({ kind: "resolved", resource: FILE, facet: "content", stamp: null });

		assert.equal(ledger.project()[0]?.status, "unverified");
	});
});
