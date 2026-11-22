/**
 * PDF text extraction for the `read` tool: the file goes through the OpenRouter-compatible
 * `file-parser` plugin on the VEGA or OpenRouter credential, and a small chat model returns
 * the document text so the usual line/offset/truncation pipeline applies.
 *
 * `PION_READ_PDF_MODEL` picks the extraction model (default `openai/gpt-4.1-mini`),
 * `PION_READ_PDF_ENGINE` forces the parser engine (`pdf-text`, `mistral-ocr`, `native`);
 * unset keeps the gateway's per-file default.
 */

import { basename } from "path";
import type { ExtensionContext } from "../extensions/types.ts";

const PDF_PROVIDERS = [
	{ provider: "vega", baseUrl: "https://api.vega.chat/api/v1" },
	{ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
] as const;
const PDF_TIMEOUT_MS = 120_000;
const DEFAULT_PDF_MODEL = "openai/gpt-4.1-mini";
/** The plugin accepts files around 10 MB; base64 inflates by a third, so cap well above that. */
const MAX_PDF_BYTES = 24 * 1024 * 1024;

export function isPdfPath(path: string): boolean {
	return path.toLowerCase().endsWith(".pdf");
}

interface PdfProvider {
	name: string;
	baseUrl: string;
	apiKey: string;
}

async function resolvePdfProvider(ctx: ExtensionContext | undefined): Promise<PdfProvider | undefined> {
	const registry = ctx?.modelRegistry;
	if (!registry) return undefined;
	for (const { provider, baseUrl } of PDF_PROVIDERS) {
		const apiKey = await registry.getApiKeyForProvider(provider);
		if (apiKey) return { name: provider, baseUrl, apiKey };
	}
	return undefined;
}

interface ChatMessage {
	content?: string | Array<{ type?: string; text?: string }> | null;
}

function messageText(content: ChatMessage["content"]): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => (part && typeof part.text === "string" ? part.text : ""))
			.join("\n")
			.trim();
	}
	return "";
}

/**
 * Extract a PDF's text through the `file-parser` plugin. Throws when no VEGA/OpenRouter
 * credential resolves or the gateway rejects the request.
 */
export async function readPdfText(
	buffer: Buffer,
	absolutePath: string,
	ctx: ExtensionContext | undefined,
	signal?: AbortSignal,
): Promise<string> {
	if (buffer.byteLength > MAX_PDF_BYTES) {
		throw new Error(
			`PDF is ${Math.round(buffer.byteLength / 1024 / 1024)} MB, above the ${MAX_PDF_BYTES / 1024 / 1024} MB parser limit. Convert it first (e.g. pdftotext via bash).`,
		);
	}
	const provider = await resolvePdfProvider(ctx);
	if (!provider) {
		throw new Error(
			"Reading PDF files needs a VEGA or OpenRouter credential: sign in to VEGA with /login, set VEGA_API_KEY, or configure OpenRouter",
		);
	}
	const model = process.env.PION_READ_PDF_MODEL ?? DEFAULT_PDF_MODEL;
	const engine = process.env.PION_READ_PDF_ENGINE;
	const plugin: Record<string, unknown> = { id: "file-parser" };
	if (engine) plugin.pdf = { engine };
	const timeout = AbortSignal.timeout(PDF_TIMEOUT_MS);
	const fetchSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const response = await fetch(`${provider.baseUrl}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${provider.apiKey}` },
		body: JSON.stringify({
			model,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "Extract the complete text of this document verbatim: headings, paragraphs, lists, and tables as plain text. Output only the document text, no commentary.",
						},
						{
							type: "file",
							file: {
								filename: basename(absolutePath),
								file_data: `data:application/pdf;base64,${buffer.toString("base64")}`,
							},
						},
					],
				},
			],
			plugins: [plugin],
			stream: false,
		}),
		signal: fetchSignal,
	});
	if (!response.ok) {
		const detail = (await response.text()).slice(0, 500);
		throw new Error(`PDF parsing failed on ${provider.name}: HTTP ${response.status} ${detail}`.trim());
	}
	const data = (await response.json()) as { choices?: Array<{ message?: ChatMessage }> };
	const text = messageText(data.choices?.[0]?.message?.content);
	if (!text) throw new Error("PDF parsing returned no text");
	return text;
}
