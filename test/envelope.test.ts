import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	FRESHNESS_DETAILS_KEY,
	envelopeFromDetails,
	mergeEnvelopes,
	parseFreshnessEnvelope,
} from "../src/envelope.js";

describe("Freshness Envelope v1", () => {
	it("accepts a valid envelope in namespaced details", () => {
		const envelope = envelopeFromDetails({
			[FRESHNESS_DETAILS_KEY]: {
				version: 1,
				changes: [{ resource: "file:///repo/a.ts", facet: "content" }],
			},
		});
		assert.equal(envelope?.version, 1);
	});

	it("rejects malformed and future-version envelopes", () => {
		assert.equal(parseFreshnessEnvelope({ version: 2 }), undefined);
		assert.equal(
			parseFreshnessEnvelope({ version: 1, evidence: [{ subject: "read a", dependencies: [], assurance: "maybe" }] }),
			undefined,
		);
	});

	it("rejects circular selectors without throwing", () => {
		const selector: Record<string, unknown> = {};
		selector.self = selector;
		assert.equal(
			parseFreshnessEnvelope({
				version: 1,
				changes: [{ resource: "file:///repo/a.ts", facet: "content", selector }],
			}),
			undefined,
		);
	});

	it("merges producer and built-in adapter records", () => {
		const merged = mergeEnvelopes(
			{ version: 1, changes: [{ resource: "file:///repo/a.ts", facet: "content" }] },
			{
				version: 1,
				evidence: [
					{
						subject: "read a.ts",
						dependencies: [{ resource: "file:///repo/a.ts", facet: "content", stamp: "sha-a" }],
						assurance: "exact",
					},
				],
			},
		);

		assert.equal(merged?.changes?.length, 1);
		assert.equal(merged?.evidence?.length, 1);
	});
});
