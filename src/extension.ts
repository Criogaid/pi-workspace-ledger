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
import { LedgerState, type EvidenceView } from "./ledger.js";
import { abnormalEvidence, renderFreshnessNotice, renderFreshnessReport } from "./render.js";

const ENVELOPE_ENTRY_TYPE = "pi-workspace-ledger-envelope";
const NOTICE_ENTRY_TYPE = "pi-workspace-ledger-notice-state";
const NOTICE_DETAILS_KEY = "pi-workspace-ledger/notice";
const NOTICE_MESSAGE_TYPE = "pi-workspace-ledger-notice";
const SAFETY_MESSAGE_TYPE = "pi-workspace-ledger-safety-fallback";
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

interface NoticeMarker {
	version: 1;
	abnormalKey: string | null;
}

interface NoticeCursor extends NoticeMarker {
	compactionId: string | null;
}

interface ReplayResult {
	ledger: LedgerState;
	lastNotice?: NoticeCursor;
	compactionId: string | null;
}

interface FreshnessProjection extends ReplayResult {
	records: EvidenceView[];
	abnormalKey: string | null;
	noticeText?: string;
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

function noticeMarker(value: unknown): NoticeMarker | undefined {
	if (!isRecord(value) || value.version !== 1) return undefined;
	if (value.abnormalKey !== null && (typeof value.abnormalKey !== "string" || !/^[0-9a-f]{64}$/.test(value.abnormalKey))) {
		return undefined;
	}
	return { version: 1, abnormalKey: value.abnormalKey };
}

function noticeFromDetails(details: unknown): NoticeMarker | undefined {
	return isRecord(details) ? noticeMarker(details[NOTICE_DETAILS_KEY]) : undefined;
}

function attachNotice(details: unknown, marker: NoticeMarker): Record<string, unknown> | undefined {
	if (details === undefined) return { [NOTICE_DETAILS_KEY]: marker };
	if (!isRecord(details)) return undefined;
	return { ...details, [NOTICE_DETAILS_KEY]: marker };
}

function replay(ctx: ExtensionContext): ReplayResult {
	const ledger = new LedgerState();
	let compactionId: string | null = null;
	let lastNotice: NoticeCursor | undefined;
	const recordNotice = (marker: NoticeMarker | undefined) => {
		if (marker) lastNotice = { ...marker, compactionId };
	};

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "compaction") {
			compactionId = entry.id;
			continue;
		}

		if (entry.type === "custom") {
			if (entry.customType === ENVELOPE_ENTRY_TYPE) {
				const persisted = persistedEnvelope(entry.data);
				if (persisted) ledger.apply({ kind: "envelope", entryId: persisted.eventId, envelope: persisted.envelope });
			} else if (entry.customType === NOTICE_ENTRY_TYPE) {
				recordNotice(noticeMarker(entry.data));
			}
			continue;
		}

		if (entry.type === "custom_message") {
			if (entry.customType === NOTICE_MESSAGE_TYPE) recordNotice(noticeFromDetails(entry.details));
			continue;
		}

		if (entry.type !== "message" || entry.message?.role !== "toolResult") continue;
		const envelope = envelopeFromDetails(entry.message.details);
		if (envelope) {
			ledger.apply({
				kind: "envelope",
				entryId: entry.message.toolCallId ?? entry.id ?? "unknown-tool-result",
				envelope,
			});
		}
		recordNotice(noticeFromDetails(entry.message.details));
	}
	return { ledger, ...(lastNotice ? { lastNotice } : {}), compactionId };
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

function abnormalKey(records: EvidenceView[]): string | null {
	const abnormal = abnormalEvidence(records)
		.map((record) => ({
			id: record.id,
			status: record.status,
			subject: record.subject,
			reasons: [...record.reasons].sort(),
		}))
		.sort((left, right) => left.id.localeCompare(right.id));
	if (abnormal.length === 0) return null;
	return createHash("sha256").update(JSON.stringify(abnormal)).digest("hex");
}

async function projectFreshness(
	ctx: ExtensionContext,
	current?: { entryId: string; envelope: FreshnessEnvelopeV1 },
): Promise<FreshnessProjection> {
	const replayed = replay(ctx);
	if (current) replayed.ledger.apply({ kind: "envelope", ...current });
	await refreshFileEvidence(replayed.ledger);
	const records = replayed.ledger.project();
	const key = abnormalKey(records);
	const noticeText = key === null ? undefined : renderFreshnessNotice(records);
	return { ...replayed, records, abnormalKey: key, ...(noticeText ? { noticeText } : {}) };
}

