import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FRESHNESS_DETAILS_KEY, type FreshnessEnvelopeV1 } from "../src/envelope.js";
import workspaceLedgerExtension from "../src/extension.js";

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

const NOTICE_DETAILS_KEY = "pi-workspace-ledger/notice";

function fakePi(branch?: unknown[]) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: Handler }>();
	const customEntries: Array<{ customType: string; data: unknown }> = [];
	let customEntryIndex = 0;
	const api = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name: string, command: { handler: Handler }) {
			commands.set(name, command);
		},
		appendEntry(customType: string, data: unknown) {
			customEntries.push({ customType, data });
			branch?.push({ id: `custom-${++customEntryIndex}`, type: "custom", customType, data });
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
	branch: unknown[],
	path: string,
	toolCallId = "read-1",
): Promise<void> {
	const input = { path };
	await call(handlers, "tool_call", { toolName: "read", toolCallId, input }, ctx);
	const patch = (await call(
		handlers,
		"tool_result",
		{ toolName: "read", toolCallId, input, details: {}, isError: false },
		ctx,
	)) as { details: Record<string, unknown> };
	branch.push({
		id: `entry-${toolCallId}`,
		type: "message",
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "read",
			content: [{ type: "text", text: "read" }],
			details: patch.details,
		},
	});
}

