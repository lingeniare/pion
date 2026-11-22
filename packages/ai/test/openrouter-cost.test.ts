import { afterEach, describe, expect, it, vi } from "vitest";
import type { Usage } from "../src/types.ts";
import {
	applyOpenRouterReportedCost,
	fetchOpenRouterGeneration,
	isOpenRouterModel,
} from "../src/utils/openrouter-cost.ts";

function usage(total = 1): Usage {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0.25, output: 0.75, cacheRead: 0, cacheWrite: 0, total },
	};
}

describe("isOpenRouterModel", () => {
	it("recognizes both the built-in provider and custom providers using OpenRouter's endpoint", () => {
		expect(isOpenRouterModel({ provider: "openrouter", baseUrl: "https://example.com" })).toBe(true);
		expect(isOpenRouterModel({ provider: "openrouter-work", baseUrl: "https://openrouter.ai/api/v1" })).toBe(true);
		expect(isOpenRouterModel({ provider: "custom", baseUrl: "https://example.com/v1" })).toBe(false);
	});

	it("recognizes VEGA as an OpenRouter-compatible gateway", () => {
		expect(isOpenRouterModel({ provider: "vega", baseUrl: "https://api.vega.chat/api/v1" })).toBe(true);
		expect(isOpenRouterModel({ provider: "custom", baseUrl: "https://api.vega.chat/api/v1" })).toBe(true);
	});
});

describe("applyOpenRouterReportedCost", () => {
	it("uses OpenRouter's reported cost for non-BYOK requests", () => {
		const value = usage();
		applyOpenRouterReportedCost(value, {
			cost: 0,
			is_byok: false,
			cost_details: {
				upstream_inference_cost: 0,
				upstream_inference_prompt_cost: 0,
				upstream_inference_completions_cost: 0,
			},
		});
		expect(value.cost.total).toBe(0);
		expect(value.cost.totalFromProvider).toBe(true);
	});

	it("adds the upstream inference cost for BYOK requests", () => {
		const value = usage();
		applyOpenRouterReportedCost(value, {
			cost: 0.1,
			is_byok: true,
			cost_details: {
				upstream_inference_cost: 0.9,
				upstream_inference_prompt_cost: 0.6,
				upstream_inference_completions_cost: 0.3,
			},
		});
		expect(value.cost.total).toBe(1);
		expect(value.cost.totalFromProvider).toBe(true);
	});

	it("uses upstream cost components when OpenRouter omits their total", () => {
		const value = usage();
		applyOpenRouterReportedCost(value, {
			cost: 0.1,
			is_byok: true,
			cost_details: {
				upstream_inference_cost: null,
				upstream_inference_prompt_cost: 0.6,
				upstream_inference_completions_cost: 0.3,
			},
		});
		expect(value.cost.total).toBeCloseTo(1);
		expect(value.cost.totalFromProvider).toBe(true);
	});

	it("keeps the catalog total when OpenRouter's accounting is incomplete", () => {
		const value = usage();
		value.cost.totalFromProvider = false;
		applyOpenRouterReportedCost(value, { cost: null, is_byok: false, cost_details: null });
		applyOpenRouterReportedCost(value, { cost: 0.1, is_byok: true, cost_details: null });
		expect(value.cost.total).toBe(1);
		expect(value.cost.totalFromProvider).toBe(false);
	});
});

describe("fetchOpenRouterGeneration", () => {
	afterEach(() => vi.restoreAllMocks());

	it("returns the billed cost, provider, and latency of a generation", async () => {
		const fetchImpl = vi.fn(async () =>
			Response.json({ data: { total_cost: 0.0042, provider_name: "deepinfra", latency: 812 } }),
		);
		const metadata = await fetchOpenRouterGeneration(
			"https://api.vega.chat/api/v1",
			"gen-abc",
			"sk-apivega-test",
			fetchImpl,
		);
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://api.vega.chat/api/v1/generation?id=gen-abc",
			expect.objectContaining({
				headers: { accept: "application/json", authorization: "Bearer sk-apivega-test" },
			}),
		);
		expect(metadata).toEqual({ totalCost: 0.0042, providerName: "deepinfra", latencyMs: 812 });
	});

	it.each([404, 500])("returns undefined when the record is not available (%i)", async (status) => {
		const fetchImpl = vi.fn(async () => new Response("", { status }));
		expect(await fetchOpenRouterGeneration("https://x/v1", "gen-1", "k", fetchImpl)).toBeUndefined();
	});

	it("returns undefined for a malformed record or a failed request", async () => {
		const malformed = vi.fn(async () => Response.json({ data: null }));
		expect(await fetchOpenRouterGeneration("https://x/v1", "gen-1", "k", malformed)).toBeUndefined();
		const failing = vi.fn(async () => {
			throw new Error("network down");
		});
		expect(await fetchOpenRouterGeneration("https://x/v1", "gen-1", "k", failing)).toBeUndefined();
	});
});
