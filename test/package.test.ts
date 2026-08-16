import assert from "node:assert/strict";
import { describe, it } from "node:test";
import workspaceLedgerExtension, { LedgerState } from "pi-workspace-ledger";

describe("package exports", () => {
	it("exposes the documented package-root surface", () => {
		assert.equal(typeof workspaceLedgerExtension, "function");
		assert.equal(typeof LedgerState, "function");
	});
});
