import { afterEach, describe, expect, it, vi } from "vitest";
import type { RefreshModelsContext } from "../src/models.ts";
import { vegaProvider } from "../src/providers/vega.ts";
import type { ClassifierModel, ImageModel, Model } from "../src/types.ts";

const base = {
	context_length: 200_000,
	top_provider: { context_length: 200_000, max_completion_tokens: 64_000 },
	pricing: { prompt: "0.000001", completion: "0.000002" },
};

const chatListing = [
	{
		...base,
		id: "openai/gpt-4.1-mini",
		name: "GPT-4.1 mini",
		supported_parameters: ["tools", "reasoning"],
		architecture: { modality: "text->text", input_modalities: ["text"], output_modalities: ["text"] },
	},
	{
		...base,
		id: "anthropic/claude-sonnet-4",
		supported_parameters: ["tools"],
		architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
		reasoning: { supported_efforts: ["low", "medium", "high"], default_effort: "medium" },
	},
	// The gateway reports no tool support: filtered like the upstream OpenRouter catalog.
	{
		...base,
		id: "vendor/no-tools",
		supported_parameters: ["temperature"],
		architecture: { output_modalities: ["text"] },
	},
	// Keys may serve listings that predate supported_parameters: kept.
	{ ...base, id: "vendor/legacy", architecture: { output_modalities: ["text"] } },
];

const imageListing = [
	{
		...base,
		id: "google/gemini-2.5-flash-image",
		architecture: { input_modalities: ["text"], output_modalities: ["image"] },
	},
];

const decisionListing = [
	{
		...base,
		id: "typesafe/jev-1.14",
		architecture: { input_modalities: ["text"], output_modalities: ["decisions"] },
	},
];

function stubListings(): void {
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = String(input);
		if (url.includes("output_modalities=image")) return Response.json({ data: imageListing });
		if (url.includes("output_modalities=decisions")) return Response.json({ data: decisionListing });
		return Response.json({ data: chatListing });
	});
}

function refreshContext(): RefreshModelsContext {
	return {
		credential: { type: "api_key", key: "sk-apivega-test" },
		publish: async (publication) => {
			publication.update?.();
			return true;
		},
		allowNetwork: true,
		signal: new AbortController().signal,
		baseUrl: "https://api.vega.chat/api/v1",
	};
}

afterEach(() => vi.restoreAllMocks());

describe("vega catalog refresh", () => {
	it("builds chat, image, and classifier models from the three listings", async () => {
		stubListings();
		const provider = vegaProvider();
		await provider.refreshModels?.(refreshContext());
		const models = provider.getAllModels?.() ?? [];
		expect(models.map((model) => model.id)).toEqual([
			"openai/gpt-4.1-mini",
			"anthropic/claude-sonnet-4",
			"vendor/legacy",
			"google/gemini-2.5-flash-image",
			"typesafe/jev-1.14",
		]);
	});

	it("routes anthropic models through the Anthropic Messages endpoint", async () => {
		stubListings();
		const provider = vegaProvider();
		await provider.refreshModels?.(refreshContext());
		const claude = (provider.getAllModels?.() ?? []).find(
			(model): model is Model<"anthropic-messages"> => model.id === "anthropic/claude-sonnet-4",
		);
		expect(claude?.api).toBe("anthropic-messages");
		expect(claude?.baseUrl).toBe("https://api.vega.chat/api");
		expect(claude?.input).toEqual(["text", "image"]);
		// The gateway speaks OpenRouter's reasoning metadata; the effort list becomes the thinking map.
		expect(claude?.thinkingLevelMap).toEqual({
			off: "none",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		});
	});

	it("keeps OpenRouter semantics on chat completions models", async () => {
		stubListings();
		const provider = vegaProvider();
		await provider.refreshModels?.(refreshContext());
		const gpt = (provider.getAllModels?.() ?? []).find(
			(model): model is Model<"openai-completions"> => model.id === "openai/gpt-4.1-mini",
		);
		expect(gpt?.api).toBe("openai-completions");
		expect(gpt?.baseUrl).toBe("https://api.vega.chat/api/v1");
		expect(gpt?.reasoning).toBe(true);
		expect(gpt?.compat?.thinkingFormat).toBe("openrouter");
		expect(gpt?.compat?.sessionAffinityFormat).toBe("openrouter");
	});

	it("lists image and classifier models from their listings", async () => {
		stubListings();
		const provider = vegaProvider();
		await provider.refreshModels?.(refreshContext());
		const image = (provider.getAllModels?.() ?? []).find(
			(model): model is ImageModel<"openrouter-images"> => model.id === "google/gemini-2.5-flash-image",
		);
		expect(image?.type).toBe("image");
		expect(image?.api).toBe("openrouter-images");
		const classifier = (provider.getAllModels?.() ?? []).find(
			(model): model is ClassifierModel<"typesafe-system-one"> => model.id === "typesafe/jev-1.14",
		);
		expect(classifier?.type).toBe("classifier");
		expect(classifier?.api).toBe("typesafe-system-one");
	});

	it("still lists chat models when the extra listings fail", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes("output_modalities=")) return new Response("", { status: 404 });
			return Response.json({ data: chatListing });
		});
		const provider = vegaProvider();
		await provider.refreshModels?.(refreshContext());
		expect((provider.getAllModels?.() ?? []).map((model) => model.id)).toEqual([
			"openai/gpt-4.1-mini",
			"anthropic/claude-sonnet-4",
			"vendor/legacy",
		]);
	});
});
