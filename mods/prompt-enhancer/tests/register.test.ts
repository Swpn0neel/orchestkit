import { afterEach, describe, expect, test, vi } from "vitest";
import { register } from "../hooks/register.js";
import type { BandState, Dollar, Events, Handler, Node, On } from "../src/api.js";

afterEach(() => vi.unstubAllGlobals());

function harness(initial: string) {
  let box = initial;
  let state: BandState | undefined;
  const handlers = new Map<string, Function>();
  const sent: string[] = [];
  const displayed: string[] = [];
  const toasts: string[] = [];
  const complete = vi.fn(async () => ({ isAnswered: true, text: "Add a login page. Read the repo first. Ask when unclear. Verify the page renders." }));
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
  const on = ((name: string, ...args: unknown[]) => { handlers.set(name, args.at(-1) as Function); }) as On;
  register(on);
  async function fire<K extends keyof Events>(name: K, event: Events[K]) {
    const handler = handlers.get(name) as Handler<K> | undefined;
    expect(handler, `missing ${name} hook`).toBeDefined();
    return handler!($, event, async e => { if (name === "prompt.submit") sent.push((e as Events["prompt.submit"]).text); return e; });
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
  return { $, fire, press, sent, displayed, toasts, complete, box: () => box, edit: (text: string) => { box = text; } };
}
const submit = (text: string): Events["prompt.submit"] => ({ text, origin: { kind: "composer" }, wait: false });

describe("Prompt Enhancer review boundary", () => {
  test("typed ++ enhances into the box instead of sending", async () => {
    const h = harness("add a login opage++");
    const result = await h.fire("prompt.submit", submit(h.box()));
    expect(result).toHaveProperty("drop");
    expect(h.complete).toHaveBeenCalledWith(expect.objectContaining({ model: "haiku", prompt: "add a login opage" }));
    expect(h.box()).toContain("Read the repo first");
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
