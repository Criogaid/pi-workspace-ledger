import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FRESHNESS_DETAILS_KEY } from "../src/envelope.js";
import workspaceLedgerExtension from "../src/extension.js";

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

const NOTICE_DETAILS_KEY = "pi-workspace-ledger/notice";

function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: Handler }>();
	const customEntries: Array<{ customType: string; data: unknown }> = [];
	const api = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name: string, command: { handler: Handler }) {
			commands.set(name, command);
		},
		appendEntry(customType: string, data: unknown) {
			customEntries.push({ customType, data });
		},
	} as unknown as ExtensionAPI;

	return { api, handlers, commands, customEntries };
}

async function call(
	handlers: Map<string, Handler[]>,
	name: string,
	event: unknown,
	ctx: unknown,
): Promise<unknown> {
	let result: unknown;
	for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
	return result;
}

async function recordReadEvidence(
	handlers: Map<string, Handler[]>,
	ctx: unknown,
	path: string,
	toolCallId = "read-1",
	options: { offset?: number; limit?: number } = {},
	details: unknown = {},
): Promise<void> {
	const input = { path, ...options };
	await call(handlers, "tool_call", { toolName: "read", toolCallId, input }, ctx);
	assert.equal(
		await call(
			handlers,
			"tool_result",
			{ toolName: "read", toolCallId, input, details, isError: false },
			ctx,
		),
		undefined,
	);
}

async function recordUserMessage(handlers: Map<string, Handler[]>, ctx: unknown, id: string): Promise<void> {
	await call(handlers, "message_end", { message: { role: "user", content: id } }, ctx);
}

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "pi-workspace-ledger-"));
	temporaryDirectories.push(path);
	return path;
}

