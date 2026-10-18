import { afterEach, describe, expect, test, vi } from "vitest";
import { register } from "../hooks/register.js";
import type { BandState, Dollar, Events, Handler, Node, On } from "../src/api.js";

afterEach(() => vi.unstubAllGlobals());

function harness(initial: string) {
  let box = initial;
  let state: BandState | undefined;
  const handlers = new Map<string, unknown>();
  const sent: string[] = [];
  const displayed: string[] = [];
  const toasts: string[] = [];
  const drops: { text: string; modelCalls: number }[] = [];
  const complete = vi.fn<Dollar["model"]["complete"]>(async () => ({ isAnswered: true, text: "Add a login page. Read the repo first. Ask when unclear. Verify the page renders." }));
  const $: Dollar = {
    prompt: {
      read: async () => ({ text: box, cursor: box.length }),
      fill: async ({ text }) => { box = text; displayed.push(text); return { isFilled: true }; },
      submit: async ({ text, asUser }) => { expect(asUser).toBe(true); sent.push(text); return { text }; },
    },
    model: { complete },
    state: {
      get: async () => ({ value: state, version: 0 }),
      set: async (_ref, value) => { state = value; return { isSet: true, version: 1 }; },
    },
    ui: {
      toast: async text => { toasts.push(text); },
      resolve: () => ({ Box: props => ({ tag: "Box", props, children: [] }), Text: props => ({ tag: "Text", props, children: [] }), Button: props => ({ tag: "Button", props, children: [] }) }),
    },
  };
  vi.stubGlobal("h", (tag: string | ((props: Record<string, unknown>) => Node), props: Record<string, unknown> | null, ...children: unknown[]) => {
    const node = typeof tag === "function" ? tag(props ?? {}) : { tag, props: props ?? {}, children: [] };
    return { ...node, children };
  });
  const catches = new Map<string, unknown>();
  const on = ((name: string, ...args: unknown[]) => {
    handlers.set(name, args.at(-1));
    return { catch: (handler: unknown) => { catches.set(name, handler); } };
  }) as On;
  register(on);
  async function fire<K extends keyof Events>(name: K, event: Events[K]) {
    const handler = handlers.get(name) as Handler<K> | undefined;
    expect(handler, `missing ${name} hook`).toBeDefined();
    const composer = name === "prompt.submit" && (event as Events["prompt.submit"]).origin.kind === "composer";
    const handedBack = composer && box.trim() === (event as Events["prompt.submit"]).text ? box : (event as Events["prompt.submit"]).text;
    if (composer && box.trim() === (event as Events["prompt.submit"]).text) {
      await fire("prompt.change", { text: box, cursor: box.length, origin: { kind: "input" } });
      box = "";
    }
    let settled: Events[K];
    const next = Object.assign(async (e: Events[K]) => { if (next.called) return settled; next.called = true; settled = e; if (name === "prompt.submit") sent.push((e as Events["prompt.submit"]).text); return e; }, { called: false });
    let result: unknown;
    try { result = await handler!($, event, next); }
    catch (error) {
      const fallback = catches.get(name) as Handler<K> | undefined;
      if (!fallback) throw error;
      result = await fallback($, event, next);
    }
    if (composer && result && typeof result === "object" && "drop" in result) {
      drops.push({ text: box, modelCalls: complete.mock.calls.length });
      if (!box) await fire("prompt.change", { text: "", cursor: 0, origin: { kind: "clear" } });
      box = box.trim() ? `${box}\n${handedBack}` : handedBack;
      await fire("prompt.change", { text: box, cursor: box.length, origin: { kind: "engine" } });
      await settle();
    }
    return result;
  }
  async function press(label: string) {
    const tree = await fire("ui.render", { component: "AbovePrompt", props: { hasSurvey: false, isWorking: false } });
    function find(value: unknown): Node | undefined {
      if (!value || typeof value !== "object") return;
      const node = value as Node;
      if (node.props?.label === label) return node;
      for (const child of node.children ?? []) { const hit = find(child); if (hit) return hit; }
    }
    const button = find(tree);
    expect(button, `missing ${label} button`).toBeDefined();
    await (button!.props.onPress as () => Promise<unknown>)();
  }
  return { $, fire, press, settle, sent, displayed, toasts, drops, complete, box: () => box, edit: (text: string) => { box = text; } };
}
// One macrotask lets detached mod work (the Enhance model call) run to completion
// when the fake model answers at once, as the host's event loop would.
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const submit = (text: string): Events["prompt.submit"] => ({ text: text.trim(), origin: { kind: "composer" }, wait: false });

