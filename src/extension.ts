import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
	createReadToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	type ReadToolInput,
} from "@earendil-works/pi-coding-agent";
import { envelopeFromDetails, mergeEnvelopes, type FreshnessEnvelopeV1, type JsonValue } from "./envelope.js";
import { LedgerState, type EvidenceView } from "./ledger.js";
import { renderFreshnessNotice, renderFreshnessReport } from "./render.js";

const SAFETY_MESSAGE_TYPE = "pi-workspace-ledger-safety-fallback";
const READ_RETENTION_USER_MESSAGES = 3;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const HASHLINE_READ_SOURCE = /^npm:pi-hashline-edit(?:@|$)/;

interface PendingRead {
	path: string;
	resource: string;
	capturedStamp: string;
	input: ReadToolInput;
	content: unknown;
	subject: string;
}

interface PendingHashlineRead {
	path: string;
	resource: string;
	input: unknown;
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

function activeReadSource(pi: ExtensionAPI): string | undefined {
	return pi.getAllTools().find((tool) => tool.name === "read")?.sourceInfo.source;
}

function isHashlineReadSource(source: string | undefined): boolean {
	return source !== undefined && HASHLINE_READ_SOURCE.test(source);
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

async function hashlineSnapshotId(path: string): Promise<string | undefined> {
	try {
		const canonicalPath = await canonicalHashPath(path);
		const stats = await stat(canonicalPath);
		return `v1|${canonicalPath}|${stats.mtimeMs}|${stats.size}`;
	} catch {
		return undefined;
	}
}

function displayPath(cwd: string, path: string): string {
	const value = relative(cwd, path);
	return value.length > 0 && !value.startsWith("..") ? value.replaceAll("\\", "/") : path;
}

function readSubject(cwd: string, path: string): string {
	return `read ${displayPath(cwd, path)}`;
}

// ponytail: 异常 PNG/BMP 可能降为 unverified；Pi 导出 MIME detector 后直接复用。
function detectBuiltinImageMimeType(buffer: Buffer): string | null {
	if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff && buffer[3] !== 0xf7) {
		return "image/jpeg";
	}
	if (buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
		return "image/png";
	}
	if (buffer.toString("ascii", 0, 3) === "GIF") return "image/gif";
	if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
		return "image/webp";
	}
	if (buffer.toString("ascii", 0, 2) === "BM") return "image/bmp";
	return null;
}

async function captureBuiltinRead(
	toolCallId: string,
	input: ReadToolInput,
	ctx: ExtensionContext,
): Promise<PendingRead | undefined> {
	const { cwd, signal } = ctx;
	let file: ReturnType<typeof fileResource> | undefined;
	let captured: Buffer | undefined;
	let capturedStamp: string | undefined;
	const load = async (path: string): Promise<Buffer> => {
		if (captured) return captured;
		captured = await readFile(path);
		capturedStamp = createHash("sha256").update(captured).digest("hex");
		return captured;
	};

	try {
		// 复用 Pi 的 read 解析和输出规则，并把 stamp 绑定到同一次文件读取。
		const read = createReadToolDefinition(cwd, {
			operations: {
				async access(path) {
					const candidate = fileResource(cwd, path);
					if (!isWorkspacePath(cwd, candidate.path)) throw new Error("outside workspace");
					await access(path);
					file = candidate;
				},
				readFile: load,
				async detectImageMimeType(path) {
					return detectBuiltinImageMimeType(await load(path));
				},
			},
		});
		const result = await read.execute(toolCallId, input, signal, undefined, ctx);
		if (!file || !capturedStamp) return undefined;
		return {
			...file,
			capturedStamp,
			input: structuredClone(input),
			content: result.content,
			subject: readSubject(cwd, file.path),
		};
	} catch {
		return undefined;
	}
}

