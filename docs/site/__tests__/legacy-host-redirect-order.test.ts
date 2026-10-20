// Codex XREVIEW on #4819: next.config redirects run BEFORE middleware, so a
// path redirect such as /docs -> /docs/foundations/overview fired first on the
// old host (307) and the host 301 came second: a two-hop chain. Old-host and
// Vercel-alias requests must leave on ONE 301 before any path redirect runs.
//
// This replays Next's rule for config redirects: the list is evaluated in
// order, a rule applies when its `has` host condition and its source match,
// and the first rule that applies wins. Path matching uses the
// path-to-regexp build that Next itself ships.

import { describe, expect, it } from "vitest";
import { pathToRegexp } from "next/dist/compiled/path-to-regexp";
import { siteRedirects } from "@/lib/site-redirects.mjs";

type HasHost = { type: "host"; value: string };
type Redirect = {
	source: string;
	destination: string;
	has?: HasHost[];
	statusCode?: number;
	permanent?: boolean;
};

const RULES = siteRedirects() as Redirect[];

function firstMatch(host: string, path: string): Redirect | undefined {
	return RULES.find((rule) => {
		const hostOk = (rule.has ?? []).every(
			(h) => h.type === "host" && new RegExp(`^${h.value}$`).test(host),
		);
		return hostOk && pathToRegexp(rule.source, [], { strict: true }).test(path);
	});
}

const PATH_REDIRECT_SOURCES = ["/docs", "/lab", "/lab/", "/docs/api", "/lab/x.html**"];

describe("host redirects come before every path redirect", () => {
	it.each(["orchestkit.yonyon.ai", "orchestkit.vercel.app"])(
		"%s: a page with a path redirect leaves on the host 301 first",
		(host) => {
			for (const path of PATH_REDIRECT_SOURCES) {
				const rule = firstMatch(host, path);
				expect(rule, `${host}${path}`).toBeDefined();
				expect(rule?.statusCode, `${host}${path}`).toBe(301);
				expect(rule?.destination.startsWith("https://orchestkit.dev/"), `${host}${path}`).toBe(true);
			}
		},
	);

	it.each(["/", "/about", "/docs/foundations/overview", "/llms.txt"])(
		"orchestkit.yonyon.ai%s answers the host 301",
		(path) => {
			const rule = firstMatch("orchestkit.yonyon.ai", path);
			expect(rule?.statusCode).toBe(301);
			expect(rule?.destination.startsWith("https://orchestkit.dev/")).toBe(true);
		},
	);

	it.each([
		"/api/mcp",
		"/api/mcp/actions",
		"/api/search",
		"/mcp",
		"/mcp.json",
		"/ask",
		"/auth.md",
		"/agent/identity",
		"/.well-known/oauth-protected-resource",
	])("orchestkit.yonyon.ai%s is never redirected (MCP and agent clients)", (path) => {
		expect(firstMatch("orchestkit.yonyon.ai", path)).toBeUndefined();
	});

	it("the canonical host keeps its own path redirects and no host redirect", () => {
		expect(firstMatch("orchestkit.dev", "/docs")?.destination).toBe("/docs/foundations/overview");
		expect(firstMatch("orchestkit.dev", "/about")).toBeUndefined();
	});
});