describe("Prompt Enhancer review boundary", () => {
  test("typed ++ enhances into the box instead of sending", async () => {
    const h = harness("add a login opage++");
    const result = await h.fire("prompt.submit", submit(h.box()));
    expect(result).toHaveProperty("drop");
    expect(h.drops).toEqual([{ text: "", modelCalls: 0 }]);
    expect(h.complete).toHaveBeenCalledWith(expect.objectContaining({ model: "haiku", prompt: "add a login opage" }));
    expect(h.box()).toContain("Read the repo first");
    expect(h.box()).not.toContain("login opage++");
    expect(h.sent).toEqual([]);
  });
  test("Enter sends a reviewed rewrite that ends in ++, with no second model call", async () => {
    const h = harness("Fix the parser in C++++");
    h.complete.mockResolvedValueOnce({ isAnswered: true, text: "Fix the parser in C++" });
    await h.fire("prompt.submit", submit(h.box()));
    expect(h.box()).toBe("Fix the parser in C++");
    await h.fire("prompt.submit", submit(h.box()));
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(h.sent).toEqual(["Fix the parser in C++"]);
  });
  test("a failed Enhance leaves no original behind: Undo after the next Enhance keeps the newer draft", async () => {
    const h = harness("draft one");
    h.complete.mockResolvedValueOnce({ isAnswered: false, text: "" });
    await h.press("Enhance");
    expect(h.box()).toBe("draft one");
    h.edit("draft two");
    h.complete.mockResolvedValueOnce({ isAnswered: true, text: "Rewrite of draft two" });
    await h.press("Enhance");
    expect(h.box()).toBe("Rewrite of draft two");
    await h.press("Undo");
    expect(h.box()).toBe("draft two");
  });
  test("an edit during Enhance leaves no original behind: Undo keeps the edit", async () => {
    const h = harness("draft");
    let answer: (value: { isAnswered: boolean; text: string }) => void = () => undefined;
    h.complete.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const pending = h.press("Enhance");
    await h.settle();
    h.edit("mine");
    await h.fire("prompt.change", { text: "mine", cursor: 4, origin: { kind: "input" } });
    answer({ isAnswered: true, text: "Rewrite" });
    await pending;
    await h.settle();
    expect(h.box()).toBe("mine");
    await h.press("Undo");
    expect(h.box()).toBe("mine");
  });
  for (const held of [1, 2]) {
    test(`an edit while state write ${held} of Enhance is pending leaves no stale original`, async () => {
      const h = harness("draft one");
      const realSet = h.$.state.set;
      let calls = 0;
      let release: () => void = () => undefined;
      h.$.state.set = async (...args: Parameters<typeof realSet>) => {
        calls += 1;
        if (calls === held) await new Promise<void>(resolve => { release = resolve; });
        return realSet(...args);
      };
      h.complete.mockImplementation(async ({ prompt }) => ({ isAnswered: true, text: `Rewrite of ${prompt}` }));
      const pending = h.press("Enhance");
      await h.settle();
      h.edit("draft two");
      const changing = h.fire("prompt.change", { text: "draft two", cursor: 9, origin: { kind: "input" } });
      await h.settle();
      release();
      await changing;
      await pending;
      await h.settle();
      expect(h.box()).toBe("draft two");
      // Held at write 1, the canceled Enhance stops before the model call.
      expect(h.complete).toHaveBeenCalledTimes(held === 1 ? 0 : 1);
      await h.press("Enhance");
      expect(h.box()).toBe("Rewrite of draft two");
      await h.press("Undo");
      expect(h.box()).toBe("draft two");
    });
  }
  test("Undo pressed while the original save is pending still restores the draft", async () => {
    const h = harness("draft one");
    h.complete.mockResolvedValueOnce({ isAnswered: true, text: "Rewrite of draft one" });
    const realSet = h.$.state.set;
    let calls = 0;
    let release: () => void = () => undefined;
    h.$.state.set = async (...args: Parameters<typeof realSet>) => {
      calls += 1;
      if (calls === 2) await new Promise<void>(resolve => { release = resolve; });
      return realSet(...args);
    };
    const enhancing = h.press("Enhance");
    await h.settle();
    expect(h.box()).toBe("Rewrite of draft one");
    const undoing = h.press("Undo");
    await h.settle();
    release();
    await enhancing;
    await undoing;
    await h.settle();
    expect(h.box()).toBe("draft one");
  });
  test("Undo during the model call cancels Enhance and keeps the draft", async () => {
    const h = harness("draft");
    let answer: (value: { isAnswered: boolean; text: string }) => void = () => undefined;
    h.complete.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const enhancing = h.press("Enhance");
    await h.settle();
    await h.press("Undo");
    answer({ isAnswered: true, text: "Late rewrite" });
    await enhancing;
    await h.settle();
    expect(h.box()).toBe("draft");
    expect((await h.$.state.get({ plugin: "prompt-enhancer", key: "band" })).value?.busy).toBe(false);
  });
  test("a canceled Enhance leaves the band not busy", async () => {
    const h = harness("draft");
    const realSet = h.$.state.set;
    let release: () => void = () => undefined;
    let first = true;
    h.$.state.set = async (...args: Parameters<typeof realSet>) => {
      if (first) { first = false; await new Promise<void>(resolve => { release = resolve; }); }
      return realSet(...args);
    };
    const pending = h.press("Enhance");
    await h.settle();
    h.edit("mine");
    const changing = h.fire("prompt.change", { text: "mine", cursor: 4, origin: { kind: "input" } });
    await h.settle();
    release();
    await changing;
    await pending;
    await h.settle();
    expect((await h.$.state.get({ plugin: "prompt-enhancer", key: "band" })).value?.busy).toBe(false);
  });
  test("an edited rewrite starts a new chain: Undo after its Enhance gives the edit", async () => {
    const h = harness("draft");
    h.complete.mockResolvedValueOnce({ isAnswered: true, text: "R1" });
    await h.press("Enhance");
    h.edit("R1 with my change");
    h.complete.mockResolvedValueOnce({ isAnswered: true, text: "R2" });
    await h.press("Enhance");
    await h.press("Undo");
    expect(h.box()).toBe("R1 with my change");
  });
  test("a failed second Enhance keeps the first original for Undo", async () => {
    const h = harness("draft");
    h.complete.mockResolvedValueOnce({ isAnswered: true, text: "R1" });
    await h.press("Enhance");
    h.complete.mockResolvedValueOnce({ isAnswered: false, text: "" });
    await h.press("Enhance");
    expect(h.box()).toBe("R1");
    await h.press("Undo");
    expect(h.box()).toBe("draft");
  });
  test("Send passes a typed prompt that ends in ++ as is", async () => {
    const h = harness("what changed in C++");
    await h.press("Send");
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.sent).toEqual(["what changed in C++"]);
  });
  test("an edited rewrite that ends in ++ is a new trigger", async () => {
    const h = harness("login++");
    h.complete.mockResolvedValueOnce({ isAnswered: true, text: "Add a login page." });
    await h.fire("prompt.submit", submit(h.box()));
    h.edit("Add a login page with SSO++");
    await h.fire("prompt.submit", submit(h.box()));
    expect(h.complete).toHaveBeenCalledTimes(2);
    expect(h.complete).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: "Add a login page with SSO" }));
    expect(h.sent).toEqual([]);
  });
  test("Undo restores the exact original bytes", async () => {
    const original = "  login\r\n😀 é ++";
    const h = harness(original);
    await h.fire("prompt.submit", submit(original));
    await h.press("Undo");
    expect(Buffer.from(h.box())).toEqual(Buffer.from(original));
    expect(h.sent).toEqual([]);
  });
  test("Undo retains the saved bytes when another fill changes them", async () => {
    const original = "  login\r\n😀 é ++";
    const h = harness(original);
    await h.fire("prompt.submit", submit(original));
    const fill = h.$.prompt.fill;
    h.$.prompt.fill = input => fill({ ...input, text: input.text.trim() });
    await h.press("Undo");
    expect(h.toasts).toContain("Undo could not write the prompt box. Nothing was sent.");
    h.$.prompt.fill = fill;
    await h.press("Undo");
    expect(Buffer.from(h.box())).toEqual(Buffer.from(original));
    expect(h.sent).toEqual([]);
  });
  test("the normalized trigger preserves trailing bytes for Undo", async () => {
    const original = "  login++ \r\n";
    const h = harness(original);
    await h.fire("prompt.submit", submit(original));
    expect(h.complete).toHaveBeenCalledWith(expect.objectContaining({ prompt: "  login \r\n" }));
    await h.press("Undo");
    expect(Buffer.from(h.box())).toEqual(Buffer.from(original));
  });
  test("the rewrite fill notification cannot start another enhancement", async () => {
    const h = harness("login++");
    await h.fire("prompt.submit", submit(h.box()));
    await h.fire("prompt.change", { text: h.box(), cursor: h.box().length, origin: { kind: "plugin" } });
    expect(h.complete).toHaveBeenCalledTimes(1);
    await h.fire("prompt.submit", submit(h.box()));
    expect(h.sent).toHaveLength(1);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });
  test("Send submits the edited box as the user's own words", async () => {
    const h = harness("login++");
    await h.fire("prompt.submit", submit(h.box()));
    h.edit("My edited login request");
    await h.press("Send");
    expect(h.sent).toEqual(["My edited login request"]);
  });
  test("a failed model call restores the original and shows a toast", async () => {
    const original = "login++";
    const h = harness(original);
    h.complete.mockRejectedValueOnce(new Error("unavailable"));
    await h.fire("prompt.submit", submit(original));
    expect(h.box()).toBe(original);
    expect(h.toasts.length).toBeGreaterThan(0);
    expect(h.sent).toEqual([]);
  });
  test("nothing reaches the conversation until the visible draft is sent", async () => {
    const h = harness("login++");
    await h.fire("prompt.submit", submit(h.box()));
    const visible = h.box();
    expect(h.displayed).toContain(visible);
    expect(h.sent).toEqual([]);
    await h.fire("prompt.submit", submit(visible));
    expect(h.sent).toEqual([visible]);
  });
});

