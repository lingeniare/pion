import type { Usage } from "../types.ts";

export interface OpenRouterUsageAccounting {
	/** Amount charged to the user's OpenRouter account. */
	cost: number | null;
	/** Whether OpenRouter used the user's upstream provider key. */
	is_byok: boolean;
	cost_details: {
		/** Total inference cost billed through the user's upstream provider account, when available. */
		upstream_inference_cost: number | null;
		/** Upstream cost for prompt processing, including any provider-side cache pricing. */
		upstream_inference_prompt_cost: number;
		/** Upstream cost for completion generation. */
		upstream_inference_completions_cost: number;
		/** Metered server-tool cost already included in OpenRouter's charged `cost`. */
		server_tool_cost?: number | null;
	} | null;
}

function isValidCost(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Whether the request target is OpenRouter or an OpenRouter-compatible gateway.
 * VEGA (api.vega.chat) is a full OpenRouter proxy and speaks the same protocol:
 * billing fields, session affinity, reasoning and provider routing.
 */
export function isOpenRouterModel(model: { provider: string; baseUrl: string }): boolean {
	return (
		model.provider === "openrouter" ||
		model.provider === "vega" ||
		model.baseUrl.includes("openrouter.ai") ||
		model.baseUrl.includes("api.vega.chat")
	);
}

/** Replace the catalog total with OpenRouter's billed cost when the response contains complete, valid accounting. */
export function applyOpenRouterReportedCost(usage: Usage, reported: OpenRouterUsageAccounting): void {
	if (!isValidCost(reported.cost)) return;

	if (reported.is_byok === false) {
		usage.cost.total = reported.cost;
		usage.cost.totalFromProvider = true;
		return;
	}

	if (reported.is_byok === true) {
		const details = reported.cost_details;
		if (!details) return;
		let upstreamCost: unknown = details.upstream_inference_cost;
		if (upstreamCost === null) {
			if (
				!isValidCost(details.upstream_inference_prompt_cost) ||
				!isValidCost(details.upstream_inference_completions_cost)
			) {
				return;
			}
			upstreamCost = details.upstream_inference_prompt_cost + details.upstream_inference_completions_cost;
		}
		if (!isValidCost(upstreamCost)) return;
		usage.cost.total = reported.cost + upstreamCost;
		usage.cost.totalFromProvider = true;
	}
}

/** Fields pi reads from OpenRouter's `GET /generation` record. */
export interface OpenRouterGenerationMetadata {
	/** Final billed cost in credits; replaces the streamed cost when present. */
	totalCost?: number;
	/** Slug of the upstream provider that served the request. */
	providerName?: string;
	/** Upstream inference latency in milliseconds. */
	latencyMs?: number;
}

/**
 * Fetch the `GET /generation` record for a generation id reported on a stream
 * (`gen-*`). OpenRouter-compatible gateways expose it under the same base URL
 * (`{baseUrl}/generation?id=`). Best-effort: returns undefined when the record
 * is not ready yet or the request fails.
 */
export async function fetchOpenRouterGeneration(
	baseUrl: string,
	generationId: string,
	apiKey: string,
	fetchImpl: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<OpenRouterGenerationMetadata | undefined> {
	try {
		const response = await fetchImpl(`${baseUrl}/generation?id=${encodeURIComponent(generationId)}`, {
			headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
			signal,
		});
		if (!response.ok) return undefined;
		const body = (await response.json()) as { data?: unknown };
		const data = body && typeof body === "object" ? body.data : undefined;
		if (!data || typeof data !== "object") return undefined;
		const record = data as { total_cost?: unknown; provider_name?: unknown; latency?: unknown };
		return {
			totalCost: isValidCost(record.total_cost) ? record.total_cost : undefined,
			providerName: typeof record.provider_name === "string" ? record.provider_name : undefined,
			latencyMs: isValidCost(record.latency) ? record.latency : undefined,
		};
	} catch {
		return undefined;
	}
}
