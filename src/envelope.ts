export const FRESHNESS_DETAILS_KEY = "pi-workspace-ledger/freshness";

export type Assurance = "exact" | "conservative" | "unverified";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface Change {
	resource: string;
	facet: string;
	selector?: JsonValue;
}

export interface ResourceStamp extends Change {
	stamp: string;
}

export interface Evidence {
	subject: string;
	dependencies: ResourceStamp[];
	assurance: Assurance;
}

export interface FreshnessEnvelopeV1 {
	version: 1;
	changes?: Change[];
	evidence?: Evidence[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object") return false;
	if (ancestors.has(value)) return false;

	ancestors.add(value);
	const valid = Array.isArray(value)
		? value.every((item) => isJsonValue(item, ancestors))
		: Object.values(value).every((item) => isJsonValue(item, ancestors));
	ancestors.delete(value);
	return valid;
}


function isChange(value: unknown): value is Change {
	return (
		isRecord(value) &&
		typeof value.resource === "string" &&
		value.resource.length > 0 &&
		typeof value.facet === "string" &&
		value.facet.length > 0 &&
		(value.selector === undefined || isJsonValue(value.selector))
	);
}

function isResourceStamp(value: unknown): value is ResourceStamp {
	return isRecord(value) && isChange(value) && typeof value.stamp === "string" && value.stamp.length > 0;
}

function isEvidence(value: unknown): value is Evidence {
	return (
		isRecord(value) &&
		typeof value.subject === "string" &&
		value.subject.length > 0 &&
		Array.isArray(value.dependencies) &&
		value.dependencies.every(isResourceStamp) &&
		(value.assurance === "exact" || value.assurance === "conservative" || value.assurance === "unverified")
	);
}

export function parseFreshnessEnvelope(value: unknown): FreshnessEnvelopeV1 | undefined {
	if (!isRecord(value) || value.version !== 1) return undefined;
	if (value.changes !== undefined && (!Array.isArray(value.changes) || !value.changes.every(isChange))) {
		return undefined;
	}
	if (value.evidence !== undefined && (!Array.isArray(value.evidence) || !value.evidence.every(isEvidence))) {
		return undefined;
	}

	return value as unknown as FreshnessEnvelopeV1;
}

export function envelopeFromDetails(details: unknown): FreshnessEnvelopeV1 | undefined {
	if (!isRecord(details)) return undefined;
	return parseFreshnessEnvelope(details[FRESHNESS_DETAILS_KEY]);
}

export function mergeEnvelopes(
	left: FreshnessEnvelopeV1 | undefined,
	right: FreshnessEnvelopeV1 | undefined,
): FreshnessEnvelopeV1 | undefined {
	if (!left) return right;
	if (!right) return left;

	return {
		version: 1,
		changes: [...(left.changes ?? []), ...(right.changes ?? [])],
		evidence: [...(left.evidence ?? []), ...(right.evidence ?? [])],
	};
}