describe("failure and race handling", () => {
  test("Enhance button rewrites an ordinary draft without sending it", async () => {
    const h = harness("login");
    await h.press("Enhance");
    expect(h.box()).toContain("Read the repo first");
    expect(h.sent).toEqual([]);
    await h.press("Undo");
    expect(h.box()).toBe("login");
  });
  test.each([false, true])("a missing or empty model answer keeps the original (%s)", async isAnswered => {
    const h = harness("login++");
    h.complete.mockResolvedValueOnce({ isAnswered, text: "" });
    await h.fire("prompt.submit", submit("login++"));
    expect(h.box()).toBe("login++");
    expect(h.toasts).toContain("Enhance failed. Kept your original prompt.");
    expect(h.sent).toEqual([]);
  });
  test("a late model answer cannot replace a user edit", async () => {
    const h = harness("login++");
    let answer!: (value: { isAnswered: boolean; text: string }) => void;
    h.complete.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const pending = h.fire("prompt.submit", submit("login++"));
    await vi.waitFor(() => expect(h.complete).toHaveBeenCalled());
    h.edit("My newer draft");
    answer({ isAnswered: true, text: "Stale rewrite" });
    await pending;
    await h.settle();
    expect(h.box()).toBe("My newer draft");
    expect(h.sent).toEqual([]);
  });
  test("Undo cancels a pending rewrite", async () => {
    const h = harness("login++");
    let answer!: (value: { isAnswered: boolean; text: string }) => void;
    h.complete.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const pending = h.fire("prompt.submit", submit("login++"));
    await vi.waitFor(() => expect(h.complete).toHaveBeenCalled());
    await h.press("Undo");
    answer({ isAnswered: true, text: "Stale rewrite" });
    await pending;
    await h.settle();
    expect(h.box()).toBe("login++");
    expect(h.sent).toEqual([]);
  });
  test("Send cannot race a pending model call", async () => {
    const h = harness("login++");
    let answer!: (value: { isAnswered: boolean; text: string }) => void;
    h.complete.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const pending = h.fire("prompt.submit", submit("login++"));
    await vi.waitFor(() => expect(h.complete).toHaveBeenCalled());
    await h.press("Send");
    expect(h.sent).toEqual([]);
    answer({ isAnswered: true, text: "Visible rewrite" });
    await pending;
    await h.settle();
  });
  test("Enter during Enhance restores one draft and sends nothing", async () => {
    const h = harness("login++");
    let answer!: (value: { isAnswered: boolean; text: string }) => void;
    h.complete.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const pending = h.fire("prompt.submit", submit("login++"));
    await vi.waitFor(() => expect(h.complete).toHaveBeenCalled());
    expect(await h.fire("prompt.submit", submit(h.box()))).toHaveProperty("drop");
    expect(h.box()).toBe("login++");
    answer({ isAnswered: true, text: "Visible rewrite" });
    await pending;
    await h.settle();
    expect(h.box()).toBe("Visible rewrite");
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(h.sent).toEqual([]);
  });
  test("the host restore notification settles before the model answers", async () => {
    const h = harness("login++");
    let answer!: (value: { isAnswered: boolean; text: string }) => void;
    h.complete.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const held = Symbol("held");
    const settled = await Promise.race([
      h.fire("prompt.submit", submit("login++")),
      new Promise(resolve => setTimeout(resolve, 50, held)),
    ]);
    expect(settled).not.toBe(held);
    expect(h.complete).toHaveBeenCalledTimes(1);
    answer({ isAnswered: true, text: "Visible rewrite" });
    await vi.waitFor(() => expect(h.box()).toBe("Visible rewrite"));
    expect(h.sent).toEqual([]);
  });
  test("prompt.change cancels a pending result without rewriting its event", async () => {
    const h = harness("login++");
    let answer!: (value: { isAnswered: boolean; text: string }) => void;
    h.complete.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const pending = h.fire("prompt.submit", submit("login++"));
    await vi.waitFor(() => expect(h.complete).toHaveBeenCalled());
    h.edit("History draft");
    const change: Events["prompt.change"] = { text: h.box(), cursor: 13, origin: { kind: "history" } };
    expect(await h.fire("prompt.change", change)).toBe(change);
    await h.press("Enhance");
    expect(h.complete).toHaveBeenCalledTimes(2);
    const current = h.box();
    answer({ isAnswered: true, text: "Stale rewrite" });
    await pending;
    await h.settle();
    expect(h.box()).toBe(current);
  });
  test("a rejected rewrite fill retains the host restored draft", async () => {
    const h = harness("login++");
    h.$.prompt.fill = async () => ({ isFilled: false });
    await h.fire("prompt.submit", submit("login++"));
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(h.box()).toBe("login++");
    expect(h.sent).toEqual([]);
    expect(h.toasts).toContain("The prompt box could not take the rewrite. Nothing was sent.");
  });
  test("a state error after host restoration holds the prompt", async () => {
    const h = harness("login++");
    h.$.state.get = async () => { throw new Error("state unavailable"); };
    expect(await h.fire("prompt.submit", submit("login++"))).toHaveProperty("drop");
    expect(h.box()).toBe("login++");
    expect(h.sent).toEqual([]);
  });
  test("ordinary prompts and prompts from plugins pass through", async () => {
    const h = harness("ordinary prompt");
    const ordinary = submit("ordinary prompt");
    await h.fire("prompt.submit", ordinary);
    await h.fire("prompt.submit", { ...submit("plugin++"), origin: { kind: "plugin" } });
    expect(h.sent).toEqual(["ordinary prompt", "plugin++"]);
    expect(h.complete).not.toHaveBeenCalled();
  });
  test("collapse keeps the draft intact and expand restores the controls", async () => {
    const h = harness("login");
    await h.press("-");
    expect(h.box()).toBe("login");
    await h.press("+");
    await h.press("Enhance");
    expect(h.complete).toHaveBeenCalledTimes(1);
  });
});