function needsNotice(projection: FreshnessProjection): boolean {
	return (
		projection.abnormalKey !== null &&
		(projection.lastNotice?.abnormalKey !== projection.abnormalKey ||
			projection.lastNotice.compactionId !== projection.compactionId)
	);
}

function needsReset(projection: FreshnessProjection): boolean {
	return projection.abnormalKey === null && projection.lastNotice !== undefined && projection.lastNotice.abnormalKey !== null;
}

function markerFor(projection: FreshnessProjection): NoticeMarker {
	return { version: 1, abnormalKey: projection.abnormalKey };
}

function recordReset(pi: ExtensionAPI, projection: FreshnessProjection): void {
	if (needsReset(projection)) pi.appendEntry(NOTICE_ENTRY_TYPE, markerFor(projection));
}

function finalToolCallId(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	for (let index = message.content.length - 1; index >= 0; index--) {
		const part = message.content[index];
		if (isRecord(part) && part.type === "toolCall" && typeof part.id === "string") return part.id;
	}
	return undefined;
}

export default function workspaceLedgerExtension(pi: ExtensionAPI): void {
	const pendingReads = new Map<string, PendingRead>();
	let finalResultId: string | undefined;
	let pendingNotice: NoticeMarker | undefined;

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
		pi.appendEntry(ENVELOPE_ENTRY_TYPE, { eventId: event.toolCallId, envelope } satisfies PersistedEnvelope);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const projection = await projectFreshness(ctx);
		if (projection.abnormalKey === null) {
			recordReset(pi, projection);
			return;
		}
		if (!needsNotice(projection) || !projection.noticeText) return;
		return {
			message: {
				customType: NOTICE_MESSAGE_TYPE,
				content: projection.noticeText,
				display: false,
				details: { [NOTICE_DETAILS_KEY]: markerFor(projection) },
			},
		};
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role === "assistant") {
			finalResultId = finalToolCallId(event.message);
			return;
		}
		if (event.message.role !== "toolResult" || event.message.toolCallId !== finalResultId) return;
		finalResultId = undefined;

		const envelope = envelopeFromDetails(event.message.details);
		const projection = await projectFreshness(
			ctx,
			envelope ? { entryId: event.message.toolCallId, envelope } : undefined,
		);
		const marker = markerFor(projection);
		const details = attachNotice(event.message.details, marker);

		if (projection.abnormalKey === null) {
			if (!needsReset(projection)) return;
			if (!details) {
				pi.appendEntry(NOTICE_ENTRY_TYPE, marker);
				return;
			}
			return { message: { ...event.message, details } };
		}

		if (!needsNotice(projection) || !projection.noticeText) return;
		if (!details) pendingNotice = marker;
		return {
			message: {
				...event.message,
				content: [...event.message.content, { type: "text", text: projection.noticeText }],
				...(details ? { details } : {}),
			},
		};
	});

	pi.on("turn_end", () => {
		if (!pendingNotice) return;
		pi.appendEntry(NOTICE_ENTRY_TYPE, pendingNotice);
		pendingNotice = undefined;
	});

	pi.on("context", async (event, ctx) => {
		// 正常通知已随用户边界或工具结果持久化；这里只覆盖两者之间的竞态窗口。
		const projection = await projectFreshness(ctx);
		if (projection.abnormalKey === null) {
			recordReset(pi, projection);
			return;
		}
		if (!needsNotice(projection) || !projection.noticeText) return;
		const message = {
			role: "custom",
			customType: SAFETY_MESSAGE_TYPE,
			content: projection.noticeText,
			display: false,
			details: { [NOTICE_DETAILS_KEY]: markerFor(projection) },
			timestamp: Date.now(),
		} satisfies (typeof event.messages)[number];
		return { messages: [...event.messages, message] };
	});

	pi.registerCommand("freshness", {
		description: "Show workspace evidence freshness",
		handler: async (_args, ctx) => {
			const projection = replay(ctx).ledger;
			await refreshFileEvidence(projection);
			const report = renderFreshnessReport(projection.project());
			if (ctx.hasUI) ctx.ui.notify(report, "info");
			else console.log(report);
		},
	});
}
