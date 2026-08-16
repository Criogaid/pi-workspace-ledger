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
});
