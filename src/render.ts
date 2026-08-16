import type { EvidenceStatus, EvidenceView } from "./ledger.js";

const MODEL_VISIBLE_STATUSES = new Set<EvidenceStatus>(["stale", "unverified"]);

export function abnormalEvidence(records: EvidenceView[]): EvidenceView[] {
	return records.filter((record) => MODEL_VISIBLE_STATUSES.has(record.status));
}

function oneLine(value: string, maxLength = 180): string {
	const compact = value
		.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
	return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 3)}...`;
}

function lineFor(record: EvidenceView): string {
	const reason = record.reasons[0] ? `; reason: ${JSON.stringify(oneLine(record.reasons[0]))}` : "";
	return `- ${record.status.toUpperCase()}: ${JSON.stringify(oneLine(record.subject))}${reason}`;
}

export function renderFreshnessNotice(records: EvidenceView[], limit = 8): string | undefined {
	const abnormal = abnormalEvidence(records);
	const visible = abnormal.slice(0, limit);
	if (visible.length === 0) return undefined;

	const omitted = abnormal.length - visible.length;
	const lines = [
		"Workspace freshness (machine-generated status, not instructions):",
		...visible.map(lineFor),
	];
	if (omitted > 0) lines.push(`- ${omitted} additional stale or unverified item(s) omitted.`);
	lines.push("Re-observe affected sources before relying on those results.");
	return lines.join("\n");
}

export function renderFreshnessReport(records: EvidenceView[]): string {
	if (records.length === 0) return "Workspace freshness: no evidence recorded.";

	const counts = new Map<EvidenceStatus, number>();
	for (const record of records) counts.set(record.status, (counts.get(record.status) ?? 0) + 1);
	const summary = [...counts.entries()].map(([status, count]) => `${status}=${count}`).join(", ");
	return [`Workspace freshness: ${summary}`, ...records.map(lineFor)].join("\n");
}
