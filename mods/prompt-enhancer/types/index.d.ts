import type { BandState, Node } from "../src/api.js";
declare module "claude-code" {
  interface PluginState {
    "prompt-enhancer": { band: BandState };
  }
}
declare global {
  const h: (tag: string | ((props: never) => Node), props: Record<string, unknown> | null, ...children: unknown[]) => Node;
  namespace JSX {
    type Element = Node;
    interface IntrinsicAttributes { key?: string }
    interface ElementChildrenAttribute { children: unknown }
  }
}
