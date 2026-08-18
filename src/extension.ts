import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { envelopeFromDetails, mergeEnvelopes, type FreshnessEnvelopeV1, type JsonValue } from "./envelope.js";
import { LedgerState, type EvidenceView } from "./ledger.js";
import { renderFreshnessNotice, renderFreshnessReport } from "./render.js";

const NOTICE_DETAILS_KEY = "pi-workspace-ledger/notice";
const NOTICE_MESSAGE_TYPE = "pi-workspace-ledger-notice";
const SAFETY_MESSAGE_TYPE = "pi-workspace-ledger-safety-fallback";
const FRESHNESS_NOTICE_PREFIX = "Workspace freshness (machine-generated status):";
const READ_RETENTION_USER_MESSAGES = 3;
const MUTATION_TOOLS = new Set(["edit", "write"]);

interface PendingRead {
	path: string;
	resource: string;
	beforeStamp: string | null;
	subject: string;
}

interface RuntimeReadRetention {
	evidenceIndex: number;
	userMessageIndex: number;
}

interface RuntimeEnvelope {
	entryId: string;
	envelope: FreshnessEnvelopeV1;
	readRetention?: RuntimeReadRetention;
}

interface NoticeMarker {
	version: 1;
	abnormalKey: string | null;
	projectionOnly?: true;
}

interface FreshnessProjection {
	records: EvidenceView[];
	noticeText?: string;
}

interface FileHashResolution {
	stamp: string | null;
	missing: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inputPath(input: unknown): string | undefined {
	return isRecord(input) && typeof input.path === "string" ? input.path : undefined;
}

function logicalPath(cwd: string, input: string): string {
	return isAbsolute(input) ? resolve(input) : resolve(cwd, input);
}

function isWorkspacePath(cwd: string, path: string): boolean {
	const value = relative(resolve(cwd), path);
	return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function fileResource(cwd: string, input: string): { path: string; resource: string } {
	const path = logicalPath(cwd, input);
	return { path, resource: pathToFileURL(path).href };
}

async function resolveFileStamp(path: string): Promise<FileHashResolution> {
	try {
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(path)) hash.update(chunk);
		return { stamp: hash.digest("hex"), missing: false };
	} catch (error) {
		return { stamp: null, missing: isRecord(error) && error.code === "ENOENT" };
	}
}

async function hashFile(path: string): Promise<string | null> {
	return (await resolveFileStamp(path)).stamp;
}

async function canonicalHashPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return path;
	}
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

function noticeMarker(value: unknown): NoticeMarker | undefined {
	if (!isRecord(value) || value.version !== 1) return undefined;
	if (value.abnormalKey !== null && (typeof value.abnormalKey !== "string" || !/^[0-9a-f]{64}$/.test(value.abnormalKey))) {
		return undefined;
	}
	if (value.projectionOnly !== undefined && value.projectionOnly !== true) return undefined;
	return {
		version: 1,
		abnormalKey: value.abnormalKey,
		...(value.projectionOnly === true ? { projectionOnly: true } : {}),
	};
}

function noticeFromDetails(details: unknown): NoticeMarker | undefined {
	return isRecord(details) ? noticeMarker(details[NOTICE_DETAILS_KEY]) : undefined;
}

