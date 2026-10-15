import type { BandState, Dollar, On } from "../src/api.js";
import { SYSTEM } from "../src/system.js";

const BAND = { plugin: "prompt-enhancer", key: "band" } as const;
const INITIAL: BandState = { visible: true, collapsed: false, busy: false, original: null };

interface Control { request: number; enhancing: boolean; sending: boolean; expectedDraft: string }

const read = async ($: Dollar): Promise<BandState> => (await $.state.get(BAND)).value ?? { ...INITIAL };
const patch = async ($: Dollar, fields: Partial<BandState>): Promise<void> => {
  await $.state.set(BAND, { ...await read($), ...fields });
};

const enhance = async ($: Dollar, c: Control, original: string, restore: boolean): Promise<void> => {
  if (c.enhancing || c.sending) {
    await $.ui.toast("Wait for the current action to finish.");
    return;
  }
  const draft = original.endsWith("++") ? original.slice(0, -2) : original;
  if (!draft.trim()) {
    if (restore) await $.prompt.fill({ text: original });
    await $.ui.toast("Type a prompt before using Enhance.");
    return;
  }
  const id = ++c.request;
  c.enhancing = true;
  c.expectedDraft = original;
  try {
    await patch($, { visible: true, collapsed: false, busy: true });
    if (restore) {
      const current = await $.prompt.read();
      if (current.text !== "" && current.text !== original) {
        await $.ui.toast("The draft changed. Kept your edit.");
        return;
      }
      if (!(await $.prompt.fill({ text: original })).isFilled) {
        await $.ui.toast("The prompt box is unavailable. Nothing was sent.");
        return;
      }
    }
    const before = await read($);
    await patch($, { original: before.original ?? original });
    const result = await $.model.complete({
      model: "haiku", system: SYSTEM, prompt: draft,
      maxTokens: 1024, effort: "low", timeoutMs: 12000,
    });
    if (id !== c.request) return;
    if (!result.isAnswered || !result.text?.trim()) {
      await $.ui.toast("Enhance failed. Kept your original prompt.");
      return;
    }
    if ((await $.prompt.read()).text !== original) {
      await $.ui.toast("The draft changed. Kept your edit.");
      return;
    }
    c.expectedDraft = result.text;
    if (!(await $.prompt.fill({ text: result.text })).isFilled) {
      await $.ui.toast("The prompt box could not take the rewrite. Nothing was sent.");
    }
  } catch {
    if (id === c.request) await $.ui.toast("Enhance failed. Kept your original prompt.");
  } finally {
    if (id === c.request) {
      c.enhancing = false;
      await patch($, { busy: false });
    }
  }
};

const undo = async ($: Dollar, c: Control): Promise<void> => {
  const state = await read($);
  if (state.original === null || c.sending) return;
  c.request += 1;
  c.enhancing = false;
  c.expectedDraft = state.original;
  if ((await $.prompt.fill({ text: state.original })).isFilled) {
    await patch($, { original: null, busy: false });
  } else {
    await patch($, { busy: false });
    await $.ui.toast("Undo could not write the prompt box. Nothing was sent.");
  }
};

const send = async ($: Dollar, c: Control): Promise<void> => {
  if (c.enhancing || c.sending) {
    await $.ui.toast("Wait for Enhance to finish before sending.");
    return;
  }
  c.sending = true;
  try {
    const { text } = await $.prompt.read();
    if (!text.trim()) return;
    const result = await $.prompt.submit({ text, asUser: true });
    if (result.drop !== undefined) {
      await $.ui.toast("The prompt was not sent. Kept the draft.");
      return;
    }
    await patch($, { original: null });
    if ((await $.prompt.read()).text === text) await $.prompt.fill({ text: "" });
  } catch {
    await $.ui.toast("Send failed. Kept the draft.");
  } finally {
    c.sending = false;
  }
};


export const register = (on: On): void => {
  const c: Control = { request: 0, enhancing: false, sending: false, expectedDraft: "" };
  on("prompt.submit", async ($, e, next) => {
    if (e.origin.kind !== "composer" || e.command || e.attachments?.length) return next(e);
    if (c.enhancing || c.sending) {
      if (!(await $.prompt.read()).text) await $.prompt.fill({ text: e.text });
      await $.ui.toast("Wait for the current action to finish.");
      return { drop: "Prompt held for review." };
    }
    if (e.text.endsWith("++")) {
      await enhance($, c, e.text, true);
      return { drop: "Prompt held for review. Edit it, then use Send or Enter." };
    }
    const result = await next(e);
    if (!(result && typeof result === "object" && "drop" in result)) await patch($, { original: null });
    return result;
  }).catch(async ($, e, next) => {
    if (next.called) return next(e);
    c.request += 1;
    c.enhancing = false;
    const current = await $.prompt.read().catch(() => null);
    if (current?.text === "") await $.prompt.fill({ text: e.text }).catch(() => undefined);
    await $.ui.toast("Prompt Enhancer failed. Nothing was sent.").catch(() => undefined);
    return { drop: "Prompt held because Prompt Enhancer failed." };
  });

  on("prompt.change", async ($, e, next) => {
    if (c.enhancing && e.text !== c.expectedDraft && e.origin.kind !== "clear") {
      c.request += 1;
      c.enhancing = false;
      await patch($, { busy: false });
    }
    return next(e);
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const state = await read($);
    if (e.props.hasSurvey || !state.visible) return next(e);
    const { Box, Text, Button } = $.ui.resolve(e);
    return (
      <Box flexDirection="column">
        <Box>
          <Text>✨ Prompt Enhancer </Text>
          <Button key="collapse" label={state.collapsed ? "+" : "-"} onPress={async () => patch($, { collapsed: !(await read($)).collapsed })} />
        </Box>
        {!state.collapsed && <Box flexDirection="column">
          <Box>
            <Button key="enhance" label="Enhance" onPress={async () => enhance($, c, (await $.prompt.read()).text, false)} />
            <Button key="undo" label="Undo" onPress={() => undo($, c)} />
            <Button key="send" label="Send" onPress={() => send($, c)} />
          </Box>
          <Text dimColor>Enhanced below: edit it, then Send (or Enter). Undo puts your original back.</Text>
          {state.busy && <Text dimColor>Enhancing...</Text>}
        </Box>}
      </Box>
    );
  });
};
