/**
 * Hybrid ranking for `tool_search`: reciprocal-rank fusion of BM25 with embeddings from the
 * OpenRouter-compatible `/embeddings` endpoint on the VEGA or OpenRouter credential. Semantic
 * matches surface tools whose descriptions do not share words with the query.
 *
 * Disabled with `PION_TOOL_SEARCH_EMBEDDINGS=off`. The embedding model is
 * `PION_TOOL_SEARCH_EMBEDDING_MODEL` (default `openai/text-embedding-3-small`). Any failure
 * falls back to plain BM25, so a missing or broken embeddings endpoint only loses the
 * semantic half.
 */

import type { ExtensionToolContext } from "../../core/extensions/types.ts";
import { Bm25Ranker, isExactNameQuery, type ToolSearchDocument, type ToolSearchMatch } from "./tool.ts";

const EMBEDDING_PROVIDERS = [
	{ provider: "vega", baseUrl: "https://api.vega.chat/api/v1" },
	{ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
] as const;
const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";
const EMBEDDING_TIMEOUT_MS = 15_000;
const EMBEDDING_BATCH_SIZE = 128;
const EMBEDDING_DOC_MAX_CHARS = 2_000;
const EMBEDDING_CACHE_MAX = 4_096;
const RERANK_TIMEOUT_MS = 15_000;
/** How many fused candidates the rerank endpoint reorders; its cost is per document. */
const RERANK_CANDIDATES = 20;
/** Reciprocal rank fusion constant: a top-1 result contributes ~1/61 of a rank point. */
const RRF_K = 60;

interface EmbeddingProvider {
	baseUrl: string;
	apiKey: string;
}

interface EmbeddingResponse {
	data?: Array<{ embedding?: number[] }>;
}

interface RerankResponse {
	results?: Array<{ index?: number; relevance_score?: number }>;
}

/** POST /rerank reorders documents for the query; indexes refer to the documents array. */
async function rerankDocuments(
	provider: EmbeddingProvider,
	model: string,
	query: string,
	documents: readonly string[],
): Promise<number[]> {
	const response = await fetch(`${provider.baseUrl}/rerank`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` },
		body: JSON.stringify({ model, query, documents: [...documents] }),
		signal: AbortSignal.timeout(RERANK_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`Rerank request failed: HTTP ${response.status}`);
	const body = (await response.json()) as RerankResponse;
	const results = body.results ?? [];
	const order = new Array<number>(documents.length).fill(Number.MAX_SAFE_INTEGER);
	for (const [position, result] of results.entries()) {
		if (typeof result.index === "number" && result.index >= 0 && result.index < documents.length) {
			order[result.index] = position;
		}
	}
	return order;
}

/** Document vectors are cached across queries; the tool catalog changes rarely within a session. */
const vectorCache = new Map<string, number[]>();

function docText(document: ToolSearchDocument): string {
	return `${document.name} ${document.text}`.slice(0, EMBEDDING_DOC_MAX_CHARS);
}

function cacheKey(text: string): string {
	return text;
}

function cosine(a: readonly number[], b: readonly number[]): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	return normA > 0 && normB > 0 ? dot / Math.sqrt(normA * normB) : 0;
}

async function embedBatch(provider: EmbeddingProvider, model: string, texts: string[]): Promise<number[][]> {
	const vectors: number[][] = [];
	for (let offset = 0; offset < texts.length; offset += EMBEDDING_BATCH_SIZE) {
		const batch = texts.slice(offset, offset + EMBEDDING_BATCH_SIZE);
		const response = await fetch(`${provider.baseUrl}/embeddings`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` },
			body: JSON.stringify({ model, input: batch }),
			signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
		});
		if (!response.ok) throw new Error(`Embeddings request failed: HTTP ${response.status}`);
		const body = (await response.json()) as EmbeddingResponse;
		const batchVectors = body.data?.map((entry) => entry.embedding ?? []);
		if (!batchVectors || batchVectors.length !== batch.length || batchVectors.some((v) => v.length === 0)) {
			throw new Error("Embeddings response is missing vectors");
		}
		vectors.push(...batchVectors);
	}
	return vectors;
}

async function resolveEmbeddingProvider(ctx: ExtensionToolContext): Promise<EmbeddingProvider | undefined> {
	for (const { provider, baseUrl } of EMBEDDING_PROVIDERS) {
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(provider);
		if (apiKey) return { baseUrl, apiKey };
	}
	return undefined;
}

