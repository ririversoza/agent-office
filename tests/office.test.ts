import { describe, expect, mock, test } from 'claude-code/testing'

import type { Worker } from '../types'
import { officeSize, paneLayout, renderOffice } from '../hooks/scene'
import {
  DONE_LINGER_MS,
  LEAD_ID,
  MAX_TEAM_DESKS,
  activityFor,
  clearActivity,
  externalFor,
  kindOfModel,
  patch,
  prune,
  reconcile,
} from '../hooks/state'

const PANE = { plugin: 'agent-office', component: 'Pane', requestId: 'agent-office' } as const
const PANE_PROPS = { title: 'Agent Office', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } } as const

function sub(id: string, fields: Partial<Worker> = {}): Worker {
  return { id, name: 'worker', kind: 'sonnet', model: 'sonnet', task: '', activity: '', status: 'working', changedAt: 0, ...fields }
}

describe('state', () => {
  test('labels tool calls with what the agent is doing', () => {
    expect(activityFor('Edit', { file_path: '/repo/src/auth.ts' })).toBe('editing auth.ts')
    expect(activityFor('Grep', {})).toBe('searching')
    expect(activityFor('mcp__codex__codex', {})).toBe('asking Codex')
  })

  test('recognises Codex and Cursor calls, and nothing else', () => {
    expect(externalFor('mcp__codex__codex', { prompt: 'You are verifying an implementation plan' })?.task).toBe('verifying plan')
    expect(externalFor('Bash', { command: '~/.claude/bin/cursor-review plan.md abc' })?.id).toBe('cursor')
    expect(externalFor('Bash', { command: 'codex exec -s read-only "review"' })?.id).toBe('codex')
    expect(externalFor('Bash', { command: '~/.claude/bin/codex-sol -C /repo -o out.md "plan"' })?.id).toBe('codex')
    expect(externalFor('Bash', { command: '~/.claude/bin/codex-sol resume abc -o r2.md "x"' })?.task).toBe('verifying plan')
    expect(externalFor('Bash', { command: 'echo codex-solid' })).toBe(undefined)
    expect(externalFor('Bash', { command: '~/.claude/bin/harness-codex -C /repo -o out.md "plan"' })?.task).toBe('verifying plan')
    expect(externalFor('Bash', { command: '~/.claude/bin/harness-codex resume abc -o r2.md "x"' })?.id).toBe('codex')
    expect(externalFor('Bash', { command: 'echo harness-codexes' })).toBe(undefined)
    const work = externalFor('Bash', { command: '~/.claude/bin/claude-work-review "$RUN/plan.md" abc123' })
    expect(work?.id).toBe('work-review')
    expect(work?.desk?.kind).toBe('opus')
    expect(work?.doneStatus).toBe('done')
    expect(externalFor('Bash', { command: '~/.claude/bin/cursor-review plan.md' })?.doneStatus).toBe('idle')
    expect(externalFor('Bash', { command: 'git status' })).toBe(undefined)
  })

  test('maps resolved model ids to desk colours', () => {
    expect(kindOfModel('claude-opus-5-5')).toBe('opus')
    expect(kindOfModel('claude-sonnet-5-5')).toBe('sonnet')
    expect(kindOfModel(undefined)).toBe('agent')
  })

  test('patch stamps changedAt only when the status changes, without mutating', () => {
    const list = [sub('a', { changedAt: 5 })]
    const sameStatus = patch(list, 'a', { activity: 'reading' }, 99)
    const newStatus = patch(list, 'a', { status: 'done' }, 99)
    expect(sameStatus[0]?.changedAt).toBe(5)
    expect(newStatus[0]?.changedAt).toBe(99)
    expect(list[0]?.status).toBe('working')
  })

  test('clearActivity leaves a label set by a later call alone', () => {
    const list = [sub('a', { activity: 'editing b.ts' })]
    expect(clearActivity(list, 'a', 'reading a.ts')[0]?.activity).toBe('editing b.ts')
    expect(clearActivity(list, 'a', 'editing b.ts')[0]?.activity).toBe('')
  })

  test('prune clears finished desks after they linger and caps the team', () => {
    const list = [patch([], LEAD_ID, {}, 0)[0] as Worker, sub('old', { status: 'done', changedAt: 0 }), sub('live')]
    expect(prune(list, DONE_LINGER_MS + 1).map(w => w.id)).toEqual([LEAD_ID, 'live'])

    const crowd = Array.from({ length: MAX_TEAM_DESKS + 3 }, (_, i) => sub(`d${i}`, { status: 'done', changedAt: i }))
    const kept = prune(crowd, 1)
    expect(kept).toHaveLength(MAX_TEAM_DESKS)
    expect(kept[0]?.id).toBe('d3')
  })

  test('reconcile finishes subagents the engine reports as stopped', () => {
    const list = [sub('a'), sub('b'), sub('c')]
    const next = reconcile(list, [{ id: 'a', status: 'completed' }, { id: 'b', status: 'killed' }, { id: 'c', status: 'running' }], 7)
    expect(next.map(w => w.status)).toEqual(['done', 'failed', 'working'])
  })
})

describe('scene', () => {
  test('a full office stays under the Svg size limit with room to spare', () => {
    const SVG_LIMIT = 131072
    const team = Array.from({ length: MAX_TEAM_DESKS }, (_, i) => sub(`a${i}`, { activity: 'editing something.ts' }))
    expect(renderOffice(team).length < SVG_LIMIT * 0.75).toBe(true)
  })

  test('sizes the office to the pane: 3 desks docked, up to 6 maximised', () => {
    const docked = paneLayout(55)
    const maximised = paneLayout(181)
    expect(docked.cols).toBe(3)
    expect(docked.widthPx > 420 && docked.widthPx < 460).toBe(true)
    expect(maximised.cols).toBe(6)
    expect(paneLayout(10).widthPx).toBe(320)
  })

  test('office size keeps the drawing proportions for the box', () => {
    const team = Array.from({ length: 7 }, (_, i) => sub(`s${i}`))
    const size = officeSize(team, 6)
    expect(renderOffice(team, 6).includes(`viewBox="0 0 ${size.width} ${size.height}"`)).toBe(true)
  })

  test('narrow panes get a 3-desk-wide office that still fits the top row', () => {
    const team = Array.from({ length: 4 }, (_, i) => sub(`n${i}`))
    expect(renderOffice(team, 3).includes('viewBox="0 0 144 ')).toBe(true)
    expect(renderOffice(team, 4).includes('viewBox="0 0 192 ')).toBe(true)
  })

  test('escapes names so they cannot break the markup', () => {
    const svg = renderOffice([sub('x', { name: '<script>' })])
    expect(svg.includes('<script>')).toBe(false)
  })
})

describe('pane', () => {
  test('shows the lead working once a turn starts, on terminal and desktop', async ($, on) => {
    mock.clock(on, { now: 1_000 })
    on('turn.start', (_$, e) => ({ turnId: e.turnId }))
    await $.turn.start({ text: 'build it', turnId: 't1' })

    const terminal = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
    expect(await terminal.find({ type: 'Text', text: /lead — thinking/ })).toBeDefined()
    await terminal.unmount()

    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop', props: PANE_PROPS })
    expect(await desktop.find({ type: 'Svg' })).toBeDefined()
    await desktop.unmount()
  })
})
