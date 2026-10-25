/**
 * prompt/goal-tracker and prompt/worktree-advisory-consumer run inside
 * prompt/unified-dispatcher (one node spawn per prompt, 15 s budget) instead of
 * as two separate sync UserPromptSubmit hooks that each timed out at 5 s under
 * load. These pin that the fold keeps both hooks' behaviour identical:
 *   - goal-tracker: records the /goal start, and its budget brake still BLOCKS
 *     the prompt with the same message (the dispatcher must not reduce a block
 *     to context).
 *   - worktree-advisory-consumer: the pending advisory reaches the model in
 *     full and is deleted, whatever the dispatcher's prompt guards, effort
 *     budget, noise filter or delta skip would otherwise drop.
 * Real filesystem (os.tmpdir); only the dispatcher's other sub-hooks and the
 * session-identity spawn are mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const guards = vi.hoisted(() => ({ binary: false, max: 100000 }));
const effort = vi.hoisted(() => ({ level: 'high', budget: 50000 }));

vi.mock('../../lib/prompt-guards.js', () => ({
  isImageOrBinaryPrompt: () => guards.binary,
  get MAX_PROMPT_LENGTH() { return guards.max; },
}));
vi.mock('../../lib/effort-detector.js', () => ({
  detectEffortLevel: () => effort.level,
  effortTokenBudget: () => effort.budget,
  DEFAULT_EFFORT_LEVEL: 'high',
}));
vi.mock('../../lib/session-identity-state.js', () => ({
  manageSessionIdentity: () => null,
  resolveTranscriptPath: () => null,
}));
const silent = vi.hoisted(() => () => ({ continue: true, suppressOutput: true }));
vi.mock('../../prompt/handoff-injector.js', () => ({ handoffInjector: silent }));
vi.mock('../../prompt/frustration-detector.js', () => ({ frustrationDetector: silent }));
vi.mock('../../prompt/cache-break-detector.js', () => ({ cacheBreakDetector: silent }));
vi.mock('../../prompt/executor-route-nudge.js', () => ({ executorRouteNudge: silent }));
vi.mock('../../prompt/visual-style-nudge.js', () => ({ visualStyleNudge: silent }));
vi.mock('../../prompt/multi-step-task-nudge.js', () => ({ multiStepTaskNudge: silent }));

import { unifiedPromptDispatcher, registeredHookNames } from '../../prompt/unified-dispatcher.js';
import { goalTracker } from '../../prompt/goal-tracker.js';
import { writeWorktreeAdvisory } from '../../lib/worktree-advisory.js';
import type { HookInput } from '../../types.js';
import { createTestContext } from '../fixtures/test-context.js';

let tmp: string;
const SID = 'sess-fold';

function input(prompt: string): HookInput {
  return { tool_name: 'UserPromptSubmit', session_id: SID, tool_input: {}, project_dir: tmp, prompt };
}
function ctx() {
  return createTestContext({ projectDir: tmp, sessionId: SID });
}
function context(result: ReturnType<typeof unifiedPromptDispatcher>): string {
  return (result.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? '';
}
function history(): Array<Record<string, unknown>> {
  const file = join(tmp, '.claude', 'state', 'goal-history.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
}
function tripBrake(sessionId: string): void {
  const dir = join(tmp, '.claude', 'state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'goal-budget-tripped.json'),
    JSON.stringify({ tripped_at: '2026-10-25T12:00:00Z', session_id: sessionId, turns: 40, tokens: 900000, reason: 'turns_cap' }),
  );
}
function pendingAdvisories(): string[] {
  const dir = join(tmp, '.claude', 'state');
  return existsSync(dir) ? readdirSync(dir).filter(f => f.startsWith('worktree-advisory-')) : [];
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dispatcher-fold-'));
  delete process.env.CLAUDE_PLUGIN_DATA;
  guards.binary = false;
  guards.max = 100000;
  effort.level = 'high';
  effort.budget = 50000;
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('registry', () => {
  it('the dispatcher runs goal-tracker and worktree-advisory-consumer', () => {
    expect(registeredHookNames()).toEqual(expect.arrayContaining(['goal-tracker', 'worktree-advisory-consumer']));
  });

  it('hooks.json no longer spawns either as its own UserPromptSubmit hook', () => {
    const hooksJson = JSON.parse(readFileSync(resolve(__dirname, '../../../hooks.json'), 'utf8'));
    const ids: string[] = hooksJson.hooks.UserPromptSubmit
      .flatMap((g: { hooks: Array<{ args?: string[] }> }) => g.hooks)
      .map((h: { args?: string[] }) => h.args?.[1] ?? '');
    expect(ids).toContain('prompt/unified-dispatcher');
    expect(ids).not.toContain('prompt/goal-tracker');
    expect(ids).not.toContain('prompt/worktree-advisory-consumer');
  });
});

describe('goal-tracker inside the dispatcher', () => {
  it('records the /goal start in goal-history.jsonl', () => {
    unifiedPromptDispatcher(input('/goal until the tests pass'), ctx());
    const rows = history();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ session_id: SID, condition: 'until the tests pass', ended_at: null });
  });

  it('writes nothing for a prompt without /goal', () => {
    unifiedPromptDispatcher(input('fix the flaky test'), ctx());
    expect(history()).toHaveLength(0);
  });

  it('blocks with the same result the standalone hook returns when this session tripped the brake', () => {
    tripBrake(SID);
    const standalone = goalTracker(input('/goal until done'), ctx());
    const folded = unifiedPromptDispatcher(input('/goal until done'), ctx());
    expect(standalone.continue).toBe(false);
    expect(folded).toEqual(standalone);
    expect(history()).toHaveLength(0);
  });

  it('ignores a brake another session tripped', () => {
    tripBrake('someone-else');
    const result = unifiedPromptDispatcher(input('/goal until done'), ctx());
    expect(result.continue).not.toBe(false);
    expect(history()).toHaveLength(1);
  });

  it('still records /goal when the prompt guards skip the other hooks', () => {
    guards.max = 10;
    unifiedPromptDispatcher(input('/goal until the oversized prompt is handled'), ctx());
    expect(history()).toHaveLength(1);
  });
});

describe('worktree-advisory-consumer inside the dispatcher', () => {
  const ADVISORY = 'Worktree feat-x is a monorepo checkout: set sparsePaths to the package you touch.';

  it('injects a pending advisory for this session and deletes it', () => {
    writeWorktreeAdvisory(ADVISORY, 'feat-x', tmp, SID);
    const result = unifiedPromptDispatcher(input('carry on'), ctx());
    expect(context(result)).toContain(ADVISORY);
    expect(pendingAdvisories()).toHaveLength(0);
  });

  it('leaves another session\'s advisory on disk', () => {
    writeWorktreeAdvisory(ADVISORY, 'feat-x', tmp, 'other-session');
    const result = unifiedPromptDispatcher(input('carry on'), ctx());
    expect(context(result)).not.toContain(ADVISORY);
    expect(pendingAdvisories()).toHaveLength(1);
  });

  it('delivers the advisory in full past the effort token budget', () => {
    effort.level = 'low';
    effort.budget = 1;
    writeWorktreeAdvisory(ADVISORY, 'feat-x', tmp, SID);
    expect(context(unifiedPromptDispatcher(input('carry on'), ctx()))).toContain(ADVISORY);
  });

  it('delivers the advisory when the prompt guards skip the other hooks', () => {
    guards.max = 3;
    writeWorktreeAdvisory(ADVISORY, 'feat-x', tmp, SID);
    expect(context(unifiedPromptDispatcher(input('carry on'), ctx()))).toContain(ADVISORY);
    expect(pendingAdvisories()).toHaveLength(0);
  });

  it('delivers the same advisory text again on a later prompt (no delta skip)', () => {
    writeWorktreeAdvisory(ADVISORY, 'feat-x', tmp, SID);
    expect(context(unifiedPromptDispatcher(input('one'), ctx()))).toContain(ADVISORY);
    writeWorktreeAdvisory(ADVISORY, 'feat-x', tmp, SID);
    expect(context(unifiedPromptDispatcher(input('two'), ctx()))).toContain(ADVISORY);
  });
});
