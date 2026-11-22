import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openrouterImagesApi } from "../api/openrouter-images.lazy.ts";
import { typesafeSystemOneApi } from "../api/typesafe-system-one.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadVegaOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import type { ClassifierModel, ImageModel, Model } from "../types.ts";
import {
	getOpenRouterThinkingLevelMap,
	type OpenRouterModel,
	type OpenRouterReasoningMetadata,
	openRouterCost,
} from "./openrouter-api.ts";

const VEGA_BASE_URL = "https://api.vega.chat/api/v1";
const VEGA_MODELS_TIMEOUT_MS = 15_000;

/** VEGA is an OpenRouter-compatible gateway, so `/models` uses the OpenRouter shape. */
type VegaModelListItem = OpenRouterModel & {
	name?: string;
	supported_parameters?: string[];
	architecture?: { modality?: string; input_modalities?: string[]; output_modalities?: string[] };
	reasoning?: OpenRouterReasoningMetadata;
};

type VegaChatModel = Model<"openai-completions"> | Model<"anthropic-messages">;
type VegaCatalogModel = VegaChatModel | ImageModel<"openrouter-images"> | ClassifierModel<"typesafe-system-one">;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Keep only text-output chat models: VEGA app keys already restrict the listing
 * to `output_modalities=text`, and the same rule is applied client-side so plain
 * dashboard keys also surface text models only.
 */
function isVegaTextModel(model: VegaModelListItem): boolean {
	const output = model.architecture?.output_modalities;
	if (Array.isArray(output) && output.length > 0) return output.every((entry) => entry === "text");
	const modality = model.architecture?.modality;
	if (typeof modality === "string" && modality.includes("->")) return modality.endsWith("->text");
	return true;
}

/**
 * Tool calling is required for a coding agent: when the listing reports
 * `supported_parameters`, entries without "tools" are skipped like the upstream
 * OpenRouter catalog does. A missing field keeps the model — VEGA keys may serve a
 * whitelist that predates the parameter.
 */
function isVegaToolModel(model: VegaModelListItem): boolean {
	const params = model.supported_parameters;
	return !Array.isArray(params) || params.includes("tools");
}

function modalities(values: string[] | undefined): ("text" | "image")[] {
	return Array.from(
		new Set((values ?? []).filter((value): value is "text" | "image" => value === "text" || value === "image")),
	);
}

function vegaModelInput(architecture: VegaModelListItem["architecture"]): ("text" | "image")[] {
	const input = new Set(modalities(architecture?.input_modalities));
	if (input.size === 0) {
		input.add("text");
		if (architecture?.modality?.split("->")[0]?.includes("image")) input.add("image");
	}
	return [...input];
}

/** `anthropic/` ids go through VEGA's Anthropic Messages endpoint, like OpenRouter's. */
function isVegaAnthropicModel(model: VegaModelListItem): boolean {
	return /^~?anthropic\//.test(model.id) && !model.id.endsWith(":batch");
}

function vegaSharedFields(model: VegaModelListItem) {
	const thinkingLevelMap = getOpenRouterThinkingLevelMap(model.reasoning);
	return {
		id: model.id,
		name: model.name ?? model.id,
		provider: "vega",
		reasoning: model.supported_parameters?.includes("reasoning") ?? false,
		input: vegaModelInput(model.architecture),
		cost: openRouterCost(model.pricing),
		contextWindow: model.top_provider?.context_length || model.context_length || 4096,
		maxTokens: model.top_provider?.max_completion_tokens || 4096,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
	};
}

function toVegaCompletionsModel(model: VegaModelListItem, baseUrl: string): Model<"openai-completions"> {
	return {
		type: "chat",
		...vegaSharedFields(model),
		api: "openai-completions",
		baseUrl,
		compat: {
			thinkingFormat: "openrouter",
			sendSessionAffinityHeaders: true,
			sessionAffinityFormat: "openrouter",
			supportsDeveloperRole: model.id.startsWith("anthropic/") || model.id.startsWith("openai/"),
		},
	};
}

/**
 * The Anthropic SDK appends `/v1/messages` to the base URL, so the Anthropic
 * endpoint of an OpenRouter-compatible gateway is its base without the `/v1`
 * (`https://api.vega.chat/api` for the default endpoint).
 */
function vegaAnthropicBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/v1\/?$/, "") || baseUrl;
}

function toVegaAnthropicModel(model: VegaModelListItem, baseUrl: string): Model<"anthropic-messages"> {
	return {
		type: "chat",
		...vegaSharedFields(model),
		api: "anthropic-messages",
		baseUrl: vegaAnthropicBaseUrl(baseUrl),
		compat: {
			sendSessionAffinityHeaders: true,
			sessionAffinityFormat: "openrouter",
		},
	};
}

