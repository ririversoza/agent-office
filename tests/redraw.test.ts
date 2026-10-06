import { describe, expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'

import { ACTIVITY_FLUSH_MS, BACKGROUND_MAX_MS, backgroundTaskId, endedTasks, externalsFor } from '../hooks/state'

// Flicker and background reviewers. Every state write redraws the pane, and on
// the desktop the office is a sandboxed frame that reloads on each redraw, so
// the mod must not write state that did not change and must not write a label
// per tool call. Reviewers the harness starts with run_in_background return at
// once; their desks stay busy until the task's notification arrives.

const PANE = { plugin: 'agent-office', component: 'Pane', requestId: 'agent-office' } as const
const PANE_PROPS = { title: 'Agent Office', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as const
const CWD = '/tmp/agent-office-redraw/repo'
const PLAN_PATH = `${CWD}/.git/harness/run/plan.json`
const PLAN = JSON.stringify({ goal: 'ship it', tasks: [{ id: 'T1', title: 'tests', status: 'done' }, { id: 'T2', title: 'code', status: 'doing' }] })
const PR_URL = 'https://github.com/acme/webapp/pull/7'
const PR_VIEW = JSON.stringify({ number: 7, title: 'feat: x', url: PR_URL, state: 'OPEN', statusCheckRollup: [] })
const NO_THREADS = JSON.stringify({ data: { viewer: { login: 'me' }, repository: { pullRequest: { reviewThreads: { nodes: [] }, comments: { nodes: [] } } } } })
const PR_REFRESH_MS = 3 * 60_000

type Run = { exitCode: number; stdout: string; stderr: string }

/** The record core's Bash tool returns (as the transcript stores it): a background run carries its task id, not a message. */
type BashRecord = { stdout: string; stderr: string; interrupted: boolean; isImage: boolean; noOutputExpected: boolean; backgroundTaskId?: string }

type World = { clock: MockClock; writes: string[]; bashResult: (command: string, isBackground: boolean) => BashRecord }

/** Answers the nouns the mod calls; records every state write by key. */
function world(on: any, options: { hasPr?: boolean } = {}): World {
  const clock = mock.clock(on, { now: 1_000 })
  mock.store(on, {})
  const w: World = {
    clock,
    writes: [],
    bashResult: (_command, isBackground) => ({
      stdout: isBackground ? '' : 'ok', stderr: '', interrupted: false, isImage: false, noOutputExpected: false,
      ...(isBackground ? { backgroundTaskId: 'bgtask01' } : {}),
    }),
  }
  const run = (argv: readonly string[]): Run => {
    if (argv[0] === 'gh' && argv[1] === 'pr') return options.hasPr ? { exitCode: 0, stdout: PR_VIEW, stderr: '' } : { exitCode: 1, stdout: '', stderr: 'no pull requests found for branch "x"' }
    if (argv[0] === 'gh' && argv[1] === 'api') return { exitCode: 0, stdout: NO_THREADS, stderr: '' }
    return { exitCode: 1, stdout: '', stderr: 'unknown' }
  }
  on('state.set', (_$: unknown, e: { key?: string }, next: (e: unknown) => unknown) => {
    w.writes.push(String(e.key))
    return next(e)
  })
  on('session.cwd', () => ({ value: CWD }))
  on('session.messages', () => ({ value: [] }))
  on('fs.read', (_$: unknown, e: { path: string }) => {
    if (e.path === PLAN_PATH) return { value: PLAN }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('process.run', (_$: unknown, e: { argv: readonly string[] }) => ({ value: { ...run(e.argv), isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'office' } }))
  on('tool.register', (_$: unknown, e: { name: string }) => ({ value: { tool: `mcp__agent-office__${e.name}` } }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [] }))
  on('turn.start', (_$: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('tool.call', { tool: 'Bash' }, (_$: unknown, e: { command: string; run_in_background?: boolean }) => ({ result: w.bashResult(e.command, e.run_in_background === true) }))
  on('tool.call', { tool: 'Read' }, () => ({ result: 'file text' }))
  return w
}

async function startSession($: any, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await w.clock.settle()
}

/** Every desk line the terminal pane draws, joined by newlines. */
async function desks($: any): Promise<string> {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return texts.map((t: { text: string }) => t.text).join('\n')
}

const countOf = (writes: readonly string[], key: string) => writes.filter(k => k === key).length

/**
 * Delivers a background task's notification row. The kit keeps no transcript,
 * so the append itself rejects once the hooks above it have run; the mod reads
 * the row before storing it, which is what this exercises.
 */
async function notify($: any, taskId: string, status: string): Promise<void> {
  const text = `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n<summary>Background command completed</summary>\n</task-notification>`
  const row = { message: { type: 'user', role: 'user', isMeta: true, content: [{ type: 'text', text }] }, door: 'delivery', origin: { kind: 'task-notification' } }
  await $.session.append(row).catch(() => undefined)
}

describe('redraws', () => {
  test('following an unchanged plan.json writes nothing after the first draw', async ($, on) => {
    const w = world(on)
    await startSession($, w)
    await $.tool.call({ tool: 'mcp__agent-office__checklist', planFile: PLAN_PATH })
    await w.clock.settle()
    const before = countOf(w.writes, 'checklist')
    await w.clock.advance(30_000)
    await w.clock.settle()
    expect(countOf(w.writes, 'checklist') - before, 'checklist writes while the plan file stayed the same').toBe(0)
  })

  test('an unchanged PR refresh writes nothing', async ($, on) => {
    const w = world(on, { hasPr: true })
    await startSession($, w)
    const before = countOf(w.writes, 'pr')
    await w.clock.advance(PR_REFRESH_MS * 3)
    await w.clock.settle()
    expect(countOf(w.writes, 'pr') - before, 'pr writes while the PR stayed the same').toBe(0)
  })

  test('a burst of tool calls is drawn as one activity update, not two writes per call', async ($, on) => {
    const w = world(on)
    await startSession($, w)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await w.clock.settle()
    const before = countOf(w.writes, 'workers')
    for (let i = 0; i < 10; i++) await $.tool.call({ tool: 'Read', file_path: `/repo/src/f${i}.ts` })
    await w.clock.advance(ACTIVITY_FLUSH_MS)
    await w.clock.settle()
    expect(countOf(w.writes, 'workers') - before, 'workers writes for ten quick tool calls').toBeLessThanOrEqual(2)
    expect(await desks($)).toMatch(/lead — reading f9\.ts/)
  })
})

describe('background reviewers', () => {
  test('a background Codex review keeps the Codex desk busy until its task notification', async ($, on) => {
    const w = world(on)
    await startSession($, w)
    await $.tool.call({ tool: 'Bash', command: '~/.claude/bin/codex-diff-review "$RUN/plan.json" abc123', run_in_background: true })
    await w.clock.advance(60_000)
    await w.clock.settle()
    expect(await desks($)).toMatch(/codex[^\n]*— reviewing diff/)
    await notify($, 'bgtask01', 'completed')
    await w.clock.settle()
    expect(await desks($)).not.toMatch(/codex[^\n]*— reviewing diff/)
  })

  test('a notification for another task leaves the desk busy', async ($, on) => {
    const w = world(on)
    await startSession($, w)
    await $.tool.call({ tool: 'Bash', command: '~/.claude/bin/cursor-review plan.json abc', run_in_background: true })
    await notify($, 'othertask', 'completed')
    await w.clock.settle()
    expect(await desks($)).toMatch(/cursor[^\n]*— reviewing diff/)
  })

  test('one background command running all three reviewers lights all three desks', async ($, on) => {
    const w = world(on)
    await startSession($, w)
    const command = '~/.claude/bin/claude-work-review p b > c.md & ~/.claude/bin/cursor-review p b > g.md & ~/.claude/bin/codex-diff-review p b > x.md & wait'
    await $.tool.call({ tool: 'Bash', command, run_in_background: true })
    await w.clock.settle()
    const text = await desks($)
    expect(text).toMatch(/codex[^\n]*— reviewing diff/)
    expect(text).toMatch(/cursor[^\n]*— reviewing diff/)
    expect(text).toMatch(/reviewer[^\n]*— reviewing diff/)
  })

  test('a background desk is released after the longest background run even without a notification', async ($, on) => {
    const w = world(on)
    await startSession($, w)
    await $.tool.call({ tool: 'Bash', command: '~/.claude/bin/codex-diff-review p b', run_in_background: true })
    await w.clock.advance(BACKGROUND_MAX_MS + 10_000)
    await w.clock.settle()
    expect(await desks($)).not.toMatch(/codex[^\n]*— reviewing diff/)
  })

  test('a foreground reviewer still goes back to its desk when the call returns', async ($, on) => {
    const w = world(on)
    await startSession($, w)
    await $.tool.call({ tool: 'Bash', command: '~/.claude/bin/cursor-review plan.json abc' })
    await w.clock.settle()
    expect(await desks($)).not.toMatch(/cursor[^\n]*— reviewing diff/)
  })

  test('work-account agents get a desk per task while they run', async ($, on) => {
    const w = world(on)
    await startSession($, w)
    const command = '~/.claude/bin/claude-work-agent harness-implementer --run "$RUN" --task T7 --prompt-file p7.md --cwd "$REPO" > o7 2>&1 & ~/.claude/bin/claude-work-agent harness-worker --run "$RUN" --task T8 --prompt-file p8.md > o8 2>&1 & wait'
    await $.tool.call({ tool: 'Bash', command, run_in_background: true })
    await w.clock.settle()
    const text = await desks($)
    expect(text).toMatch(/implementer[^\n]*— T7/)
    expect(text).toMatch(/worker[^\n]*— T8/)
    await notify($, 'bgtask01', 'completed')
    await w.clock.settle()
    expect(await desks($)).not.toMatch(/— T7|— T8/)
  })
})

describe('externalsFor', () => {
  test('recognises the harness reviewers and work agents, once each', () => {
    expect(externalsFor('Bash', { command: '~/.claude/bin/codex-diff-review plan.json abc' }).map(x => [x.id, x.task])).toEqual([['codex', 'reviewing diff']])
    expect(externalsFor('Bash', { command: '~/.claude/bin/harness-codex -C /r -o o.md "p"' }).map(x => x.task)).toEqual(['verifying plan'])
    const all = externalsFor('Bash', { command: 'claude-work-review a b & cursor-review a b & codex-diff-review a b & wait' }).map(x => x.id).sort()
    expect(all).toEqual(['codex', 'cursor', 'work-review'])
    const agents = externalsFor('Bash', { command: 'claude-work-agent harness-test-writer --run R --task T15 --prompt-file p' })
    expect(agents.map(x => [x.id, x.task, x.desk?.name, x.desk?.kind])).toEqual([['work:T15', 'T15', 'test-writer', 'opus']])
    expect(externalsFor('Bash', { command: 'claude-work-agent harness-worker --run R --task T3' })[0]?.desk?.kind).toBe('sonnet')
    expect(externalsFor('Bash', { command: 'echo codex-diff-reviews; git status' })).toEqual([])
    expect(externalsFor('Read', { file_path: '/x/codex-diff-review' })).toEqual([])
  })
})

describe('background task ids', () => {
  test('reads the id from core\'s Bash record, the model\'s text, or finds none', () => {
    // As the transcript stores a real background run's record.
    const record = { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: 'bdglqc769' }
    expect(backgroundTaskId({ result: record })).toBe('bdglqc769')
    expect(backgroundTaskId({ result: { stdout: '' }, text: 'Command running in background with ID: b61byqww2. Output is being written to: /tmp/t.output' })).toBe('b61byqww2')
    expect(backgroundTaskId({ result: { stdout: 'done', stderr: '', interrupted: false } })).toBe(undefined)
  })

  test('reads ended tasks from a real notification row', () => {
    const text = '<task-notification>\n<task-id>b61byqww2</task-id>\n<tool-use-id>toolu_01</tool-use-id>\n<output-file>/tmp/b61byqww2.output</output-file>\n<status>completed</status>\n<summary>Background command done</summary>\n</task-notification>'
    expect(endedTasks(text)).toEqual([{ id: 'b61byqww2', isFailed: false }])
    expect(endedTasks(text.replace('completed', 'killed'))).toEqual([{ id: 'b61byqww2', isFailed: true }])
    expect(endedTasks('no notification here')).toEqual([])
  })
})