/**
 * Fuse BM25 ranks with embedding-similarity ranks (reciprocal rank fusion, k=60). Exact
 * tool-name queries keep the BM25 behavior and return that tool first without embedding calls.
 */
async function hybridRank(
	query: string,
	documents: readonly ToolSearchDocument[],
	limit: number,
	provider: EmbeddingProvider,
	model: string,
): Promise<ToolSearchMatch[]> {
	const bm25 = new Bm25Ranker().rank(query, documents, documents.length);
	const exact = bm25.find((match) => isExactNameQuery(query, match.name));
	if (exact) return bm25.slice(0, limit);

	const texts = documents.map(docText);
	const missing = new Map<number, string>();
	const vectors: (number[] | undefined)[] = texts.map((text, index) => {
		const cached = vectorCache.get(cacheKey(text));
		if (!cached) missing.set(index, text);
		return cached;
	});
	const pendingIndexes = [...missing.keys()];
	if (pendingIndexes.length > 0) {
		const fresh = await embedBatch(provider, model, [query, ...pendingIndexes.map((i) => missing.get(i) ?? "")]);
		const queryVector = fresh[0];
		pendingIndexes.forEach((docIndex, i) => {
			const vector = fresh[i + 1];
			if (vectorCache.size >= EMBEDDING_CACHE_MAX) vectorCache.clear();
			vectorCache.set(cacheKey(texts[docIndex]), vector);
			vectors[docIndex] = vector;
		});
		return fuse(queryVector);
	}
	const queryVector = (await embedBatch(provider, model, [query]))[0];
	return fuse(queryVector);

	function fuse(qv: number[]): ToolSearchMatch[] {
		const similarities = documents.map((document, index) => ({
			name: document.name,
			similarity: vectors[index] ? cosine(qv, vectors[index] as number[]) : 0,
		}));
		const embeddingRank = new Map(
			[...similarities]
				.sort((a, b) => b.similarity - a.similarity)
				.map((entry, rank) => [entry.name, rank] as const),
		);
		const bm25Rank = new Map(bm25.map((match, rank) => [match.name, rank] as const));
		return documents
			.map((document) => ({
				name: document.name,
				score:
					1 / (RRF_K + (bm25Rank.get(document.name) ?? documents.length)) +
					1 / (RRF_K + (embeddingRank.get(document.name) ?? documents.length)),
			}))
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);
	}
}

/**
 * Rank documents for `tool_search`. Hybrid when a credential resolves and embeddings are not
 * disabled; otherwise plain BM25. Any embedding error falls back to BM25.
 */
export async function rankToolSearch(
	ctx: ExtensionToolContext,
	query: string,
	documents: readonly ToolSearchDocument[],
	limit: number,
): Promise<ToolSearchMatch[]> {
	const bm25Only = (): ToolSearchMatch[] => new Bm25Ranker().rank(query, documents, limit);
	if (process.env.PION_TOOL_SEARCH_EMBEDDINGS === "off" || documents.length === 0) return bm25Only();
	try {
		const provider = await resolveEmbeddingProvider(ctx);
		if (!provider) return bm25Only();
		const fused = await hybridRank(
			query,
			documents,
			limit,
			provider,
			process.env.PION_TOOL_SEARCH_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
		);
		// Optional rerank pass (PION_TOOL_SEARCH_RERANK_MODEL): the /rerank endpoint
		// reorders the fused candidates, and its order is fused with theirs.
		const rerankModel = process.env.PION_TOOL_SEARCH_RERANK_MODEL;
		if (!rerankModel || fused.length <= 1) return fused;
		const candidates = fused.slice(0, RERANK_CANDIDATES);
		const textByName = new Map(documents.map((document) => [document.name, docText(document)]));
		const order = await rerankDocuments(
			provider,
			rerankModel,
			query,
			candidates.map((match) => textByName.get(match.name) ?? match.name),
		);
		return candidates
			.map((match, fusedRank) => ({
				name: match.name,
				score: 1 / (RRF_K + fusedRank) + 1 / (RRF_K + order[fusedRank]),
			}))
			.sort((a, b) => b.score - a.score);
	} catch {
		return bm25Only();
	}
}