describe("submission errors", () => {
  test("a refused Send retains the visible draft for review", async () => {
    const h = harness("login++");
    await h.fire("prompt.submit", submit("login++"));
    const visible = h.box();
    h.$.prompt.submit = async () => ({ drop: "Another mod refused" });
    await h.press("Send");
    expect(h.box()).toBe(visible);
    expect(h.sent).toEqual([]);
    expect(h.toasts).toContain("The prompt was not sent. Kept the draft.");
    await h.press("Undo");
    expect(h.box()).toBe("login++");
  });
  test("state errors after next do not send the prompt twice", async () => {
    const h = harness("ordinary prompt");
    h.$.state.get = async () => { throw new Error("state unavailable"); };
    await h.fire("prompt.submit", submit("ordinary prompt"));
    expect(h.sent).toEqual(["ordinary prompt"]);
  });
});

// Golden corpus: every place an Undo, an edit (which cancels) or a second
// Enhance can land inside one Enhance, with the end state each must leave.
// Enhance A runs on "draft one" (rewrite RA), Enhance B on "draft two" (RB).
// Phases of an Enhance: W1 busy write, model call, the box check read after
// the reply, fill, W2 original save, W3 busy-off write.
//
//  row  where the action lands          action            end state
//  U0   W1 pending                      Undo              box draft one, no model call
//  U1   model pending                   Undo              box draft one, late reply ignored
//  U2   box check after the reply       Undo              box draft one, no fill
//  U3   fill pending                    Undo              waits, box draft one
//  U4   W2 pending                      Undo              waits, box draft one
//  U5   W3 pending                      Undo              box draft one
//  U6   A done                          Undo, Undo        box draft one, second is a no-op
//  E0   W1 pending                      edit, B, Undo     box draft two, model called once (B)
//  E1   model pending                   edit, B, Undo     box draft two, late reply ignored
//  E2   box check after the reply       edit, B, Undo     box draft two
//  E3   fill pending                    edit              A saves no original (the fill lands last)
//  E4   W2 pending                      edit, Undo        box draft one (Undo goes back past the edit)
//  E6   A done                          edit, B, Undo     box is the edit
//  X1   A late reply during B's fill    Undo during fill  waits for B, box draft two
//  X2   A late reply during B's model   Undo              cancels B, box draft two
//  X3   A late reply after B is done    Undo              box draft two
// Every row also ends with the band not busy.
describe("interleavings golden corpus", () => {
  type Gate = { promise: Promise<void>; open: () => void };
  const gate = (): Gate => { let open = () => undefined as void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; };
  const RA = "Rewrite of draft one";

  function rig(initial: string, holds: { set?: number[]; fill?: number[]; readAfterReply?: boolean; model?: "held" | "auto" } = {}) {
    const h = harness(initial);
    const gates = { set: new Map<number, Gate>(), fill: new Map<number, Gate>(), read: gate(), model: [] as Gate[] };
    for (const n of holds.set ?? []) gates.set.set(n, gate());
    for (const n of holds.fill ?? []) gates.fill.set(n, gate());
    let sets = 0, fills = 0, replies = 0, readHeld = !holds.readAfterReply;
    const realSet = h.$.state.set, realFill = h.$.prompt.fill, realRead = h.$.prompt.read;
    h.$.state.set = async (...args: Parameters<typeof realSet>) => { sets += 1; await gates.set.get(sets)?.promise; return realSet(...args); };
    h.$.prompt.fill = async (...args: Parameters<typeof realFill>) => { fills += 1; await gates.fill.get(fills)?.promise; return realFill(...args); };
    h.$.prompt.read = async () => { if (!readHeld && replies > 0) { readHeld = true; await gates.read.promise; } return realRead(); };
    h.complete.mockImplementation(async ({ prompt }) => {
      const g = gate();
      gates.model.push(g);
      if (holds.model !== "held") g.open();
      await g.promise;
      replies += 1;
      return { isAnswered: true, text: `Rewrite of ${prompt}` };
    });
    const edit = (text: string) => { h.edit(text); return h.fire("prompt.change", { text, cursor: text.length, origin: { kind: "input" } }); };
    const band = async () => (await h.$.state.get({ plugin: "prompt-enhancer", key: "band" })).value;
    return { h, gates, edit, band };
  }
  async function ends(r: ReturnType<typeof rig>, box: string) {
    await r.h.settle();
    expect(r.h.box()).toBe(box);
    expect((await r.band())?.busy).toBe(false);
  }

  test("U0 Undo while W1 is pending cancels before the model call", async () => {
    const r = rig("draft one", { set: [1] });
    const a = r.h.press("Enhance"); await r.h.settle();
    const u = r.h.press("Undo"); await r.h.settle();
    r.gates.set.get(1)!.open(); await a; await u;
    expect(r.h.complete).not.toHaveBeenCalled();
    await ends(r, "draft one");
    expect((await r.band())?.original).toBeNull();
  });
  test("U1 Undo while the model is pending ignores the late reply", async () => {
    const r = rig("draft one", { model: "held" });
    const a = r.h.press("Enhance"); await r.h.settle();
    await r.h.press("Undo");
    r.gates.model[0].open(); await a;
    await ends(r, "draft one");
    expect((await r.band())?.original).toBeNull();
  });
  test("U2 Undo during the box check after the reply stops the fill", async () => {
    const r = rig("draft one", { readAfterReply: true });
    const a = r.h.press("Enhance"); await r.h.settle();
    await r.h.press("Undo");
    r.gates.read.open(); await a;
    await ends(r, "draft one");
    expect((await r.band())?.original).toBeNull();
  });
  test("U3 Undo while the fill is pending waits, then restores", async () => {
    const r = rig("draft one", { fill: [1] });
    const a = r.h.press("Enhance"); await r.h.settle();
    const u = r.h.press("Undo"); await r.h.settle();
    r.gates.fill.get(1)!.open(); await a; await u;
    await ends(r, "draft one");
  });
  test("U4 Undo while the original save is pending waits, then restores", async () => {
    const r = rig("draft one", { set: [2] });
    const a = r.h.press("Enhance"); await r.h.settle();
    expect(r.h.box()).toBe(RA);
    const u = r.h.press("Undo"); await r.h.settle();
    r.gates.set.get(2)!.open(); await a; await u;
    await ends(r, "draft one");
  });
  test("U5 Undo while the busy-off write is pending restores", async () => {
    const r = rig("draft one", { set: [3] });
    const a = r.h.press("Enhance"); await r.h.settle();
    const u = r.h.press("Undo"); await r.h.settle();
    r.gates.set.get(3)!.open(); await a; await u;
    await ends(r, "draft one");
  });
  test("U6 Undo after Enhance restores, a second Undo is a no-op", async () => {
    const r = rig("draft one");
    await r.h.press("Enhance");
    await r.h.press("Undo");
    await r.h.press("Undo");
    await ends(r, "draft one");
  });
  test("E0 an edit while W1 is pending, then B and Undo, gives the edit", async () => {
    const r = rig("draft one", { set: [1] });
    const a = r.h.press("Enhance"); await r.h.settle();
    const e = r.edit("draft two"); await r.h.settle();
    r.gates.set.get(1)!.open(); await e; await a;
    await r.h.press("Enhance");
    expect(r.h.complete).toHaveBeenCalledTimes(1);
    await r.h.press("Undo");
    await ends(r, "draft two");
  });
  test("E1 an edit while the model is pending, then B and Undo, gives the edit", async () => {
    const r = rig("draft one", { model: "held" });
    const a = r.h.press("Enhance"); await r.h.settle();
    await r.edit("draft two");
    r.gates.model[0].open(); await a; await r.h.settle();
    expect(r.h.box()).toBe("draft two");
    const b = r.h.press("Enhance"); await r.h.settle();
    r.gates.model[1].open(); await b;
    await r.h.press("Undo");
    await ends(r, "draft two");
  });
  test("E2 an edit during the box check, then B and Undo, gives the edit", async () => {
    const r = rig("draft one", { readAfterReply: true });
    const a = r.h.press("Enhance"); await r.h.settle();
    await r.edit("draft two");
    r.gates.read.open(); await a;
    expect(r.h.box()).toBe("draft two");
    await r.h.press("Enhance");
    await r.h.press("Undo");
    await ends(r, "draft two");
  });
  test("E3 an edit while the fill is pending: A saves no original", async () => {
    const r = rig("draft one", { fill: [1] });
    const a = r.h.press("Enhance"); await r.h.settle();
    await r.edit("draft two");
    r.gates.fill.get(1)!.open(); await a;
    await ends(r, RA);
    expect((await r.band())?.original).toBeNull();
  });
  test("E4 an edit while the original save is pending, then Undo, goes back to draft one", async () => {
    const r = rig("draft one", { set: [2] });
    const a = r.h.press("Enhance"); await r.h.settle();
    const e = r.edit(`${RA} edited`); await r.h.settle();
    r.gates.set.get(2)!.open(); await e; await a;
    await r.h.press("Undo");
    await ends(r, "draft one");
  });
  test("E6 an edit after A, then B and Undo, gives the edit", async () => {
    const r = rig("draft one");
    await r.h.press("Enhance");
    await r.edit(`${RA} edited`);
    await r.h.press("Enhance");
    await r.h.press("Undo");
    await ends(r, `${RA} edited`);
  });
  test("X1 A's late reply during B's fill does not clear B: Undo waits for B", async () => {
    const r = rig("draft one", { model: "held", fill: [1] });
    const a = r.h.press("Enhance"); await r.h.settle();
    await r.edit("draft two");
    const b = r.h.press("Enhance"); await r.h.settle();
    r.gates.model[1].open(); await r.h.settle();
    r.gates.model[0].open(); await a; await r.h.settle();
    const u = r.h.press("Undo"); await r.h.settle();
    r.gates.fill.get(1)!.open(); await b; await u;
    await ends(r, "draft two");
  });
  test("X2 A's late reply during B's model call does not clear B: Undo cancels B", async () => {
    const r = rig("draft one", { model: "held" });
    const a = r.h.press("Enhance"); await r.h.settle();
    await r.edit("draft two");
    const b = r.h.press("Enhance"); await r.h.settle();
    r.gates.model[0].open(); await a; await r.h.settle();
    await r.h.press("Undo");
    r.gates.model[1].open(); await b;
    await ends(r, "draft two");
    expect((await r.band())?.original).toBeNull();
  });
  test("X3 A's late reply after B is done changes nothing: Undo gives draft two", async () => {
    const r = rig("draft one", { model: "held" });
    const a = r.h.press("Enhance"); await r.h.settle();
    await r.edit("draft two");
    const b = r.h.press("Enhance"); await r.h.settle();
    r.gates.model[1].open(); await b;
    r.gates.model[0].open(); await a; await r.h.settle();
    await r.h.press("Undo");
    await ends(r, "draft two");
  });
});
