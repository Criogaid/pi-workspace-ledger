import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	FRESHNESS_DETAILS_KEY,
	envelopeFromDetails,
	mergeEnvelopes,
	type FreshnessEnvelopeV1,
	type JsonValue,
} from "./envelope.js";
import { LedgerState } from "./ledger.js";
import { renderFreshnessNotice, renderFreshnessReport } from "./render.js";

const CUSTOM_ENTRY_TYPE = "pi-workspace-ledger-envelope";
const CONTEXT_MESSAGE_TYPE = "pi-workspace-ledger-context";
const MUTATION_TOOLS = new Set(["edit", "write"]);

interface PendingRead {
	path: string;
	resource: string;
	beforeStamp: string | null;
	subject: string;
}

interface PersistedEnvelope {
	eventId: string;
	envelope: FreshnessEnvelopeV1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inputPath(input: unknown): string | undefined {
	return isRecord(input) && typeof input.path === "string" ? input.path : undefined;
}

async function canonicalPath(cwd: string, input: string): Promise<string> {
	const absolute = isAbsolute(input) ? resolve(input) : resolve(cwd, input);
	try {
		return await realpath(absolute);
	} catch {
		return absolute;
	}
}

async function fileResource(cwd: string, input: string): Promise<{ path: string; resource: string }> {
	const path = await canonicalPath(cwd, input);
	return { path, resource: pathToFileURL(path).href };
}

interface FileHashResolution {
	stamp: string | null;
	missing: boolean;
}

async function resolveFileStamp(path: string): Promise<FileHashResolution> {
	try {
		return { stamp: createHash("sha256").update(await readFile(path)).digest("hex"), missing: false };
	} catch (error) {
		return { stamp: null, missing: isRecord(error) && error.code === "ENOENT" };
	}
}

async function hashFile(path: string): Promise<string | null> {
	return (await resolveFileStamp(path)).stamp;
}

function displayPath(cwd: string, path: string): string {
	const value = relative(cwd, path);
	return value.length > 0 && !value.startsWith("..") ? value.replaceAll("\\", "/") : path;
}

function readSubject(cwd: string, path: string, input: unknown): string {
	const base = `read ${displayPath(cwd, path)}`;
	if (!isRecord(input)) return base;
	const offset = Number.isInteger(input.offset) && Number(input.offset) > 0 ? Number(input.offset) : undefined;
	const limit = Number.isInteger(input.limit) && Number(input.limit) > 0 ? Number(input.limit) : undefined;
	if (!offset && !limit) return base;
	if (!limit) return `${base} from line ${offset}`;
	const start = offset ?? 1;
	return `${base} lines ${start}-${start + limit - 1}`;
}

function persistedEnvelope(value: unknown): PersistedEnvelope | undefined {
	if (!isRecord(value) || typeof value.eventId !== "string") return undefined;
	const envelope = value.envelope;
	if (!isRecord(envelope)) return undefined;
	const parsed = envelopeFromDetails({ [FRESHNESS_DETAILS_KEY]: envelope });
	return parsed ? { eventId: value.eventId, envelope: parsed } : undefined;
}

function attachEnvelope(details: unknown, envelope: FreshnessEnvelopeV1): Record<string, unknown> | undefined {
	if (details === undefined) return { [FRESHNESS_DETAILS_KEY]: envelope };
	if (!isRecord(details)) return undefined;
	return { ...details, [FRESHNESS_DETAILS_KEY]: envelope };
}

function replay(ctx: ExtensionContext): LedgerState {
	const state = new LedgerState();
	for (const rawEntry of ctx.sessionManager.getBranch()) {
		const entry = rawEntry as {
			id?: string;
			type?: string;
			customType?: string;
			data?: unknown;
			message?: { role?: string; toolCallId?: string; details?: unknown };
		};

		if (entry.type === "custom" && entry.customType === CUSTOM_ENTRY_TYPE) {
			const persisted = persistedEnvelope(entry.data);
			if (persisted) state.apply({ kind: "envelope", entryId: persisted.eventId, envelope: persisted.envelope });
			continue;
		}

		if (entry.type !== "message" || entry.message?.role !== "toolResult") continue;
		const envelope = envelopeFromDetails(entry.message.details);
		if (!envelope) continue;
		state.apply({
			kind: "envelope",
			entryId: entry.message.toolCallId ?? entry.id ?? "unknown-tool-result",
			envelope,
		});
	}
	return state;
}

async function refreshFileEvidence(state: LedgerState): Promise<void> {
	const dependencies = new Map<string, { resource: string; selector?: JsonValue }>();
	for (const evidence of state.project()) {
		for (const dependency of evidence.dependencies) {
			if (dependency.facet !== "content" || !dependency.resource.startsWith("file:")) continue;
			const key = JSON.stringify([dependency.resource, dependency.selector]);
			dependencies.set(key, {
				resource: dependency.resource,
				...(dependency.selector === undefined ? {} : { selector: dependency.selector }),
			});
		}
	}

	const resources = [...new Set([...dependencies.values()].map((dependency) => dependency.resource))].sort();
	const resolutions = new Map<string, FileHashResolution>();
	await Promise.all(
		resources.map(async (resource) => {
			try {
				resolutions.set(resource, await resolveFileStamp(fileURLToPath(resource)));
			} catch {
				resolutions.set(resource, { stamp: null, missing: false });
			}
		}),
	);

	for (const dependency of dependencies.values()) {
		const resolution = resolutions.get(dependency.resource) ?? { stamp: null, missing: false };
		state.apply({
			kind: "resolved",
			resource: dependency.resource,
			facet: "content",
			...(dependency.selector === undefined ? {} : { selector: dependency.selector }),
			// selector 没有专用 resolver 时，整文件 hash 不能证明局部 stamp 仍然有效。
			stamp: dependency.selector === undefined ? resolution.stamp : null,
			missing: resolution.missing,
		});
	}
}

export default function workspaceLedgerExtension(pi: ExtensionAPI): void {
	const pendingReads = new Map<string, PendingRead>();

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "read") return;
		const requestedPath = inputPath(event.input);
		if (!requestedPath) return;
		const file = await fileResource(ctx.cwd, requestedPath);

