/**
 * Per turn Pi resource guard for dispatched lanes.
 *
 * The dispatcher writes .pi/hq-turn-caps.json and installs this only in the
 * lane worktree. The provider hook caps the combined generated-token budget.
 * The timer aborts a turn that outlives its wall budget.
 * A response that has neither text nor a tool call is terminally failed so a
 * long hidden thinking run cannot look like a successful empty answer.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type TurnCaps = {
	maxOutputTokens: number;
	maxWallSeconds: number;
};

type ProviderPayload = Record<string, unknown>;
type Timer = ReturnType<typeof setTimeout>;
const MIN_ANSWER_TOKENS = 1024;
const MAX_TIMER_MILLISECONDS = 2_147_483_647;

function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function parseTurnCaps(value: unknown): TurnCaps | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (
		!positiveInteger(record.maxOutputTokens) ||
		!positiveInteger(record.maxWallSeconds) ||
		record.maxWallSeconds * 1000 > MAX_TIMER_MILLISECONDS
	) {
		return null;
	}
	return {
		maxOutputTokens: record.maxOutputTokens,
		maxWallSeconds: record.maxWallSeconds,
	};
}

export function readTurnCaps(cwd: string): TurnCaps | null {
	try {
		return parseTurnCaps(
			JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "hq-turn-caps.json"), "utf8")),
		);
	} catch {
		return null;
	}
}

function capped(existing: unknown, cap: number): number {
	return typeof existing === "number" && Number.isFinite(existing)
		? Math.min(existing, cap)
		: cap;
}

export function capProviderPayload(payload: unknown, caps: TurnCaps): ProviderPayload {
	const source = payload && typeof payload === "object" && !Array.isArray(payload)
		? payload as ProviderPayload
		: {};
	const next: ProviderPayload = { ...source };
	if ("max_completion_tokens" in source) {
		next.max_completion_tokens = capped(source.max_completion_tokens, caps.maxOutputTokens);
	} else {
		next.max_tokens = capped(source.max_tokens, caps.maxOutputTokens);
	}
	return next;
}

export function isEmptyAssistantMessage(message: unknown): boolean {
	if (!message || typeof message !== "object") return true;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return true;
	return !content.some((part) => {
		if (!part || typeof part !== "object") return false;
		const block = part as { type?: unknown; text?: unknown };
		return block.type === "toolCall" ||
			(block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0);
	});
}

export function turnFailureReason(message: unknown, turnIndex: number): string {
	if (message && typeof message === "object" && (message as { stopReason?: unknown }).stopReason === "length") {
		return `output cap reached on turn ${turnIndex}`;
	}
	return isEmptyAssistantMessage(message) ? `empty response on turn ${turnIndex}` : "";
}

export function failTurn(
	ctx: Pick<ExtensionContext, "abort" | "shutdown">,
	reason: string,
	setExitCode: (code: number) => void = (code) => { process.exitCode = code; },
	markFailure: () => void = () => {},
): void {
	console.error(`PI_TURN_CAP: ${reason}; stopping lane`);
	markFailure();
	setExitCode(1);
	ctx.abort();
	ctx.shutdown();
}

export function beginWallClock(
	ctx: Pick<ExtensionContext, "abort" | "shutdown">,
	caps: TurnCaps,
	schedule: typeof setTimeout = setTimeout,
	setExitCode: (code: number) => void = (code) => { process.exitCode = code; },
	markFailure: () => void = () => {},
): Timer {
	return schedule(() => {
		failTurn(ctx, `wall clock exceeded ${caps.maxWallSeconds}s`, setExitCode, markFailure);
	}, caps.maxWallSeconds * 1000);
}

type ProcessExitListener = {
	on(event: "exit", listener: () => void): unknown;
	exitCode?: number;
};

export function installFailureExitMarker(
	hasFailed: () => boolean,
	processRef: ProcessExitListener = process,
): void {
	processRef.on("exit", () => {
		if (hasFailed()) processRef.exitCode = 1;
	});
}

export default function (pi: ExtensionAPI) {
	let caps: TurnCaps | null = null;
	let timer: Timer | undefined;
	let failed = false;
	const markFailure = () => { failed = true; };
	installFailureExitMarker(() => failed);
	const clearTimer = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
	};

	pi.on("turn_start", (_event, ctx) => {
		clearTimer();
		caps = readTurnCaps(ctx.cwd);
		if (!caps) {
			failTurn(ctx, "turn cap config missing or invalid", undefined, markFailure);
			return;
		}
		timer = beginWallClock(ctx, caps, undefined, undefined, markFailure);
	});

	pi.on("before_provider_request", (event) => {
		return caps ? capProviderPayload(event.payload, caps) : undefined;
	});

	pi.on("turn_end", (event, ctx) => {
		clearTimer();
		const reason = caps ? turnFailureReason(event.message, event.turnIndex) : "";
		if (reason) {
			failTurn(ctx, reason, undefined, markFailure);
		}
	});

	pi.on("session_shutdown", () => {
		clearTimer();
	});

	pi.on("agent_end", () => {
		clearTimer();
	});
}
