import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";

const cwd = mkdtempSync(join(tmpdir(), "pion-read-pdf-"));
writeFileSync(join(cwd, "doc.pdf"), "%PDF-1.4 fake body");
writeFileSync(join(cwd, "doc.txt"), "plain text");

afterAll(() => rmSync(cwd, { recursive: true, force: true }));
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

function ctxWithKeys(keys: Record<string, string>): ExtensionToolContext {
	return {
		cwd,
		modelRegistry: { getApiKeyForProvider: async (provider: string) => keys[provider] },
	} as unknown as ExtensionToolContext;
}

const tool = createReadToolDefinition(cwd);

describe("read PDF", () => {
	it("extracts text through the file-parser plugin on the VEGA credential", async () => {
		let captured: { url: string; init?: RequestInit } | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				captured = { url, init };
				return Response.json({ choices: [{ message: { content: "Page one\nPage two" } }] });
			}),
		);
		const result = await tool.execute("t1", { path: "doc.pdf" }, undefined, undefined, ctxWithKeys({ vega: "k" }));

		expect(captured?.url).toBe("https://api.vega.chat/api/v1/chat/completions");
		expect(new Headers(captured?.init?.headers).get("authorization")).toBe("Bearer k");
		const body = JSON.parse(String(captured?.init?.body));
		expect(body.plugins).toEqual([{ id: "file-parser" }]);
		const filePart = body.messages[0].content.find((part: { type?: string }) => part.type === "file");
		expect(filePart.file.filename).toBe("doc.pdf");
		expect(filePart.file.file_data).toMatch(/^data:application\/pdf;base64,/);
		expect(result.content[0]).toMatchObject({ type: "text", text: "Page one\nPage two" });
	});

	it("applies offset/limit to the extracted text", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ choices: [{ message: { content: "l1\nl2\nl3" } }] })),
		);
		const result = await tool.execute(
			"t1",
			{ path: "doc.pdf", offset: 2, limit: 1 },
			undefined,
			undefined,
			ctxWithKeys({ vega: "k" }),
		);
		expect(result.content[0].type).toBe("text");
		expect((result.content[0] as { text: string }).text).toContain("l2");
	});

	it("forces the parser engine via PION_READ_PDF_ENGINE", async () => {
		let captured: { init?: RequestInit } | undefined;
		vi.stubEnv("PION_READ_PDF_ENGINE", "mistral-ocr");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				captured = { init };
				return Response.json({ choices: [{ message: { content: "x" } }] });
			}),
		);
		await tool.execute("t1", { path: "doc.pdf" }, undefined, undefined, ctxWithKeys({ vega: "k" }));
		expect(JSON.parse(String(captured?.init?.body)).plugins).toEqual([
			{ id: "file-parser", pdf: { engine: "mistral-ocr" } },
		]);
	});

	it("explains the credential requirement instead of reading the PDF as text", async () => {
		await expect(tool.execute("t1", { path: "doc.pdf" }, undefined, undefined, ctxWithKeys({}))).rejects.toThrow(
			"VEGA or OpenRouter credential",
		);
	});
});
