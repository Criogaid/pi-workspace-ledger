import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";
import { createReadToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FRESHNESS_DETAILS_KEY } from "../src/envelope.js";
import workspaceLedgerExtension from "../src/extension.js";

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

const PIXEL_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);

function fakePi(readSource = "builtin") {
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
		getAllTools() {
			return [{ name: "read", sourceInfo: { source: readSource } }];
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
	ctx: any,
	path: string,
	toolCallId = "read-1",
	options: { offset?: number; limit?: number } = {},
	details: unknown = {},
): Promise<void> {
	const input = { path, ...options };
	await call(handlers, "tool_call", { toolName: "read", toolCallId, input }, ctx);
	const result = await createReadToolDefinition(ctx.cwd).execute(toolCallId, input, undefined, undefined, ctx);
	assert.equal(
		await call(
			handlers,
			"tool_result",
			{ toolName: "read", toolCallId, input, content: result.content, details, isError: false },
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

async function hashlineSnapshotId(path: string): Promise<string> {
	const canonicalPath = await realpath(path);
	const stats = await stat(canonicalPath);
	return `v1|${canonicalPath}|${stats.mtimeMs}|${stats.size}`;
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
		const messages = [{ role: "user", content: "current prompt" }];
		const contextPatch = (await call(handlers, "context", { messages }, ctx)) as {
			messages: Array<{ content: unknown }>;
		};
		assert.deepEqual(contextPatch.messages.slice(0, -1), messages);
		assert.match(String(contextPatch.messages.at(-1)?.content), /read source\.ts/);
		assert.match(String(contextPatch.messages.at(-1)?.content), /STALE/);
		assert.deepEqual(customEntries, []);
		await commands.get("freshness")?.handler("", ctx);
		assert.match(report, /stale=1/);
	});

	it("replaces stale partial-read evidence with the latest read of the file", async () => {
		const cwd = await temporaryDirectory();
		const source = join(cwd, "source.ts");
		await writeFile(source, "before\nsecond\n");
		const { api, handlers } = fakePi();
		workspaceLedgerExtension(api);
		const ctx = headlessContext(cwd);
		await recordReadEvidence(handlers, ctx, source, "read-first", { offset: 1, limit: 1 });

		await writeFile(source, "after\nsecond\n");
		await recordReadEvidence(handlers, ctx, source, "read-second", { offset: 2, limit: 1 });

		assert.equal(await call(handlers, "context", { messages: [] }, ctx), undefined);
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

	it("does not bind exact evidence across an A-B-A read", async () => {
		const cwd = await temporaryDirectory();
		const source = join(cwd, "source.ts");
		await writeFile(source, "A\n");
		const { api, handlers } = fakePi();
		workspaceLedgerExtension(api);
		const ctx = headlessContext(cwd);
		const input = { path: source };

		await call(handlers, "tool_call", { toolName: "read", toolCallId: "aba", input }, ctx);
		await writeFile(source, "B\n");
		const result = await createReadToolDefinition(cwd).execute("aba", input, undefined, undefined, ctx as any);
		await writeFile(source, "A\n");
		await call(handlers, "tool_result", {
			toolName: "read",
			toolCallId: "aba",
			input,
			content: result.content,
			details: result.details,
			isError: false,
		}, ctx);

		const projection = (await call(handlers, "context", { messages: [] }, ctx)) as {
			messages: Array<{ content: unknown }>;
		};
		assert.match(String(projection.messages.at(-1)?.content), /UNVERIFIED/);
	});

	it("tracks the path resolved by the built-in read", async () => {
		const cwd = await temporaryDirectory();
		const source = join(cwd, "source.ts");
		await Promise.all([writeFile(source, "actual\n"), writeFile(join(cwd, "@source.ts"), "decoy\n")]);
		const { api, handlers } = fakePi();
		workspaceLedgerExtension(api);
		const ctx = headlessContext(cwd);
		await recordReadEvidence(handlers, ctx, "@source.ts", "normalized-path");
		await writeFile(source, "changed\n");

		const projection = (await call(handlers, "context", { messages: [] }, ctx)) as {
			messages: Array<{ content: unknown }>;
		};
		assert.match(String(projection.messages.at(-1)?.content), /STALE/);
	});

	it("ignores unrecognized read overrides without producer evidence", async () => {
		const cwd = await temporaryDirectory();
		const source = join(cwd, "source.ts");
		await writeFile(source, "local\n");
		const { api, handlers } = fakePi("extension");
		workspaceLedgerExtension(api);
		const ctx = headlessContext(cwd);
		const input = { path: source };
		await call(handlers, "tool_call", { toolName: "read", toolCallId: "override", input }, ctx);
		await call(handlers, "tool_result", {
			toolName: "read",
			toolCallId: "override",
			input,
			content: [{ type: "text", text: "remote\n" }],
			details: {},
			isError: false,
		}, ctx);

		assert.equal(await call(handlers, "context", { messages: [] }, ctx), undefined);
	});

	it("tracks npm hashline reads conservatively", async () => {
		const cwd = await temporaryDirectory();
		const source = join(cwd, "source.ts");
		await writeFile(source, "local\n");
		let report = "";
		const { api, handlers, commands } = fakePi("npm:pi-hashline-edit@0.8.3");
		workspaceLedgerExtension(api);
		const ctx = {
			...headlessContext(cwd),
			hasUI: true,
			ui: { notify(value: string) { report = value; } },
		};
		const input = { path: source };
		await call(handlers, "tool_call", { toolName: "read", toolCallId: "hashline", input }, ctx);
		await call(handlers, "tool_result", {
			toolName: "read",
			toolCallId: "hashline",
			input,
			content: [{ type: "text", text: "1#AA:local\n" }],
			details: { snapshotId: await hashlineSnapshotId(source) },
			isError: false,
		}, ctx);

		assert.equal(await call(handlers, "context", { messages: [] }, ctx), undefined);
		await commands.get("freshness")?.handler("", ctx);
		assert.match(report, /current-conservative=1/);

		await writeFile(source, "changed\n");
		const projection = (await call(handlers, "context", { messages: [] }, ctx)) as {
			messages: Array<{ content: unknown }>;
		};
		assert.match(String(projection.messages.at(-1)?.content), /STALE/);
	});

	it("tracks hashline image reads conservatively through the built-in fallback", async () => {
		const cwd = await temporaryDirectory();
		const image = join(cwd, "pixel.png");
		await writeFile(image, PIXEL_PNG);
		let report = "";
		const { api, handlers, commands } = fakePi("npm:pi-hashline-edit@0.8.3");
		workspaceLedgerExtension(api);
		const ctx = {
			...headlessContext(cwd),
			hasUI: true,
			ui: { notify(value: string) { report = value; } },
		};
		const input = { path: image };
		await call(handlers, "tool_call", { toolName: "read", toolCallId: "hashline-image", input }, ctx);
		const result = await createReadToolDefinition(cwd).execute(
			"hashline-image",
			input,
			undefined,
			undefined,
			ctx as any,
		);
		await call(handlers, "tool_result", {
			toolName: "read",
			toolCallId: "hashline-image",
			input,
			content: result.content,
			details: result.details,
			isError: false,
		}, ctx);

		await commands.get("freshness")?.handler("", ctx);
		assert.match(report, /current-conservative=1/);

		await writeFile(image, Buffer.from("changed"));
		const projection = (await call(handlers, "context", { messages: [] }, ctx)) as {
			messages: Array<{ content: unknown }>;
		};
		assert.match(String(projection.messages.at(-1)?.content), /STALE/);
	});

	it("keeps hashline reads unverified when their snapshot cannot be matched", async () => {
		const cwd = await temporaryDirectory();
		const source = join(cwd, "source.ts");
		await writeFile(source, "local\n");
		const { api, handlers } = fakePi("npm:pi-hashline-edit@0.8.3");
		workspaceLedgerExtension(api);
		const ctx = headlessContext(cwd);
		const input = { path: source };
		await call(handlers, "tool_call", { toolName: "read", toolCallId: "hashline-mismatch", input }, ctx);
		await call(handlers, "tool_result", {
			toolName: "read",
			toolCallId: "hashline-mismatch",
			input,
			content: [{ type: "text", text: "1#AA:local\n" }],
			details: { snapshotId: "v1|different|0|0" },
			isError: false,
		}, ctx);

		const projection = (await call(handlers, "context", { messages: [] }, ctx)) as {
			messages: Array<{ content: unknown }>;
		};
		assert.match(String(projection.messages.at(-1)?.content), /UNVERIFIED/);
	});

	it("keeps unreproducible hashline results without a snapshot unverified", async () => {
		const cwd = await temporaryDirectory();
		const source = join(cwd, "source.ts");
		await writeFile(source, "local\n");
		const { api, handlers } = fakePi("npm:pi-hashline-edit@0.8.3");
		workspaceLedgerExtension(api);
		const ctx = headlessContext(cwd);
		const input = { path: source };
		await call(handlers, "tool_call", { toolName: "read", toolCallId: "hashline-no-snapshot", input }, ctx);
		await call(handlers, "tool_result", {
			toolName: "read",
			toolCallId: "hashline-no-snapshot",
			input,
			content: [{ type: "text", text: "not the file" }],
			details: {},
			isError: false,
		}, ctx);

		const projection = (await call(handlers, "context", { messages: [] }, ctx)) as {
			messages: Array<{ content: unknown }>;
		};
		assert.match(String(projection.messages.at(-1)?.content), /UNVERIFIED/);
	});

	it("keeps supported image reads exact", async () => {
		const cwd = await temporaryDirectory();
		const image = join(cwd, "pixel.png");
		await writeFile(image, PIXEL_PNG);
		let report = "";
		const { api, handlers, commands } = fakePi();
		workspaceLedgerExtension(api);
		const ctx = {
			...headlessContext(cwd),
			hasUI: true,
			ui: { notify(value: string) { report = value; } },
		};
		await recordReadEvidence(handlers, ctx, image, "image");
		await commands.get("freshness")?.handler("", ctx);
		assert.match(report, /current=1/);
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
		const { api, handlers, customEntries } = fakePi();
		workspaceLedgerExtension(api);
		const ctx = {
			cwd: tmpdir(),
			hasUI: false,
			sessionManager: { getBranch() { throw new Error("session branch must not be read"); } },
			ui: { notify() {} },
		};

		assert.equal(
			await call(handlers, "context", { messages: [oldToolResult] }, ctx),
			undefined,
		);
		assert.deepEqual(customEntries, []);
	});

	it("expires each built-in read independently after three subsequent user messages", async () => {
		const cwd = await temporaryDirectory();
		const source = join(cwd, "source.ts");
		const second = join(cwd, "second.ts");
		await Promise.all([writeFile(source, "first\n"), writeFile(second, "second\n")]);
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
		await recordReadEvidence(handlers, ctx, second, "read-second");
		await Promise.all([writeFile(source, "changed\n"), writeFile(second, "changed\n")]);
		await recordUserMessage(handlers, ctx, "user-3");
		await recordUserMessage(handlers, ctx, "user-4");

		const active = (await call(handlers, "context", { messages: [] }, ctx)) as {
			messages: Array<{ content: unknown }>;
		};
		const notice = String(active.messages.at(-1)?.content);
		assert.match(notice, /read second\.ts/);
		assert.doesNotMatch(notice, /read source\.ts/);

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
});