		// 调用前后 hash 一致时，evidence 才绑定到工具实际读取期间的稳定内容。
		pendingReads.set(event.toolCallId, {
			...file,
			beforeStamp: await hashFile(file.path),
			subject: readSubject(ctx.cwd, file.path, event.input),
		});
	});

	pi.on("tool_result", async (event, ctx) => {
		const existing = envelopeFromDetails(event.details);
		let adapted: FreshnessEnvelopeV1 | undefined;

		if (event.toolName === "read") {
			const pending = pendingReads.get(event.toolCallId);
			pendingReads.delete(event.toolCallId);
			if (!event.isError && pending) {
				const afterStamp = await hashFile(pending.path);
				const stable = afterStamp !== null && afterStamp === pending.beforeStamp;
				adapted = {
					version: 1,
					evidence: [
						{
							subject: pending.subject,
							dependencies: afterStamp
								? [{ resource: pending.resource, facet: "content", stamp: afterStamp }]
								: [],
							assurance: stable ? "exact" : "unverified",
						},
					],
				};
			}
		} else if (!event.isError && MUTATION_TOOLS.has(event.toolName)) {
			const requestedPath = inputPath(event.input);
			if (requestedPath) {
				const file = await fileResource(ctx.cwd, requestedPath);
				adapted = {
					version: 1,
					changes: [{ resource: file.resource, facet: "content" }],
				};
			}
		}

		const envelope = mergeEnvelopes(existing, adapted);
		if (!envelope || !adapted) return;

		const details = attachEnvelope(event.details, envelope);
		if (details) return { details };

		// 上游 details 不是对象时不改写其契约，使用隐藏 entry 持久化。
		pi.appendEntry(CUSTOM_ENTRY_TYPE, { eventId: event.toolCallId, envelope } satisfies PersistedEnvelope);
	});

	pi.on("context", async (event, ctx) => {
		// Session branch 是并行工具的确定性顺序来源；局部 snapshot 避免生命周期事件替换投影。
		const projection = replay(ctx);
		await refreshFileEvidence(projection);
		const notice = renderFreshnessNotice(projection.project());
		if (!notice) return;
		const message = {
			role: "custom",
			customType: CONTEXT_MESSAGE_TYPE,
			content: notice,
			display: false,
			timestamp: Date.now(),
		} satisfies (typeof event.messages)[number];
		return { messages: [...event.messages, message] };
	});

	pi.registerCommand("freshness", {
		description: "Show workspace evidence freshness",
		handler: async (_args, ctx) => {
			const projection = replay(ctx);
			await refreshFileEvidence(projection);
			const report = renderFreshnessReport(projection.project());
			if (ctx.hasUI) ctx.ui.notify(report, "info");
			else console.log(report);
		},
	});
}
