// MCP server card at <server>/server-card, listed in ai-catalog.
//
// The card's $schema must be a schema that exists. A test that compares the
// card to a hard-coded URL cannot show that (the first card named a draft URL
// that answers 404, Codex XREVIEW on #4819). So every $schema a served card may
// declare is pinned here to a copy of that schema, downloaded from the URL and
// kept in __tests__/fixtures/, and the whole card is validated against it.
// To move to a newer schema: download it, add it to PINNED, change
// SERVER_CARD_SCHEMA.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { GET as serverCardGET } from "@/app/api/mcp/server-card/route";
import { GET as catalogGET } from "@/app/api/well-known/ai-catalog/route";
import { SERVER_CARD_SCHEMA, serverCard } from "@/lib/server-card";

// $schema URL -> pinned copy. Checked with curl when pinned: HTTP 200.
const PINNED: Record<string, string> = {
	"https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json":
		"mcp-server.schema.2025-12-11.json",
};

function loadPinned(url: string): Record<string, unknown> {
	const file = PINNED[url];
	if (!file) throw new Error(`no pinned copy for $schema ${url}`);
	return JSON.parse(readFileSync(join(__dirname, "fixtures", file), "utf8"));
}

function validator(url: string) {
	// strictRequired is a lint of how the schema is written (the published
	// file lists a required name inside anyOf without a local property); it
	// says nothing about the card, so only that check is off.
	const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false });
	ajv.addVocabulary(["example"]); // annotation only, used by the MCP schema
	addFormats(ajv);
	return ajv.compile(loadPinned(url));
}

describe("MCP server card", () => {
	it("declares a pinned $schema whose copy is the file at that URL", async () => {
		const card = await serverCardGET().json();
		expect(card.$schema).toBe(SERVER_CARD_SCHEMA);
		expect(Object.keys(PINNED)).toContain(card.$schema);
		expect(loadPinned(card.$schema).$id).toBe(card.$schema);
	});

	it("validates against its schema with no errors", async () => {
		const card = await serverCardGET().json();
		const validate = validator(card.$schema);
		const ok = validate(card);
		expect(validate.errors ?? []).toEqual([]);
		expect(ok).toBe(true);
	});

	it("the validator rejects a card that breaks the schema", () => {
		const validate = validator(SERVER_CARD_SCHEMA);
		const tooLong = { ...serverCard(), description: "x".repeat(101) };
		const noVersion: Record<string, unknown> = { ...serverCard() };
		delete noVersion.version;
		const badRemote = {
			...serverCard(),
			remotes: [{ type: "carrier-pigeon", url: "https://orchestkit.dev/api/mcp" }],
		};
		for (const bad of [tooLong, noVersion, badRemote]) {
			expect(validate(bad)).toBe(false);
		}
	});

	it("has the card fields and no tools[]", async () => {
		const card = await serverCardGET().json();
		expect(card.name).toBe("dev.orchestkit/mcp");
		expect(card.description.length).toBeLessThanOrEqual(100);
		expect(card.remotes).toEqual([
			{ type: "streamable-http", url: "https://orchestkit.dev/api/mcp" },
		]);
		expect(card).not.toHaveProperty("tools");
		expect(card).toEqual(serverCard());
	});

	it("is the MCP entry in ai-catalog.json", async () => {
		const catalog = await catalogGET().json();
		const urls = catalog.entries.map((e: { url: string }) => e.url);
		expect(urls).toContain("https://orchestkit.dev/api/mcp/server-card");
	});
});
