// TEMPORARY: 3 art directions for the link cards, real data only. Not committed.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const { ImageResponse } = require(process.env.OG_LIB as string);
const out = process.env.OUT as string;
mkdirSync(out, { recursive: true });
const font = (n: string) => readFileSync(join("assets/og", n));
const fonts = [
	{ name: "Geist", data: font("Geist-Bold.ttf"), weight: 700, style: "normal" },
	{ name: "Geist", data: font("Geist-Medium.ttf"), weight: 500, style: "normal" },
	{ name: "Geist Mono", data: font("GeistMono-Regular.ttf"), weight: 400, style: "normal" },
];
const ART = `data:image/png;base64,${readFileSync("../../design/og-card/art/A-1.png").toString("base64")}`;
const FG = "#E5E8F0", MUTED = "#AFB4C1", DIM = "#8C92A3", IND = "#457CFD", VIO = "#9982F8", BG = "#05070F";
const C: Record<string, string> = { green: "#3FE0A0", yellow: "#FFC15A", red: "#FF6B6B" };

const page = (rel: string) => {
	const raw = readFileSync(join("content/docs/reference", rel), "utf-8");
	const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/)!;
	const g = (k: string) => fm[1].match(new RegExp(`^${k}:\\s*"(.*)"\\s*$`, "m"))?.[1] ?? "";
	return { title: g("title"), description: g("description"), body: raw.slice(fm[0].length) };
};
const examples = (b: string) => b.match(/^##\s+Examples?\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m)?.[1] ?? "";
function skillData(name: string) {
	const p = page(`skills/${name}.mdx`);
	const ex = examples(p.body);
	const cmd = ex.match(new RegExp("`(/ork:" + name + "[^`]*)`"))?.[1] ?? `/ork:${name}`;
	const blk = [...ex.matchAll(/^```([^\n]*)\n([\s\S]*?)^```/gm)].find((m) => !/Invoke/.test(m[1]));
	let spec: any = null;
	let lines: string[] = [];
	if (blk && blk[1].trim() === "json") {
		try {
			spec = JSON.parse(blk[2]);
		} catch (e) {
			console.warn(`example JSON for ${name} did not parse`, e);
		}
	} else if (blk) lines = blk[2].replace(/\s+$/, "").split("\n").slice(0, 12).map((l) => [...l].slice(0, 56).join(""));
	const first = p.description.split(/(?<=\.)\s/)[0].replace(/\.$/, "");
	const line = first.length > 80 && first.includes(":") ? first.slice(0, first.indexOf(":")) : first;
	return { ...p, cmd, spec, lines, line };
}
function agentData(id: string) {
	const p = page(`agents/${id}.mdx`);
	const ad = readFileSync("lib/generated/agents-data.ts", "utf-8");
	const i = ad.indexOf(`"id": "${id}"`);
	const prompts = [...(ad.slice(i, i + 2500).match(/"examplePrompts":\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
	const sec = p.body.match(/^##\s+Tools Available\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m)?.[1] ?? "";
	const all = [...sec.matchAll(/^-\s+`([^`]+)`/gm)].map((m) => m[1]);
	const delegates = all.map((t) => t.match(/^Agent\((?:ork:)?([^)]+)\)$/)?.[1]).filter(Boolean) as string[];
	const line = p.description.includes(":") ? p.description.slice(p.description.indexOf(":") + 1).trim() : p.description;
	return { ...p, prompts, delegates, line: line.split(",").slice(0, 3).join(",") };
}

function SpecResult({ spec, big }: { spec: any; big?: boolean }) {
	const el = spec.elements ?? {};
	const stats = Object.values<any>(el).find((e) => e.type === "StatGrid")?.props.items.slice(0, 3) ?? [];
	const badge = Object.values<any>(el).find((e) => e.type === "StatusBadge")?.props;
	const bars = Object.values<any>(el).filter((e) => e.type === "BarMeter").slice(0, big ? 5 : 4).map((e) => e.props);
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
			{badge && (
				<div style={{ display: "flex" }}>
					<span style={{ fontFamily: "Geist", fontWeight: 700, fontSize: 18, color: "#062A1C", background: C.green, borderRadius: 999, padding: "6px 14px" }}>{badge.label.replace(" — ", ", ")}</span>
				</div>
			)}
			<div style={{ display: "flex", gap: 10 }}>
				{stats.map((s: any) => (
					<div key={s.label} style={{ display: "flex", flexDirection: "column", flex: 1, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: "10px 12px" }}>
						<span style={{ fontFamily: "Geist", fontWeight: 500, fontSize: 14, color: DIM }}>{s.label}</span>
						<span style={{ fontFamily: "Geist", fontWeight: 700, fontSize: big ? 30 : 26, color: C[s.color] ?? FG }}>{s.value}</span>
					</div>
				))}
			</div>
			{bars.map((b: any) => (
				<div key={b.label} style={{ display: "flex", alignItems: "center", gap: 10 }}>
					<span style={{ fontFamily: "Geist", fontWeight: 500, fontSize: 15, color: MUTED, width: 130 }}>{b.label}</span>
					<div style={{ display: "flex", flex: 1, height: 10, borderRadius: 5, background: "rgba(255,255,255,0.08)" }}>
						<div style={{ width: `${b.value * 10}%`, height: 10, borderRadius: 5, background: C[b.color] ?? IND }} />
					</div>
					<span style={{ fontFamily: "Geist Mono", fontSize: 15, color: FG, width: 34 }}>{b.value}</span>
				</div>
			))}
		</div>
	);
}
function TextResult({ lines, size = 14 }: { lines: string[]; size?: number }) {
	return (
		<div style={{ display: "flex", flexDirection: "column" }}>
			{lines.map((l, i) => (
				<span key={i} style={{ fontFamily: "Geist Mono", fontSize: size, lineHeight: 1.45, color: FG, whiteSpace: "pre" }}>{l || " "}</span>
			))}
		</div>
	);
}
function Terminal({ cmd, children, w, h }: { cmd: string; children: any; w: number; h: number }) {
	return (
		<div style={{ display: "flex", flexDirection: "column", width: w, height: h, background: "#0B0E1C", borderRadius: 16, border: "1px solid rgba(255,255,255,0.12)", boxShadow: "0 30px 80px rgba(0,0,0,0.6)", overflow: "hidden" }}>
			<div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", background: "#11152A" }}>
				{["#FF5F57", "#FEBC2E", "#28C840"].map((c) => (
					<div key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c }} />
				))}
				<span style={{ fontFamily: "Geist", fontWeight: 500, fontSize: 14, color: DIM, marginLeft: 10 }}>Claude Code</span>
			</div>
			<div style={{ display: "flex", flexDirection: "column", padding: "16px 20px", gap: 14 }}>
				<div style={{ display: "flex", gap: 10, fontFamily: "Geist Mono", fontSize: 18 }}>
					<span style={{ color: VIO }}>›</span>
					<span style={{ color: FG }}>{cmd}</span>
				</div>
				{children}
			</div>
		</div>
	);
}
const Word = ({ kind }: { kind: string }) => (
	<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
		<div style={{ width: 40, height: 4, borderRadius: 2, backgroundImage: `linear-gradient(90deg, ${IND}, ${VIO})` }} />
		<div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
			<span style={{ fontFamily: "Geist", fontWeight: 700, fontSize: 26, color: FG }}>OrchestKit</span>
			<span style={{ fontFamily: "Geist", fontWeight: 500, fontSize: 20, color: DIM }}>{kind}</span>
		</div>
	</div>
);
const Domain = () => <span style={{ fontFamily: "Geist", fontWeight: 500, fontSize: 19, color: MUTED }}>orchestkit.yonyon.ai</span>;

function result(d: any, big = false) {
	if (d.spec) return <SpecResult spec={d.spec} big={big} />;
	if (d.lines?.length) return <TextResult lines={d.lines.slice(0, big ? 12 : 10)} size={big ? 14 : 13} />;
	return <span style={{ color: MUTED }}>no example on the page</span>;
}
function agentResult(d: any) {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
			<span style={{ fontFamily: "Geist", fontWeight: 500, fontSize: 16, color: DIM }}>brings in</span>
			{d.delegates.length ? (
				d.delegates.map((a: string) => (
					<div key={a} style={{ display: "flex", alignItems: "center", gap: 10, background: "rgba(153,130,248,0.12)", border: "1px solid rgba(153,130,248,0.35)", borderRadius: 10, padding: "8px 12px" }}>
						<span style={{ color: VIO, fontFamily: "Geist Mono", fontSize: 18 }}>→</span>
						<span style={{ fontFamily: "Geist Mono", fontSize: 18, color: FG }}>{a}</span>
					</div>
				))
			) : (
				<span style={{ fontFamily: "Geist", fontSize: 18, color: MUTED }}>works alone</span>
			)}
		</div>
	);
}

function A(d: any, kind: string) {
	const cmd = kind === "skill" ? d.cmd : `"${d.prompts[0]}"`;
	return (
		<div style={{ width: "100%", height: "100%", display: "flex", padding: "44px 56px 0", background: BG, backgroundImage: "radial-gradient(circle at 78% 40%, rgba(69,124,253,0.32), rgba(5,7,15,0) 60%)" }}>
			<div style={{ display: "flex", flexDirection: "column", width: 420, paddingRight: 24 }}>
				<Word kind={kind} />
				<span style={{ fontFamily: "Geist", fontWeight: 700, fontSize: d.title.length > 18 ? 50 : 66, color: FG, lineHeight: 1.02, letterSpacing: -2, marginTop: 34 }}>{d.title}</span>
				<span style={{ fontFamily: "Geist", fontWeight: 500, fontSize: 23, color: MUTED, lineHeight: 1.35, marginTop: 16 }}>{d.line}</span>
				<div style={{ display: "flex", marginTop: "auto", marginBottom: 118 }}>
					<Domain />
				</div>
			</div>
			<Terminal cmd={cmd} w={660} h={420}>
				{kind === "skill" ? result(d) : agentResult(d)}
			</Terminal>
		</div>
	);
}
function B(d: any, kind: string) {
	const cmd = kind === "skill" ? d.cmd : d.prompts[0];
	return (
		<div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", padding: "40px 56px 0", background: BG, backgroundImage: "radial-gradient(circle at 50% 100%, rgba(153,130,248,0.28), rgba(5,7,15,0) 60%)" }}>
			<div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
				<Word kind={kind} />
				<span style={{ fontFamily: "Geist", fontWeight: 700, fontSize: 34, color: FG }}>{d.title}</span>
			</div>
			<div style={{ display: "flex", gap: 24, marginTop: 28, alignItems: "stretch" }}>
				<div style={{ display: "flex", flexDirection: "column", width: 400, gap: 10 }}>
					<span style={{ fontFamily: "Geist", fontWeight: 700, fontSize: 18, color: VIO }}>{kind === "skill" ? "You type" : "You ask"}</span>
					<div style={{ display: "flex", background: "rgba(153,130,248,0.12)", border: "1px solid rgba(153,130,248,0.4)", borderRadius: 14, padding: "16px 18px" }}>
						<span style={{ fontFamily: "Geist Mono", fontSize: 22, color: FG, lineHeight: 1.35 }}>{cmd}</span>
					</div>
					<span style={{ fontFamily: "Geist", fontWeight: 500, fontSize: 20, color: MUTED, lineHeight: 1.35, marginTop: 8 }}>{d.line}</span>
				</div>
				<div style={{ display: "flex", alignItems: "center", fontSize: 40, color: VIO }}>→</div>
				<div style={{ display: "flex", flexDirection: "column", flex: 1, gap: 10 }}>
					<span style={{ fontFamily: "Geist", fontWeight: 700, fontSize: 18, color: "#3FE0A0" }}>You get</span>
					<div style={{ display: "flex", flexDirection: "column", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 14, padding: "16px 18px", height: 330 }}>
						{kind === "skill" ? result(d, true) : agentResult(d)}
					</div>
				</div>
			</div>
			<div style={{ display: "flex", marginTop: 14 }}>
				<Domain />
			</div>
		</div>
	);
}
function Cc(d: any, kind: string) {
	const cmd = kind === "skill" ? d.cmd : `"${d.prompts[0]}"`;
	return (
		<div style={{ width: "100%", height: "100%", display: "flex", position: "relative", background: BG }}>
			<img src={ART} width={1200} height={630} style={{ position: "absolute", left: 220, top: 0, opacity: 0.85 }} />
			<div style={{ position: "absolute", left: 0, top: 0, width: 1200, height: 630, display: "flex", backgroundImage: "linear-gradient(90deg, #05070F 34%, rgba(5,7,15,0.55) 62%, rgba(5,7,15,0.2))" }} />
			<div style={{ position: "absolute", left: 56, top: 44, display: "flex", flexDirection: "column", width: 470 }}>
				<Word kind={kind} />
				<span style={{ fontFamily: "Geist", fontWeight: 700, fontSize: d.title.length > 18 ? 52 : 70, color: FG, lineHeight: 1.02, letterSpacing: -2, marginTop: 32 }}>{d.title}</span>
				<span style={{ fontFamily: "Geist", fontWeight: 500, fontSize: 23, color: MUTED, lineHeight: 1.35, marginTop: 16 }}>{d.line}</span>
				<div style={{ display: "flex", marginTop: 22 }}>
					<span style={{ fontFamily: "Geist Mono", fontSize: 19, color: FG, background: "rgba(153,130,248,0.16)", border: "1px solid rgba(153,130,248,0.45)", borderRadius: 10, padding: "8px 12px" }}>{cmd}</span>
				</div>
			</div>
			<div style={{ position: "absolute", left: 640, top: 150, display: "flex" }}>
				<Terminal cmd={kind === "skill" ? "result" : "plan"} w={500} h={330}>
					{kind === "skill" ? result(d) : agentResult(d)}
				</Terminal>
			</div>
			<div style={{ position: "absolute", left: 56, top: 495, display: "flex" }}>
				<Domain />
			</div>
		</div>
	);
}

async function main() {
	const items: [string, any][] = [["skill", skillData("glyph")], ["skill", skillData("assess")], ["agent", agentData("backend-system-architect")]];
	const names = ["glyph", "assess", "backend-system-architect"];
	for (const [k, f] of [["A", A], ["B", B], ["C", Cc]] as const) {
		for (let i = 0; i < items.length; i++) {
			const r = new ImageResponse((f as any)(items[i][1], items[i][0]), { width: 1200, height: 630, emoji: "twemoji", fonts });
			writeFileSync(join(out, `${k}-${names[i]}.png`), Buffer.from(await r.arrayBuffer()));
		}
	}
	console.log("rendered 9");
}
main();
