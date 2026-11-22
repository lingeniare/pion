/**
 * The VEGA balance status: shows the credits reported by `GET /key` in the footer
 * while a VEGA model is selected. Refreshes on session start, model switch, and
 * after each agent turn, so the number tracks spending during a session.
 */

import type { ExtensionContext, ExtensionFactory } from "../../core/extensions/types.ts";

const VEGA_KEY_URL = "https://api.vega.chat/api/v1/key";
const VEGA_STATUS_KEY = "vega";
const VEGA_REQUEST_TIMEOUT_MS = 5_000;
const VEGA_MIN_REFRESH_INTERVAL_MS = 10_000;

interface VegaKeyData {
	limit_remaining?: unknown;
	usage?: unknown;
	is_free_tier?: unknown;
}

/** Format the credits from `GET /key`: remaining balance, or cumulative spend for keys without a limit. */
function vegaBalanceText(data: VegaKeyData): string | undefined {
	const remaining = data.limit_remaining;
	if (typeof remaining === "number" && Number.isFinite(remaining)) {
		return `vega $${remaining.toFixed(2)}`;
	}
	const usage = data.usage;
	if (typeof usage === "number" && Number.isFinite(usage)) {
		return `vega -$${usage.toFixed(2)}`;
	}
	return undefined;
}

async function fetchVegaBalance(apiKey: string, signal: AbortSignal | undefined): Promise<string | undefined> {
	try {
		const timeout = AbortSignal.timeout(VEGA_REQUEST_TIMEOUT_MS);
		const response = await fetch(VEGA_KEY_URL, {
			headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		if (!response.ok) return undefined;
		const body = (await response.json()) as { data?: VegaKeyData } | undefined;
		if (!body?.data || typeof body.data !== "object") return undefined;
		return vegaBalanceText(body.data);
	} catch {
		return undefined;
	}
}

export function createVegaExtension(): ExtensionFactory {
	return (pi) => {
		let lastRefresh = 0;

		const refresh = (ctx: ExtensionContext, force: boolean): void => {
			if (!ctx.hasUI || ctx.model?.provider !== "vega") {
				ctx.ui.setStatus(VEGA_STATUS_KEY, undefined);
				return;
			}
			if (!force && Date.now() - lastRefresh < VEGA_MIN_REFRESH_INTERVAL_MS) return;
			lastRefresh = Date.now();
			const signal = ctx.signal;
			void ctx.modelRegistry
				.getApiKeyForProvider("vega")
				.then((apiKey) => (apiKey ? fetchVegaBalance(apiKey, signal) : undefined))
				.then((text) => {
					if (text !== undefined) ctx.ui.setStatus(VEGA_STATUS_KEY, text);
				})
				.catch(() => {});
		};

		pi.on("session_start", (_event, ctx) => refresh(ctx, true));
		pi.on("model_select", (_event, ctx) => refresh(ctx, true));
		pi.on("agent_end", (_event, ctx) => refresh(ctx, false));
	};
}

export default createVegaExtension();