function toVegaImageModel(model: VegaModelListItem, baseUrl: string): ImageModel<"openrouter-images"> {
	const input = modalities(model.architecture?.input_modalities);
	return {
		type: "image",
		id: model.id,
		name: model.name ?? model.id,
		api: "openrouter-images",
		provider: "vega",
		baseUrl,
		input: input.length > 0 ? input : ["text"],
		output: modalities(model.architecture?.output_modalities),
		cost: openRouterCost(model.pricing),
	};
}

function toVegaClassifierModel(model: VegaModelListItem, baseUrl: string): ClassifierModel<"typesafe-system-one"> {
	return {
		type: "classifier",
		id: model.id,
		name: model.name ?? model.id,
		api: "typesafe-system-one",
		provider: "vega",
		baseUrl,
		input: modalities(model.architecture?.input_modalities),
		cost: openRouterCost(model.pricing),
		contextWindow: model.top_provider?.context_length || model.context_length || 4096,
		// OpenRouter-compatible gateways answer TypeSafe `assets` with 200 but drop the images.
		compat: { imageInput: "state-image-urls", sendImageOptInHeader: false },
	};
}

async function fetchVegaModelList(
	baseUrl: string,
	key: string,
	signal: AbortSignal,
	query: string,
): Promise<unknown[]> {
	const response = await fetch(`${baseUrl}/models${query}`, {
		headers: { accept: "application/json", authorization: `Bearer ${key}` },
		signal,
	});
	if (!response.ok) throw new Error(`VEGA model list request failed: ${response.status}`);
	const body = asRecord(await response.json());
	if (!Array.isArray(body?.data)) throw new Error("Invalid VEGA model list response");
	return body.data;
}

/**
 * Fetch the key's model listings from `GET /models`. VEGA restricts the response
 * to the whitelist of the key's app (PIVEGA_ALLOWED_MODELS, empty = every text
 * model), so the returned catalog is already account-scoped. The default listing
 * omits image-only and decision models, which the `output_modalities=image` and
 * `output_modalities=decisions` listings add like OpenRouter; their failure
 * leaves the chat catalog intact.
 */
async function fetchVegaModels(context: RefreshModelsContext): Promise<readonly VegaCatalogModel[]> {
	const key = context.credential?.type === "oauth" ? context.credential.access : context.credential?.key;
	if (!key) throw new Error("VEGA model list requires a credential");
	const baseUrl = (context.baseUrl ?? VEGA_BASE_URL).replace(/\/+$/, "");
	const signal = AbortSignal.any([context.signal, AbortSignal.timeout(VEGA_MODELS_TIMEOUT_MS)]);

	const listed = await fetchVegaModelList(baseUrl, key, signal, "");
	const imageListed = await fetchVegaModelList(baseUrl, key, signal, "?output_modalities=image").catch(() => []);
	const decisionListed = await fetchVegaModelList(baseUrl, key, signal, "?output_modalities=decisions").catch(
		() => [],
	);

	const images: ImageModel<"openrouter-images">[] = [];
	for (const entry of imageListed) {
		const item = entry as VegaModelListItem;
		if (typeof item.id !== "string" || images.some((existing) => existing.id === item.id)) continue;
		const output = modalities(item.architecture?.output_modalities);
		if (!output.includes("image")) continue;
		images.push(toVegaImageModel(item, baseUrl));
	}

	const classifiers: ClassifierModel<"typesafe-system-one">[] = [];
	for (const entry of decisionListed) {
		const item = entry as VegaModelListItem;
		if (typeof item.id !== "string" || classifiers.some((existing) => existing.id === item.id)) continue;
		if (!item.architecture?.output_modalities?.includes("decisions")) continue;
		classifiers.push(toVegaClassifierModel(item, baseUrl));
	}

	const chat = listed.flatMap((entry: unknown): VegaChatModel[] => {
		const item = entry as VegaModelListItem;
		if (typeof item.id !== "string" || !isVegaTextModel(item) || !isVegaToolModel(item)) return [];
		return [isVegaAnthropicModel(item) ? toVegaAnthropicModel(item, baseUrl) : toVegaCompletionsModel(item, baseUrl)];
	});
	return [...chat, ...images, ...classifiers];
}

/** VEGA gateway provider with a persisted, dynamically refreshed model catalog. */
export function vegaProvider(): Provider<"anthropic-messages" | "openai-completions"> {
	return createProvider<"anthropic-messages" | "openai-completions">({
		id: "vega",
		name: "VEGA",
		baseUrl: VEGA_BASE_URL,
		auth: {
			apiKey: envApiKeyAuth("VEGA API key", ["VEGA_API_KEY"]),
			oauth: lazyOAuth({ name: "VEGA", loginLabel: "Sign in with VEGA", load: loadVegaOAuth }),
		},
		models: [],
		fetchModels: fetchVegaModels,
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-completions": openAICompletionsApi(),
		},
		images: { "openrouter-images": openrouterImagesApi() },
		// VEGA serves TypeSafe's System One protocol at /api/v1/systemone like OpenRouter.
		classifiers: { "typesafe-system-one": typesafeSystemOneApi() },
	});
}
