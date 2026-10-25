/**
 * Permission Gate Extension (issue #144)
 *
 * Pre-approves recursive rm only when every path argument is a plain
 * literal that resolves inside the session cwd (the lane worktree).
 * Shell expansions and metacharacters (~, $HOME, $(...), *, chains) are
 * never pre-approved: they fall back to the Allow? select when UI exists,
 * and block when it does not (HOLD 5712884435). Outside literals, symlink
 * escapes, sudo, and chmod/chown 777 take the same refuse path.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RM_RECURSIVE = /\brm\s+(-rf?|--recursive)\b/i;
const SUDO = /\bsudo\b/i;
const CHMOD_777 = /\b(chmod|chown)\b.*\b777\b/i;
const UNQUOTED_META = new Set("~$`*?[{|;,&><()\\\n".split(""));
const DOUBLE_QUOTE_META = new Set(["`", "$", "\\"]);
const PLAIN_PATH = /^(?:\.?\/|\.\.\/)?(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\/?$|^\/$/;
const SHELL_OPERATORS = new Set(["&&", "||", ";", "|", "&"]);

function isDangerous(command: string): boolean {
	return RM_RECURSIVE.test(command) || SUDO.test(command) || CHMOD_777.test(command);
}

type QuotedToken = { token: string; quote: "'" | '"' | null };

function tokenize(command: string): QuotedToken[] | null {
	const tokens: QuotedToken[] = [];
	let current = "";
	let quote: "'" | '"' | null = null;

	const flush = (q: "'" | '"' | null) => {
		if (current.length > 0 || q !== null) {
			tokens.push({ token: current, quote: q });
			current = "";
		}
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			if (ch === "\\" && quote === '"' && i + 1 < command.length) {
				current += command[++i];
				continue;
			}
			if (ch === quote) {
				flush(quote);
				quote = null;
				continue;
			}
			current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			if (current) flush(null);
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current) flush(null);
			continue;
		}
		current += ch;
	}
	if (quote) return null;
	if (current) flush(null);
	return tokens;
}

function isPlainLiteralPath(token: string, quote: "'" | '"' | null): boolean {
	if (!token) return false;
	if (quote === "'") {
		return PLAIN_PATH.test(token);
	}
	if (quote === '"') {
		for (const ch of token) {
			if (DOUBLE_QUOTE_META.has(ch)) return false;
		}
		return PLAIN_PATH.test(token);
	}
	if (token.startsWith("~")) return false;
	for (const ch of token) {
		if (UNQUOTED_META.has(ch)) return false;
	}
	return PLAIN_PATH.test(token);
}

function rmTargets(command: string): QuotedToken[] | null {
	const tokens = tokenize(command);
	if (!tokens || tokens[0]?.token !== "rm" || tokens[0].quote !== null) return null;
	const paths: QuotedToken[] = [];
	let endOfOpts = false;
	for (const item of tokens.slice(1)) {
		if (item.quote === null && SHELL_OPERATORS.has(item.token)) return null;
		if (!endOfOpts && item.quote === null && item.token === "--") {
			endOfOpts = true;
			continue;
		}
		if (
			!endOfOpts &&
			item.quote === null &&
			item.token.startsWith("-") &&
			item.token !== "-"
		) {
			continue;
		}
		paths.push(item);
		endOfOpts = true;
	}
	return paths;
}

function realpathExisting(candidate: string): string {
	try {
		return fs.realpathSync(candidate);
	} catch {
		const parent = path.dirname(candidate);
		const base = path.basename(candidate);
		try {
			return path.join(fs.realpathSync(parent), base);
		} catch {
			return path.resolve(candidate);
		}
	}
}

function pathInsideWorktree(target: string, worktree: string, cwd: string): boolean {
	const root = realpathExisting(worktree);
	const base = realpathExisting(cwd);
	const candidate = path.isAbsolute(target) ? target : path.join(base, target);
	const resolved = realpathExisting(candidate);
	return resolved === root || resolved.startsWith(root + path.sep);
}

export type Verdict = "allow" | "refuse" | "pass";

export function dangerousCommandVerdict(
	command: string,
	worktree: string,
	cwd: string = worktree,
): Verdict {
	if (!isDangerous(command)) return "pass";
	if (SUDO.test(command) || CHMOD_777.test(command)) return "refuse";
	if (!RM_RECURSIVE.test(command)) return "refuse";
	const targets = rmTargets(command);
	if (!targets || targets.length === 0) return "refuse";
	for (const { token, quote } of targets) {
		if (!isPlainLiteralPath(token, quote)) return "refuse";
		if (!pathInsideWorktree(token, worktree, cwd)) return "refuse";
	}
	return "allow";
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = String((event.input as { command?: string }).command ?? "");
		const verdict = dangerousCommandVerdict(command, ctx.cwd, ctx.cwd);

		if (verdict === "pass" || verdict === "allow") {
			return undefined;
		}

		// Refuse of expansion / outside / sudo: fall back to the Allow dialog
		// when UI exists so we never replace a human prompt with a silent yes.
		if (ctx.hasUI) {
			const choice = await ctx.ui.select(
				`Dangerous command:\n\n  ${command}\n\nAllow?`,
				["Yes", "No"],
			);
			if (choice !== "Yes") {
				return { block: true, reason: "Blocked by user" };
			}
			return undefined;
		}

		return {
			block: true,
			reason: "Dangerous command blocked (no UI for confirmation)",
		};
	});
}