function persistNotice(branch: unknown[], id: string, message: Record<string, unknown>): void {
	branch.push({ id, type: "custom_message", ...message });
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Pi extension vertical slice", () => {
	it("turns a stable read into a stale context notice after edit", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-workspace-ledger-"));
		temporaryDirectories.push(cwd);
		const source = join(cwd, "source.ts");
		await writeFile(source, "export const value = 1;\n");

		const { api, handlers, commands } = fakePi();
		workspaceLedgerExtension(api);
		const branch: unknown[] = [];
		const ctx = {
			cwd,
			hasUI: false,
			sessionManager: { getBranch: () => branch },
			ui: { notify() {} },
		};
		await call(handlers, "session_start", {}, ctx);

		const readInput = { path: source, offset: 2, limit: 3 };
		await call(handlers, "tool_call", { toolName: "read", toolCallId: "read-1", input: readInput }, ctx);
		const readPatch = (await call(
			handlers,
			"tool_result",
			{ toolName: "read", toolCallId: "read-1", input: readInput, details: {}, isError: false },
			ctx,
		)) as { details: Record<string, unknown> };
		assert.ok(readPatch.details[FRESHNESS_DETAILS_KEY]);
		const readEnvelope = readPatch.details[FRESHNESS_DETAILS_KEY] as FreshnessEnvelopeV1;
		assert.match(readEnvelope.evidence?.[0]?.subject ?? "", /lines 2-4/);
		branch.push({
			id: "entry-read",
			type: "message",
			message: { role: "toolResult", toolCallId: "read-1", details: readPatch.details },
		});

		await writeFile(source, "export const value = 2;\n");
		const editPatch = (await call(
			handlers,
			"tool_result",
			{ toolName: "edit", toolCallId: "edit-1", input: { path: source }, details: {}, isError: false },
			ctx,
		)) as { details: Record<string, unknown> };
		assert.ok(editPatch.details[FRESHNESS_DETAILS_KEY]);
		branch.push({
			id: "entry-edit",
			type: "message",
			message: { role: "toolResult", toolCallId: "edit-1", details: editPatch.details },
		});

		const contextPatch = (await call(handlers, "context", { messages: [] }, ctx)) as {
			messages: Array<{ content?: string }>;
		};
		assert.match(contextPatch.messages.at(-1)?.content ?? "", /STALE/);
		assert.ok(commands.has("freshness"));
	});

	it("detects an out-of-band file change at the context boundary", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-workspace-ledger-"));
		temporaryDirectories.push(cwd);
		const source = join(cwd, "source.ts");
		await writeFile(source, "export const value = 1;\n");

		const { api, handlers, commands } = fakePi();
		workspaceLedgerExtension(api);
		const branch: unknown[] = [];
		let report = "";
		const ctx = {
			cwd,
			hasUI: true,
			sessionManager: { getBranch: () => branch },
			ui: { notify(value: string) { report = value; } },
		};

		await call(handlers, "tool_call", { toolName: "read", toolCallId: "read-1", input: { path: source } }, ctx);
		const readPatch = (await call(
			handlers,
			"tool_result",
			{ toolName: "read", toolCallId: "read-1", input: { path: source }, details: {}, isError: false },
			ctx,
		)) as { details: Record<string, unknown> };
		branch.push({
			id: "entry-read",
			type: "message",
			message: { role: "toolResult", toolCallId: "read-1", details: readPatch.details },
		});

		await writeFile(source, "export const value = 2;\n");
		const contextPatch = (await call(handlers, "context", { messages: [] }, ctx)) as {
			messages: Array<{ content?: string }>;
		};
		assert.match(contextPatch.messages.at(-1)?.content ?? "", /STALE/);
		const durable = (await call(handlers, "before_agent_start", {}, ctx)) as {
			message: Record<string, unknown>;
		};
		assert.match(String(durable.message.content), /STALE/);
		await commands.get("freshness")?.handler("", ctx);
		assert.match(report, /STALE/);
	});

	it("does not claim selected file evidence is current without a selector resolver", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-workspace-ledger-"));
		temporaryDirectories.push(cwd);
		const source = join(cwd, "source.ts");
		await writeFile(source, "export const value = 1;\n");
		const resource = pathToFileURL(source).href;

		const { api, handlers } = fakePi();
		workspaceLedgerExtension(api);
		const branch = [
			{
				id: "entry-selected",
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "selected-1",
					details: {
						[FRESHNESS_DETAILS_KEY]: {
							version: 1,
							evidence: [
								{
									subject: "selected source range",
									dependencies: [
										{ resource, facet: "content", selector: { start: 1, end: 1 }, stamp: "range-sha" },
									],
									assurance: "exact",
								},
							],
						},
					},
				},
			},
		];
		const ctx = {
			cwd,
			hasUI: false,
			sessionManager: { getBranch: () => branch },
			ui: { notify() {} },
		};

		await writeFile(source, "export const value = 2;\n");
		const contextPatch = (await call(handlers, "context", { messages: [] }, ctx)) as {
			messages: Array<{ content?: string }>;
		};
		assert.match(contextPatch.messages.at(-1)?.content ?? "", /UNVERIFIED/);
	});

	it("replays envelopes from the active session branch", async () => {
		const { api, handlers } = fakePi();
		workspaceLedgerExtension(api);
		const resource = "file:///repo/source.ts";
		const branch = [
			{
				id: "entry-read",
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "read-1",
					details: {
						[FRESHNESS_DETAILS_KEY]: {
							version: 1,
							evidence: [
								{
									subject: "read source.ts",
									dependencies: [{ resource, facet: "content", stamp: "sha-a" }],
									assurance: "exact",
								},
							],
						},
					},
				},
			},
			{
				id: "entry-edit",
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "edit-1",
					details: {
						[FRESHNESS_DETAILS_KEY]: {
							version: 1,
							changes: [{ resource, facet: "content" }],
						},
					},
				},
			},
		];
		const ctx = {
			cwd: "/repo",
			hasUI: false,
			sessionManager: { getBranch: () => branch },
			ui: { notify() {} },
		};

		await call(handlers, "session_start", {}, ctx);
		const contextPatch = (await call(handlers, "context", { messages: [] }, ctx)) as {
			messages: Array<{ content?: string }>;
		};
		assert.match(contextPatch.messages.at(-1)?.content ?? "", /STALE/);
	});

	it("persists an out-of-band notice and deduplicates it after restart", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-workspace-ledger-"));
		temporaryDirectories.push(cwd);
		const source = join(cwd, "source.ts");
		await writeFile(source, "export const value = 1;\n");
		const branch: unknown[] = [];
		const { api, handlers } = fakePi(branch);
		workspaceLedgerExtension(api);
		const ctx = { cwd, hasUI: false, sessionManager: { getBranch: () => branch }, ui: { notify() {} } };
		await recordReadEvidence(handlers, ctx, branch, source);

		await writeFile(source, "export const value = 2;\n");
		const first = (await call(handlers, "before_agent_start", {}, ctx)) as {
			message: Record<string, unknown>;
		};
		assert.match(String(first.message.content), /STALE/);
		assert.ok((first.message.details as Record<string, unknown>)[NOTICE_DETAILS_KEY]);
		persistNotice(branch, "notice-1", first.message);

		const resumed = fakePi(branch);
		workspaceLedgerExtension(resumed.api);
		assert.equal(await call(resumed.handlers, "before_agent_start", {}, ctx), undefined);

		const siblingBranch = branch.slice(0, -1);
		const sibling = fakePi(siblingBranch);
		workspaceLedgerExtension(sibling.api);
		const siblingCtx = { ...ctx, sessionManager: { getBranch: () => siblingBranch } };
		const siblingNotice = (await call(sibling.handlers, "before_agent_start", {}, siblingCtx)) as {
			message: Record<string, unknown>;
		};
		assert.match(String(siblingNotice.message.content), /STALE/);
	});

	it("appends one notice to the final tool result in a batch", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-workspace-ledger-"));
		temporaryDirectories.push(cwd);
		const source = join(cwd, "source.ts");
		await writeFile(source, "export const value = 1;\n");
		const branch: unknown[] = [];
		const { api, handlers } = fakePi(branch);
		workspaceLedgerExtension(api);
		const ctx = { cwd, hasUI: false, sessionManager: { getBranch: () => branch }, ui: { notify() {} } };
		await recordReadEvidence(handlers, ctx, branch, source);
		await writeFile(source, "export const value = 2;\n");

		const editPatch = async (toolCallId: string) => (await call(
			handlers,
			"tool_result",
			{ toolName: "edit", toolCallId, input: { path: source }, details: {}, isError: false },
			ctx,
		)) as { details: Record<string, unknown> };
		const firstPatch = await editPatch("edit-1");
		const finalPatch = await editPatch("edit-2");
		await call(handlers, "message_end", {
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "edit-1" },
					{ type: "toolCall", id: "edit-2" },
				],
			},
		}, ctx);

		const firstResult = {
			role: "toolResult",
			toolCallId: "edit-1",
			toolName: "edit",
			content: [{ type: "text", text: "first edit" }],
			details: firstPatch.details,
		};
		assert.equal(await call(handlers, "message_end", { message: firstResult }, ctx), undefined);
		branch.push({ id: "entry-edit-1", type: "message", message: firstResult });

		const finalResult = {
			role: "toolResult",
			toolCallId: "edit-2",
			toolName: "edit",
			content: [{ type: "text", text: "final edit" }],
			details: finalPatch.details,
		};
		const replacement = (await call(handlers, "message_end", { message: finalResult }, ctx)) as {
			message: typeof finalResult;
		};
		assert.deepEqual(replacement.message.content[0], finalResult.content[0]);
		assert.match(replacement.message.content[1]?.text ?? "", /STALE/);
		assert.ok(replacement.message.details[NOTICE_DETAILS_KEY]);
		branch.push({ id: "entry-edit-2", type: "message", message: replacement.message });
		assert.equal(await call(handlers, "context", { messages: [replacement.message] }, ctx), undefined);
	});

	it("persists a primitive-details notice marker after the tool result", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-workspace-ledger-"));
		temporaryDirectories.push(cwd);
		const source = join(cwd, "source.ts");
		await writeFile(source, "export const value = 1;\n");
		const branch: unknown[] = [];
		const { api, handlers, customEntries } = fakePi(branch);
		workspaceLedgerExtension(api);
		const ctx = { cwd, hasUI: false, sessionManager: { getBranch: () => branch }, ui: { notify() {} } };
		await recordReadEvidence(handlers, ctx, branch, source);
		await writeFile(source, "export const value = 2;\n");
		assert.equal(await call(
			handlers,
			"tool_result",
			{ toolName: "edit", toolCallId: "edit-1", input: { path: source }, details: 7, isError: false },
			ctx,
		), undefined);
		await call(handlers, "message_end", {
			message: { role: "assistant", content: [{ type: "toolCall", id: "edit-1" }] },
		}, ctx);
		const result = {
			role: "toolResult",
			toolCallId: "edit-1",
			toolName: "edit",
			content: [{ type: "text", text: "edited" }],
			details: 7,
		};
		const replacement = (await call(handlers, "message_end", { message: result }, ctx)) as {
			message: typeof result;
		};
		assert.equal(replacement.message.details, 7);
		assert.match(replacement.message.content[1]?.text ?? "", /STALE/);
		branch.push({ id: "entry-edit", type: "message", message: replacement.message });
		await call(handlers, "turn_end", {}, ctx);
		assert.equal(customEntries.at(-1)?.customType, "pi-workspace-ledger-notice-state");

		const resumed = fakePi(branch);
		workspaceLedgerExtension(resumed.api);
		assert.equal(await call(resumed.handlers, "before_agent_start", {}, ctx), undefined);
	});

	it("resets deduplication host-side and can notify the same anomaly again", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-workspace-ledger-"));
		temporaryDirectories.push(cwd);
		const source = join(cwd, "source.ts");
		const original = "export const value = 1;\n";
		await writeFile(source, original);
		const branch: unknown[] = [];
		const { api, handlers, customEntries } = fakePi(branch);
		workspaceLedgerExtension(api);
		const ctx = { cwd, hasUI: false, sessionManager: { getBranch: () => branch }, ui: { notify() {} } };
		await recordReadEvidence(handlers, ctx, branch, source);

		await writeFile(source, "export const value = 2;\n");
		const first = (await call(handlers, "before_agent_start", {}, ctx)) as { message: Record<string, unknown> };
		persistNotice(branch, "notice-1", first.message);
		await writeFile(source, original);
		assert.equal(await call(handlers, "before_agent_start", {}, ctx), undefined);
		assert.equal(customEntries.at(-1)?.customType, "pi-workspace-ledger-notice-state");

		await writeFile(source, "export const value = 2;\n");
		const repeated = (await call(handlers, "before_agent_start", {}, ctx)) as {
			message: Record<string, unknown>;
		};
		assert.match(String(repeated.message.content), /STALE/);
	});

	it("emits one checkpoint for each compaction epoch while evidence stays abnormal", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-workspace-ledger-"));
		temporaryDirectories.push(cwd);
		const source = join(cwd, "source.ts");
		await writeFile(source, "export const value = 1;\n");
		const branch: unknown[] = [];
		const { api, handlers } = fakePi(branch);
		workspaceLedgerExtension(api);
		const ctx = { cwd, hasUI: false, sessionManager: { getBranch: () => branch }, ui: { notify() {} } };
		await recordReadEvidence(handlers, ctx, branch, source);
		await writeFile(source, "export const value = 2;\n");
		const first = (await call(handlers, "before_agent_start", {}, ctx)) as { message: Record<string, unknown> };
		persistNotice(branch, "notice-1", first.message);
		branch.push({ id: "compact-1", type: "compaction" });

		const checkpoint = (await call(handlers, "before_agent_start", {}, ctx)) as {
			message: Record<string, unknown>;
		};
		assert.match(String(checkpoint.message.content), /STALE/);
		persistNotice(branch, "notice-2", checkpoint.message);
		assert.equal(await call(handlers, "before_agent_start", {}, ctx), undefined);
	});
});