function headlessContext(cwd: string) {
	return { cwd, hasUI: false, sessionManager: { getBranch: () => [] }, ui: { notify() {} } };
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Pi extension runtime freshness", () => {
	it("tracks reads and edits without persisting tool metadata", async () => {
		const cwd = await temporaryDirectory();
		const source = join(cwd, "source.ts");
		await writeFile(source, "export const value = 1;\n");
		let report = "";
		const { api, handlers, commands, customEntries } = fakePi();
		workspaceLedgerExtension(api);
		const ctx = {
			cwd,
			hasUI: true,
			sessionManager: { getBranch: () => [] },
			ui: { notify(value: string) { report = value; } },
		};
		await recordReadEvidence(handlers, ctx, source, "read-range", { offset: 2, limit: 3 }, 7);

		await writeFile(source, "export const value = 2;\n");
		assert.equal(
			await call(
				handlers,
				"tool_result",
				{ toolName: "edit", toolCallId: "edit-1", input: { path: source }, details: 7, isError: false },
				ctx,
			),
			undefined,
		);
		const contextPatch = (await call(handlers, "context", { messages: [] }, ctx)) as {
			messages: Array<{ content: unknown }>;
		};
		assert.match(String(contextPatch.messages.at(-1)?.content), /read source\.ts lines 2-4/);
		assert.match(String(contextPatch.messages.at(-1)?.content), /STALE/);
		assert.deepEqual(customEntries, []);
		await commands.get("freshness")?.handler("", ctx);
		assert.match(report, /stale=1/);
	});

	it("detects an out-of-band file change at the context boundary", async () => {
		const cwd = await temporaryDirectory();
		const source = join(cwd, "source.ts");
		await writeFile(source, "before\n");
		const { api, handlers } = fakePi();
		workspaceLedgerExtension(api);
		const ctx = headlessContext(cwd);
		await recordReadEvidence(handlers, ctx, source);
		await writeFile(source, "after\n");

		const projection = (await call(handlers, "context", { messages: [] }, ctx)) as {
			messages: Array<{ content: unknown }>;
		};
		assert.match(String(projection.messages.at(-1)?.content), /STALE/);
	});

	it("keeps third-party selector evidence unverified in the current runtime", async () => {
		const cwd = await temporaryDirectory();
		const source = join(cwd, "source.ts");
		await writeFile(source, "value\n");
		const { api, handlers } = fakePi();
		workspaceLedgerExtension(api);
		const ctx = headlessContext(cwd);
		await call(handlers, "tool_result", {
			toolName: "query",
			toolCallId: "selected-1",
			isError: false,
			details: {
				[FRESHNESS_DETAILS_KEY]: {
					version: 1,
					evidence: [
						{
							subject: "selected source range",
							dependencies: [
								{
									resource: pathToFileURL(source).href,
									facet: "content",
									selector: { start: 1, end: 1 },
									stamp: "range-sha",
								},
							],
							assurance: "exact",
						},
					],
				},
			},
		}, ctx);

		const projection = (await call(handlers, "context", { messages: [] }, ctx)) as {
			messages: Array<{ content: unknown }>;
		};
		assert.match(String(projection.messages.at(-1)?.content), /UNVERIFIED/);
	});

	it("never replays freshness from historical session entries", async () => {
		const oldToolResult = {
			role: "toolResult",
			toolCallId: "old-read",
			toolName: "read",
			content: [{ type: "text", text: "historical read output" }],
			details: {
				[FRESHNESS_DETAILS_KEY]: {
					version: 1,
					evidence: [
						{
							subject: "read historical.ts",
							dependencies: [{ resource: "file:///missing.ts", facet: "content", stamp: "old" }],
							assurance: "exact",
						},
					],
				},
			},
		};
		const historicalNotice = {
			role: "custom",
			customType: "pi-workspace-ledger-safety-fallback",
			content: "Workspace freshness (machine-generated status): historical",
			display: false,
		};
		const { api, handlers, customEntries } = fakePi();
		workspaceLedgerExtension(api);
		const ctx = {
			cwd: tmpdir(),
			hasUI: false,
			sessionManager: { getBranch() { throw new Error("session branch must not be read"); } },
			ui: { notify() {} },
		};

		const filtered = (await call(
			handlers,
			"context",
			{ messages: [oldToolResult, historicalNotice] },
			ctx,
		)) as { messages: unknown[] };
		assert.deepEqual(filtered.messages, [oldToolResult]);
		assert.deepEqual(customEntries, []);
	});

	it("expires each built-in read independently after three subsequent user messages", async () => {
		const cwd = await temporaryDirectory();
		const source = join(cwd, "source.ts");
		await writeFile(source, "first\nsecond\n");
		let report = "";
		const { api, handlers, commands } = fakePi();
		workspaceLedgerExtension(api);
		const ctx = {
			cwd,
			hasUI: true,
			sessionManager: { getBranch: () => [] },
			ui: { notify(value: string) { report = value; } },
		};
		await recordReadEvidence(handlers, ctx, source, "read-full");
		await recordUserMessage(handlers, ctx, "user-1");
		await recordUserMessage(handlers, ctx, "user-2");
		await recordReadEvidence(handlers, ctx, source, "read-range", { offset: 2, limit: 1 });
		await writeFile(source, "first\nchanged\n");
		await recordUserMessage(handlers, ctx, "user-3");
		await recordUserMessage(handlers, ctx, "user-4");

		const active = (await call(handlers, "context", { messages: [] }, ctx)) as {
			messages: Array<{ content: unknown }>;
		};
		const notice = String(active.messages.at(-1)?.content);
		assert.match(notice, /read source\.ts lines 2-2/);
		assert.doesNotMatch(notice, /^- STALE: "read source\.ts"$/m);

		await recordUserMessage(handlers, ctx, "user-5");
		const third = (await call(handlers, "context", { messages: [] }, ctx)) as {
			messages: Array<{ content: unknown }>;
		};
		assert.match(String(third.messages.at(-1)?.content), /STALE/);

		await recordUserMessage(handlers, ctx, "user-6");
		const expired = (await call(
			handlers,
			"context",
			{ messages: [third.messages.at(-1)] },
			ctx,
		)) as { messages: unknown[] };
		assert.deepEqual(expired.messages, []);
		await commands.get("freshness")?.handler("", ctx);
		assert.equal(report, "Workspace freshness: no evidence recorded.");
	});

	it("clears runtime freshness when context changes within one runtime", async () => {
		const cwd = await temporaryDirectory();
		const source = join(cwd, "source.ts");
		const resetEvents: Array<[string, string, Record<string, unknown>]> = [
			["tree", "session_tree", { newLeafId: "new", oldLeafId: "old" }],
			["compact", "session_compact", { compactionEntry: {} }],
		];

		for (const [label, eventName, event] of resetEvents) {
			await writeFile(source, "before\n");
			const { api, handlers } = fakePi();
			workspaceLedgerExtension(api);
			const ctx = headlessContext(cwd);
			await recordReadEvidence(handlers, ctx, source);
			await writeFile(source, "after\n");
			await call(handlers, eventName, event, ctx);
			assert.equal(await call(handlers, "context", { messages: [] }, ctx), undefined, label);
		}
	});

	it("does not expire third-party evidence with built-in read retention", async () => {
		const cwd = await temporaryDirectory();
		const source = join(cwd, "source.ts");
		await writeFile(source, "current\n");
		const { api, handlers } = fakePi();
		workspaceLedgerExtension(api);
		const ctx = headlessContext(cwd);
		await call(handlers, "tool_result", {
			toolName: "read",
			toolCallId: "third-party-read",
			isError: false,
			details: {
				[FRESHNESS_DETAILS_KEY]: {
					version: 1,
					evidence: [
						{
							subject: "read source.ts",
							dependencies: [
								{ resource: pathToFileURL(source).href, facet: "content", stamp: "external" },
							],
							assurance: "exact",
						},
					],
				},
			},
		}, ctx);
		for (let index = 1; index <= 4; index++) await recordUserMessage(handlers, ctx, `user-${index}`);

		const active = (await call(handlers, "context", { messages: [] }, ctx)) as {
			messages: Array<{ content: unknown }>;
		};
		assert.match(String(active.messages.at(-1)?.content), /read source\.ts/);
	});

	it("tracks logical workspace symlinks but ignores direct outside reads", async () => {
		const root = await temporaryDirectory();
		const cwd = join(root, "workspace");
		const firstTarget = join(root, "target-a");
		const secondTarget = join(root, "target-b");
		await Promise.all([mkdir(cwd), mkdir(firstTarget), mkdir(secondTarget)]);
		await Promise.all([
			writeFile(join(firstTarget, "source.ts"), "first\n"),
			writeFile(join(secondTarget, "source.ts"), "second\n"),
		]);
		const link = join(cwd, "linked");
		const linkType = process.platform === "win32" ? "junction" : "dir";
		await symlink(firstTarget, link, linkType);
		const source = join(link, "source.ts");
		const { api, handlers } = fakePi();
		workspaceLedgerExtension(api);
		const ctx = headlessContext(cwd);

		await recordReadEvidence(handlers, ctx, join(firstTarget, "source.ts"), "outside");
		assert.equal(await call(handlers, "context", { messages: [] }, ctx), undefined);
		await recordReadEvidence(handlers, ctx, source, "linked-read");
		await unlink(link);
		await symlink(secondTarget, link, linkType);
		const projection = (await call(handlers, "context", { messages: [] }, ctx)) as {
			messages: Array<{ content: unknown }>;
		};
		assert.match(String(projection.messages.at(-1)?.content), /STALE/);
	});

	it("preserves similar tool output while removing marked legacy notices", async () => {
		const { api, handlers } = fakePi();
		workspaceLedgerExtension(api);
		const ctx = headlessContext(tmpdir());
		const message = {
			role: "toolResult",
			toolCallId: "other-tool",
			toolName: "other",
			content: [{ type: "text", text: "Workspace freshness (machine-generated status): legitimate output" }],
			details: {},
		};
		assert.equal(await call(handlers, "context", { messages: [message] }, ctx), undefined);

		const original = { type: "text", text: "original output" };
		const legacyNotice = {
			...message,
			toolCallId: "legacy-tool",
			content: [original, { type: "text", text: "Workspace freshness (machine-generated status):\n- STALE" }],
			details: { [NOTICE_DETAILS_KEY]: { version: 1, abnormalKey: "a".repeat(64) } },
		};
		const filtered = (await call(handlers, "context", { messages: [legacyNotice] }, ctx)) as {
			messages: Array<{ content: unknown }>;
		};
		assert.deepEqual(filtered.messages[0]?.content, [original]);
	});
});