async function adaptHashlineRead(
	pending: PendingHashlineRead,
	toolCallId: string,
	input: unknown,
	content: unknown,
	details: unknown,
	ctx: ExtensionContext,
): Promise<FreshnessEnvelopeV1> {
	const reportedSnapshot = isRecord(details) && typeof details.snapshotId === "string"
		? details.snapshotId
		: undefined;
	const sameInput = isDeepStrictEqual(input, pending.input);
	let resource = pending.resource;
	let subject = pending.subject;
	let stamp: string | null = null;

	if (reportedSnapshot && sameInput) {
		const before = await hashlineSnapshotId(pending.path);
		if (before === reportedSnapshot) {
			const candidate = await hashFile(pending.path);
			const after = await hashlineSnapshotId(pending.path);
			// snapshotId 只有路径、mtime 和大小；前后夹住内容哈希仍只能保守证明。
			if (candidate && after === before) stamp = candidate;
		}
	} else if (!reportedSnapshot && sameInput) {
		const replay = await captureBuiltinRead(toolCallId, input as ReadToolInput, ctx);
		if (replay) {
			const afterStamp = await hashFile(replay.path);
			// 图片分支没有 snapshotId；重放只能证明当前结果可复现，不能升级为 exact。
			if (afterStamp === replay.capturedStamp && isDeepStrictEqual(content, replay.content)) {
				resource = replay.resource;
				subject = replay.subject;
				stamp = afterStamp;
			}
		}
	}

	return {
		version: 1,
		evidence: [
			{
				subject,
				dependencies: stamp ? [{ resource, facet: "content", stamp }] : [],
				assurance: stamp ? "conservative" : "unverified",
			},
		],
	};
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
	const pendingHashlineReads = new Map<string, PendingHashlineRead>();
	const runtimeEvents: RuntimeEnvelope[] = [];
	let userMessageIndex = 0;

	const resetRuntime = () => {
		pendingReads.clear();
		pendingHashlineReads.clear();
		runtimeEvents.length = 0;
		userMessageIndex = 0;
	};

	// Pi 会为 session 替换创建新扩展实例；这里只处理实例内的上下文重写。
	pi.on("session_tree", resetRuntime);
	pi.on("session_compact", resetRuntime);

	pi.on("message_end", (event) => {
		if (event.message.role === "user") userMessageIndex++;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "read") return;

		const source = activeReadSource(pi);
		if (source === "builtin") {
			const pending = await captureBuiltinRead(event.toolCallId, event.input as ReadToolInput, ctx);
			if (pending) pendingReads.set(event.toolCallId, pending);
			return;
		}

		if (!isHashlineReadSource(source)) return;
		const requestedPath = inputPath(event.input);
		if (!requestedPath) return;
		const file = fileResource(ctx.cwd, requestedPath);
		if (!isWorkspacePath(ctx.cwd, file.path)) return;
		pendingHashlineReads.set(event.toolCallId, {
			...file,
			input: structuredClone(event.input),
			subject: readSubject(ctx.cwd, file.path),
		});
	});

	pi.on("tool_result", async (event, ctx) => {
		const existing = envelopeFromDetails(event.details);
		let adapted: FreshnessEnvelopeV1 | undefined;
		let readEvidenceIndex: number | undefined;

		if (event.toolName === "read") {
			const pending = pendingReads.get(event.toolCallId);
			const pendingHashline = pendingHashlineReads.get(event.toolCallId);
			pendingReads.delete(event.toolCallId);
			pendingHashlineReads.delete(event.toolCallId);
			if (!event.isError && (existing?.evidence?.length ?? 0) === 0) {
				if (pending) {
					const afterStamp = await hashFile(pending.path);
					const exact =
						afterStamp === pending.capturedStamp &&
						isDeepStrictEqual(event.input, pending.input) &&
						isDeepStrictEqual(event.content, pending.content);
					adapted = {
						version: 1,
						evidence: [
							{
								subject: pending.subject,
								dependencies: afterStamp
									? [{ resource: pending.resource, facet: "content", stamp: afterStamp }]
									: [],
								assurance: exact ? "exact" : "unverified",
							},
						],
					};
				} else if (pendingHashline) {
					adapted = await adaptHashlineRead(
						pendingHashline,
						event.toolCallId,
						event.input,
						event.content,
						event.details,
						ctx,
					);
				}
				if (adapted) readEvidenceIndex = existing?.evidence?.length ?? 0;
			}
		} else if (!event.isError && (event.toolName === "edit" || event.toolName === "write")) {
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
		const messages = event.messages.filter(
			(message) => message.role !== "custom" || message.customType !== SAFETY_MESSAGE_TYPE,
		);

		if (!projection.noticeText) {
			if (messages.length !== event.messages.length) return { messages };
			return;
		}

		const message = {
			role: "custom",
			customType: SAFETY_MESSAGE_TYPE,
			content: projection.noticeText,
			display: false,
			timestamp: Date.now(),
		} satisfies (typeof event.messages)[number];
		return { messages: [...messages, message] };
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
