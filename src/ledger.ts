import type { Assurance, Change, Evidence, FreshnessEnvelopeV1, JsonValue, ResourceStamp } from "./envelope.js";

export type EvidenceStatus = "current" | "current-conservative" | "stale" | "unverified" | "superseded";

export interface EvidenceView extends Evidence {
	id: string;
	entryId: string;
	status: EvidenceStatus;
	reasons: string[];
}

export type LedgerEvent =
	| {
			kind: "envelope";
			entryId: string;
			envelope: FreshnessEnvelopeV1;
			retiredEvidenceIndexes?: readonly number[];
		}
	| {
			kind: "resolved";
			resource: string;
			facet: string;
			selector?: JsonValue;
			stamp: string | null;
			missing?: boolean;
		};

interface ResourceState extends ResourceStamp {
	changed: boolean;
	known: boolean;
}

function selectorKey(selector: JsonValue | undefined): string {
	return selector === undefined ? "" : JSON.stringify(selector);
}

function resourceKey(resource: string, facet: string, selector: JsonValue | undefined): string {
	return `${resource}\u0000${facet}\u0000${selectorKey(selector)}`;
}

function sameResourceFacet(left: Change, right: Change): boolean {
	return left.resource === right.resource && left.facet === right.facet;
}

function currentStatus(assurance: Assurance): EvidenceStatus {
	return assurance === "conservative" ? "current-conservative" : "current";
}

export class LedgerState {
	readonly #records = new Map<string, EvidenceView>();
	readonly #activeBySubject = new Map<string, string>();
	readonly #resources = new Map<string, ResourceState>();
	readonly #appliedEntries = new Set<string>();

	apply(event: LedgerEvent): void {
		if (event.kind === "resolved") {
			this.applyResolution(event);
			return;
		}

		if (this.#appliedEntries.has(event.entryId)) return;
		this.#appliedEntries.add(event.entryId);

		for (const change of event.envelope.changes ?? []) this.applyChange(change);
		const retired = new Set(event.retiredEvidenceIndexes);
		for (const [index, evidence] of (event.envelope.evidence ?? []).entries()) {
			if (retired.has(index)) this.retireEvidence(event.entryId, evidence);
			else this.addEvidence(event.entryId, index, evidence);
		}
		this.recompute();
	}

	project(options: { includeSuperseded?: boolean } = {}): EvidenceView[] {
		return [...this.#records.values()]
			.filter((record) => options.includeSuperseded || record.status !== "superseded")
			.map((record) => ({
				...record,
				dependencies: record.dependencies.map((dependency) => ({ ...dependency })),
				reasons: [...record.reasons],
			}));
	}

	private supersedeActive(subject: string, entryId: string): void {
		const previousId = this.#activeBySubject.get(subject);
		const previous = previousId ? this.#records.get(previousId) : undefined;
		if (previous) {
			previous.status = "superseded";
			previous.reasons = [`superseded by ${entryId}`];
		}
	}

	private retireEvidence(entryId: string, evidence: Evidence): void {
		this.supersedeActive(evidence.subject, entryId);
		this.#activeBySubject.delete(evidence.subject);
	}

	private addEvidence(entryId: string, index: number, evidence: Evidence): void {
		this.supersedeActive(evidence.subject, entryId);

		for (const dependency of evidence.dependencies) {
			this.#resources.set(resourceKey(dependency.resource, dependency.facet, dependency.selector), {
				...dependency,
				changed: false,
				known: true,
			});
		}

		const id = `${entryId}:${index}`;
		this.#records.set(id, {
			...evidence,
			dependencies: evidence.dependencies.map((dependency) => ({ ...dependency })),
			id,
			entryId,
			status: evidence.assurance === "unverified" ? "unverified" : currentStatus(evidence.assurance),
			reasons: [],
		});
		this.#activeBySubject.set(evidence.subject, id);
	}

	private applyChange(change: Change): void {
		// selector overlap 尚未标准化；同一 resource/facet 全部失效以避免 false-current。
		for (const state of this.#resources.values()) {
			if (sameResourceFacet(change, state)) state.changed = true;
		}
	}

	private applyResolution(event: Extract<LedgerEvent, { kind: "resolved" }>): void {
		const key = resourceKey(event.resource, event.facet, event.selector);
		const state = this.#resources.get(key);
		if (state) {
			if (event.stamp !== null) {
				state.changed = false;
				state.known = true;
				state.stamp = event.stamp;
			} else {
				// 无法解析不能推翻已经观察到的 change；missing 则进一步证明 stale。
				if (event.missing === true) state.changed = true;
				state.known = false;
				state.stamp = "";
			}
		} else {
			this.#resources.set(key, {
				resource: event.resource,
				facet: event.facet,
				...(event.selector === undefined ? {} : { selector: event.selector }),
				stamp: event.stamp ?? "",
				changed: event.stamp === null && event.missing === true,
				known: event.stamp !== null,
			});
		}
		this.recompute();
	}

	private recompute(): void {
		for (const record of this.#records.values()) {
			if (record.status === "superseded") continue;
			if (record.dependencies.length === 0) {
				record.status = "unverified";
				record.reasons = ["producer did not declare complete dependencies"];
				continue;
			}

			const staleReasons: string[] = [];
			const unknownReasons: string[] = [];
			for (const dependency of record.dependencies) {
				const state = this.#resources.get(resourceKey(dependency.resource, dependency.facet, dependency.selector));
				if (state?.changed) {
					staleReasons.push(`${dependency.resource} changed or disappeared`);
				} else if (!state || !state.known) {
					unknownReasons.push(`${dependency.resource} cannot be resolved`);
				} else if (state.stamp !== dependency.stamp) {
					staleReasons.push(`${dependency.resource} has a different ${dependency.facet} stamp`);
				}
			}

			if (staleReasons.length > 0) {
				record.status = "stale";
				record.reasons = staleReasons;
			} else if (record.assurance === "unverified") {
				record.status = "unverified";
				record.reasons = ["producer did not declare complete dependencies", ...unknownReasons];
			} else if (unknownReasons.length > 0) {
				record.status = "unverified";
				record.reasons = unknownReasons;
			} else {
				record.status = currentStatus(record.assurance);
				record.reasons = [];
			}
		}
	}
}