function isFreshnessNoticePart(value: unknown): boolean {
	return (
		isRecord(value) &&
		value.type === "text" &&
		typeof value.text === "string" &&
		value.text.startsWith(FRESHNESS_NOTICE_PREFIX)
	);
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
	const hashes = new Map<string, Promise<FileHashResolution>>();
	await Promise.all(
		resources.map(async (resource) => {
			try {
				const target = await canonicalHashPath(fileURLToPath(resource));
				let resolution = hashes.get(target);
				if (!resolution) {
					resolution = resolveFileStamp(target);
					hashes.set(target, resolution);
				}
				resolutions.set(resource, await resolution);
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

async function projectFreshness(
	events: readonly RuntimeEnvelope[],
	userMessageIndex: number,
): Promise<FreshnessProjection> {
	const ledger = new LedgerState();
	for (const event of events) {
		const retention = event.readRetention;
		const expired =
			retention && userMessageIndex - retention.userMessageIndex > READ_RETENTION_USER_MESSAGES;
		ledger.apply({
			kind: "envelope",
			entryId: event.entryId,
			envelope: event.envelope,
			...(expired ? { retiredEvidenceIndexes: [retention.evidenceIndex] } : {}),
		});
	}
	await refreshFileEvidence(ledger);
	const records = ledger.project();
	const noticeText = renderFreshnessNotice(records);
	return { records, ...(noticeText ? { noticeText } : {}) };
}

export default function workspaceLedgerExtension(pi: ExtensionAPI): void {
	const pendingReads = new Map<string, PendingRead>();
	const runtimeEvents: RuntimeEnvelope[] = [];
	let userMessageIndex = 0;

	const resetRuntime = () => {
		pendingReads.clear();
		runtimeEvents.length = 0;
		userMessageIndex = 0;
	};

	pi.on("session_start", resetRuntime);
	pi.on("session_tree", resetRuntime);
	pi.on("session_compact", resetRuntime);
	pi.on("session_shutdown", resetRuntime);

	pi.on("message_end", (event) => {
		if (event.message.role === "user") userMessageIndex++;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "read") return;
		const requestedPath = inputPath(event.input);
		if (!requestedPath) return;
		const file = fileResource(ctx.cwd, requestedPath);
		if (!isWorkspacePath(ctx.cwd, file.path)) return;

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
		let readEvidenceIndex: number | undefined;

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
				readEvidenceIndex = existing?.evidence?.length ?? 0;
			}
		} else if (!event.isError && MUTATION_TOOLS.has(event.toolName)) {
			const requestedPath = inputPath(event.input);
			if (requestedPath) {
				const file = fileResource(ctx.cwd, requestedPath);
				adapted = {
					version: 1,
					changes: [{ resource: file.resource, facet: "content" }],
				};
			}
		}

		const envelope = mergeEnvelopes(existing, adapted);
		if (!envelope) return;
		runtimeEvents.push({
			entryId: event.toolCallId,
			envelope,
			...(readEvidenceIndex === undefined
				? {}
				: { readRetention: { evidenceIndex: readEvidenceIndex, userMessageIndex } }),
		});
	});

	pi.on("context", async (event) => {
		const projection = await projectFreshness(runtimeEvents, userMessageIndex);
		let filtered = false;
		const messages: typeof event.messages = [];
		for (const message of event.messages) {
			if (
				message.role === "custom" &&
				(message.customType === NOTICE_MESSAGE_TYPE || message.customType === SAFETY_MESSAGE_TYPE)
			) {
				filtered = true;
				continue;
			}
			if (message.role !== "toolResult") {
				messages.push(message);
				continue;
			}
			const marker = noticeFromDetails(message.details);
			const lastPart = message.content.at(-1);
			const hasLegacyInlineNotice =
				marker !== undefined && marker.projectionOnly !== true && isFreshnessNoticePart(lastPart);
			if (hasLegacyInlineNotice) filtered = true;
			messages.push(
				hasLegacyInlineNotice ? { ...message, content: message.content.slice(0, -1) } : message,
			);
		}

		if (projection.noticeText) {
			const message = {
				role: "custom",
				customType: SAFETY_MESSAGE_TYPE,
				content: projection.noticeText,
				display: false,
				timestamp: Date.now(),
			} satisfies (typeof event.messages)[number];
			return { messages: [...messages, message] };
		}
		if (filtered) return { messages };
	});

	pi.registerCommand("freshness", {
		description: "Show workspace evidence freshness",
		handler: async (_args, ctx) => {
			const projection = await projectFreshness(runtimeEvents, userMessageIndex);
			const report = renderFreshnessReport(projection.records);
			if (ctx.hasUI) ctx.ui.notify(report, "info");
			else console.log(report);
		},
	});
}
