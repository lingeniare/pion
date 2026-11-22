import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { rankToolSearch } from "../src/extensions/tool-search/embeddings.ts";
import { createToolSearchDocument } from "../src/extensions/tool-search/tool.ts";

function doc(name: string, description: string) {
	return createToolSearchDocument({ name, description, parameters: Type.Unsafe({ type: "object" }) });
}

function ctxWithKeys(keys: Record<string, string>): ExtensionToolContext {
	return {
		modelRegistry: { getApiKeyForProvider: async (provider: string) => keys[provider] },
	} as unknown as ExtensionToolContext;
}

const documents = [
	doc("mcp__loyalty__award_chart", "Award chart and mileage redemption rules."),
	doc("mcp__git__status", "Show the working tree status."),
];

/** Vectors keyed by content: the query and the loyalty tool point one way, the git tool the other. */
function embeddingResponse(input: string[]): Response {
	return Response.json({
		data: input.map((text) => ({
			embedding: text.includes("loyalty") || text.includes("frequent flyer") ? [0.95, 0.05] : [0.01, 0.99],
		})),
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("rankToolSearch", () => {
	it("falls back to BM25 when embeddings are disabled or there is no credential", async () => {
		vi.stubEnv("PION_TOOL_SEARCH_EMBEDDINGS", "off");
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const ctx = ctxWithKeys({ vega: "sk-apivega-test" });
		const matches = await rankToolSearch(ctx, "status", documents, 8);
		expect(matches.map((match) => match.name)).toEqual(["mcp__git__status"]);
		expect(fetchSpy).not.toHaveBeenCalled();

		vi.unstubAllEnvs();
		const noKey = await rankToolSearch(ctxWithKeys({}), "status", documents, 8);
		expect(noKey.map((match) => match.name)).toEqual(["mcp__git__status"]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("embeds query and documents on the VEGA credential and fuses ranks", async () => {
		let captured: { url: string; init?: RequestInit } | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				captured = { url, init };
				return embeddingResponse(JSON.parse(String(init?.body)).input);
			}),
		);
		const ctx = ctxWithKeys({ vega: "sk-apivega-test", openrouter: "sk-or-test" });
		// "frequent flyer miles" shares no term with either description, so BM25 alone finds nothing.
		const matches = await rankToolSearch(ctx, "frequent flyer miles", documents, 8);

		expect(captured?.url).toBe("https://api.vega.chat/api/v1/embeddings");
		const body = JSON.parse(String(captured?.init?.body));
		expect(body.model).toBe("openai/text-embedding-3-small");
		expect(body.input[0]).toBe("frequent flyer miles");
		expect(new Headers(captured?.init?.headers).get("authorization")).toBe("Bearer sk-apivega-test");
		expect(matches.map((match) => match.name)).toEqual(["mcp__loyalty__award_chart", "mcp__git__status"]);
	});

	it("reorders fused candidates with the rerank endpoint when configured", async () => {
		vi.stubEnv("PION_TOOL_SEARCH_RERANK_MODEL", "cohere/rerank-3.5");
		const urls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				urls.push(url);
				if (url.includes("/rerank")) {
					return Response.json({ results: [{ index: 0, relevance_score: 1 }] });
				}
				return embeddingResponse(JSON.parse(String(init?.body)).input);
			}),
		);
		const ctx = ctxWithKeys({ vega: "sk-apivega-test" });
		const matches = await rankToolSearch(ctx, "frequent flyer miles", documents, 8);
		expect(urls.some((url) => url === "https://api.vega.chat/api/v1/rerank")).toBe(true);
		expect(matches[0].name).toBe("mcp__loyalty__award_chart");
	});

	it("falls back to BM25 when the embeddings request fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("", { status: 500 })),
		);
		const ctx = ctxWithKeys({ vega: "sk-apivega-test" });
		const matches = await rankToolSearch(ctx, "status", documents, 8);
		expect(matches.map((match) => match.name)).toEqual(["mcp__git__status"]);
	});
});
