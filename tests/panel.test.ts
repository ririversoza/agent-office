import { describe, expect, mock, test } from 'claude-code/testing'

import { renderPanel } from '../hooks/boards'
import {
  adoptReplyChecklist,
  applyUpdates,
  checklistContext,
  latestReplyChecklist,
  parseChecklist,
  planToChecklist,
  readUpdates,
  textOf,
  withoutCodeFences,
} from '../hooks/checklist'
import { wrapText } from '../hooks/pixels'
import type { ThreadsResponse } from '../hooks/pr'
import { findPrUrl, prUrlFromResult, summarizeCi, summarizeThreads, viewArgv, viewError } from '../hooks/pr'

const PASTE = [
  "let's work through this checklist:",
  '',
  '## Discord PR review',
  '- [x] Keep the gateway in Penthouse',
  '- [ ] T3 #5041 link fixes',
  '- [ ] Run jest, tsc and eslint',
  'thanks',
].join('\n')

const PANE = { plugin: 'agent-office', component: 'Pane', requestId: 'agent-office' } as const
const PANE_PROPS = { title: 'Agent Office', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as const

describe('checklist parsing', () => {
  test('reads items, their ticks, and the heading above them', () => {
    const list = parseChecklist(PASTE, 1)
    expect(list?.title).toBe('Discord PR review')
    expect(list?.items.map(i => i.status)).toEqual(['done', 'todo', 'todo'])
    expect(list?.items[1]?.text).toBe('T3 #5041 link fixes')
  })

  test('ignores prompts without a real checklist', () => {
    expect(parseChecklist('- [ ] just one thing', 1)).toBe(null)
    expect(parseChecklist('- plain bullet\n- another', 1)).toBe(null)
  })

  test('validates tool updates against the list', () => {
    expect(readUpdates({ updates: [{ item: 4, status: 'done' }] }, 3)).toBe('Item numbers run from 1 to 3.')
    expect(readUpdates({ updates: [{ item: 1, status: 'finished' }] }, 3)).toBe('Status must be one of: todo, doing, done.')
    expect(readUpdates({ updates: [{ item: 2, status: 'doing' }] }, 3)).toEqual([{ item: 2, status: 'doing' }])
  })

  test('applies updates without mutating the original', () => {
    const list = parseChecklist(PASTE, 1)
    if (!list) throw new Error('expected a checklist')
    const next = applyUpdates(list, [{ item: 2, status: 'done' }], 9)
    expect(next.items[1]?.status).toBe('done')
    expect(list.items[1]?.status).toBe('todo')
    expect(next.updatedAt).toBe(9)
  })

  test("picks up checklists in Claude's replies, but not ones inside code blocks", () => {
    const reply = textOf([
      { type: 'thinking', thinking: '- [ ] not this' },
      { type: 'text', text: 'Plan:\n- [ ] T1 split runner tests\n- [ ] T2 proxy test lines' },
    ])
    const found = parseChecklist(withoutCodeFences(reply), 5, 'assistant')
    expect(found?.items.length).toBe(2)
    expect(found?.isAnnounced).toBe(false)
    const example = 'Like this:\n```md\n- [ ] example one\n- [ ] example two\n```\nDone.'
    expect(parseChecklist(withoutCodeFences(example), 5, 'assistant')).toBe(null)
  })

  test('a restated list syncs ticks; a different list replaces it and needs announcing', () => {
    const pasted = parseChecklist(PASTE, 1)
    if (!pasted) throw new Error('expected a checklist')
    const restated = parseChecklist(PASTE.replace('- [ ] T3', '- [x] T3'), 7, 'assistant')
    if (!restated) throw new Error('expected a checklist')
    const synced = adoptReplyChecklist(pasted, restated)
    expect(synced.items[1]?.status).toBe('done')
    expect(synced.source).toBe('user')
    expect(synced.isAnnounced).toBe(true)

    const other = parseChecklist('- [ ] write docs\n- [ ] ship', 9, 'assistant')
    if (!other) throw new Error('expected a checklist')
    const replaced = adoptReplyChecklist(pasted, other)
    expect(replaced.items[0]?.text).toBe('write docs')
    expect(replaced.isAnnounced).toBe(false)
    expect(checklistContext(replaced).startsWith('The checklist from your last reply')).toBe(true)
  })

  test('tells the model the numbered items and the tool to call', () => {
    const list = parseChecklist(PASTE, 1)
    if (!list) throw new Error('expected a checklist')
    const note = checklistContext(list)
    expect(note.includes('mcp__agent-office__checklist')).toBe(true)
    expect(note.includes('#2 [ ] T3 #5041 link fixes')).toBe(true)
    // The note itself must never read as a checklist, or it would be re-adopted.
    expect(parseChecklist(note, 2)).toBe(null)
  })

  test('finds a reply checklist written since the last user message, and nothing older', () => {
    const plan = '## Plan: sweep\n- [ ] T1 PR #22\n- [ ] T2 PR #21'
    const reply = latestReplyChecklist([
      { role: 'user', text: PASTE },
      { role: 'assistant', text: `Here is the plan:\n\n${plan}` },
      { role: 'assistant', text: 'Dispatching the first batch.' },
    ], 3)
    expect(reply?.title).toBe('Plan: sweep')
    expect(reply?.source).toBe('assistant')

    expect(latestReplyChecklist([{ role: 'assistant', text: plan }, { role: 'user', text: PASTE }], 3)).toBe(null)
    // An old reply list behind any later message from the user's side never comes back.
    expect(latestReplyChecklist([{ role: 'assistant', text: plan }, { role: 'user', text: 'thanks, next task' }], 3)).toBe(null)
    expect(latestReplyChecklist([{ role: 'assistant', text: plan }, { role: 'user', text: '' }, { role: 'assistant', text: 'ok' }], 3)?.title).toBe('Plan: sweep')
    expect(latestReplyChecklist([{ role: 'assistant', text: '```\n- [ ] a\n- [ ] b\n```' }], 3)).toBe(null)
  })
})

describe('PR summary', () => {
  test('rolls CI checks up into one state', () => {
    expect(summarizeCi([])).toBe('none')
    expect(summarizeCi([{ conclusion: 'SUCCESS' }, { state: 'SUCCESS' }])).toBe('passing')
    expect(summarizeCi([{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: null }])).toBe('running')
    expect(summarizeCi([{ conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }])).toBe('failing')
  })

  test('counts unresolved threads and new comments by others since last look', () => {
    const response: ThreadsResponse = {
      data: {
        viewer: { login: 'octocat' },
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                { isResolved: false, comments: { nodes: [{ author: { login: 'rev' }, path: 'gateway.ts', line: 118, body: 'Same bug, new path', createdAt: '2026-10-03T16:20:00Z' }] } },
                { isResolved: false, comments: { nodes: [{ author: { login: 'rev' }, path: 'runner.ts', line: 12, body: 'Older', createdAt: '2026-10-03T09:00:00Z' }] } },
                { isResolved: true, comments: { nodes: [{ author: { login: 'rev' }, body: 'Fixed', createdAt: '2026-10-03T16:30:00Z' }] } },
                {
                  isResolved: false,
                  comments: {
                    nodes: [
                      { author: { login: 'rev' }, path: 'schema.ts', line: 3, body: 'Why nullable?', createdAt: '2026-10-03T08:00:00Z' },
                      { author: { login: 'octocat' }, path: 'schema.ts', line: 3, body: 'Legacy rows', createdAt: '2026-10-03T16:50:00Z' },
                    ],
                  },
                },
              ],
            },
            comments: { nodes: [{ author: { login: 'octocat' }, body: 'my own reply', createdAt: '2026-10-03T16:40:00Z' }] },
          },
        },
      },
    }
    const seenAt = Date.parse('2026-10-03T16:10:00Z')
    const summary = summarizeThreads(response, seenAt)
    expect(summary.unresolved).toBe(3)
    expect(summary.needReply).toBe(2)
    expect(summary.newCount).toBe(2)
    expect(summary.latest?.path).toBe('gateway.ts')
    expect(summary.latest?.line).toBe(118)
  })

  test('follows PR links in prompts and PRs that commands touched', () => {
    const url = 'https://github.com/acme/webapp/pull/5206'
    expect(findPrUrl(`can you check ${url}#discussion_r1 again`)).toBe(url)
    expect(findPrUrl('no link here')).toBe(null)
    expect(prUrlFromResult({ stdout: '', gitOperation: { pr: { number: 5206, url, action: 'commented' } } })).toBe(url)
    expect(prUrlFromResult({ stdout: '', gitOperation: { push: { branch: 'x' } } })).toBe(null)
    expect(prUrlFromResult(undefined)).toBe(null)
    expect(viewArgv(url).slice(0, 4)).toEqual(['gh', 'pr', 'view', url])
    expect(viewArgv(null)[3]).toBe('--json')
  })

  test('a branch with no PR is not an error', () => {
    expect(viewError('no pull requests found for branch "main"')).toBe(null)
    expect(viewError('HTTP 401: Bad credentials')).toBe('HTTP 401: Bad credentials')
  })
})

describe('combined pane', () => {
  test('a pasted checklist shows in the pane and the tool ticks items off', async ($, on) => {
    mock.clock(on, { now: 1_000 })
    let seenContext: readonly string[] = []
    on('prompt.submit', (_$, e) => {
      seenContext = e.context ?? []
      return { text: e.text }
    })
    await $.prompt.submit({ text: PASTE })
    expect(seenContext.some(c => c.includes('mcp__agent-office__checklist'))).toBe(true)

    const answer = await $.tool.call({ tool: 'mcp__agent-office__checklist', updates: [{ item: 2, status: 'done' }] })
    expect(String(answer.result).includes('[x] T3 #5041 link fixes')).toBe(true)

    const terminal = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
    expect(await terminal.find({ type: 'Text', text: /✓ T3 #5041 link fixes/ })).toBeDefined()
    expect(await terminal.find({ type: 'Text', text: /2 of 3/ })).toBeDefined()
    await terminal.unmount()

    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop', props: PANE_PROPS })
    expect(await desktop.find({ type: 'Svg' })).toBeDefined()
    await desktop.unmount()
  })

  test('a PR link in a prompt fills the PR row from gh', async ($, on) => {
    mock.clock(on, { now: Date.parse('2026-10-03T16:00:00Z') })
    mock.store(on)
    const url = 'https://github.com/acme/webapp/pull/5042'
    on('session.cwd', () => ({ value: '/Users/me/webapp' }))
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('process.run', (_$, e) => {
      const isView = e.argv[2] === 'view'
      const stdout = isView
        ? JSON.stringify({ number: 5042, title: 'Resumable Gateway worker', url, state: 'OPEN', statusCheckRollup: [{ conclusion: 'FAILURE' }] })
        : JSON.stringify({
            data: {
              viewer: { login: 'octocat' },
              repository: {
                pullRequest: {
                  reviewThreads: { nodes: [{ isResolved: false, comments: { nodes: [{ author: { login: 'rev' }, path: 'gateway.ts', line: 118, body: 'Same bug, new path', createdAt: '2026-10-03T16:20:00Z' }] } }] },
                  comments: { nodes: [] },
                },
              },
            },
          })
      return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })

    await $.prompt.submit({ text: `can you look at ${url}` })

    const terminal = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
    let row = await terminal.find({ type: 'Text', text: /PR #5042/ })
    for (let tries = 0; !row && tries < 50; tries += 1) row = await terminal.find({ type: 'Text', text: /PR #5042/ })
    expect(row).toBeDefined()
    expect(await terminal.find({ type: 'Text', text: /1 need a reply/ })).toBeDefined()
    expect(await terminal.find({ type: 'Text', text: /CI failing/ })).toBeDefined()
    expect(await terminal.find({ type: 'Button', text: /Draft replies/ })).toBeDefined()
    await terminal.unmount()

    // On the desktop the PR is drawn into the picture; the reply action stays a real button.
    const desktop = await $.ui.mount({ ...PANE, surface: 'desktop', props: PANE_PROPS })
    expect(await desktop.find({ type: 'Svg' })).toBeDefined()
    expect(await desktop.find({ type: 'Button', text: /Draft replies to 1 thread/ })).toBeDefined()
    await desktop.unmount()
  })

  test('the desktop picture carries the PR note and the whiteboard', () => {
    const list = parseChecklist(PASTE, 1)
    const pr = {
      number: 5042, title: 'Resumable Gateway worker', url: 'https://github.com/o/r/pull/5042',
      unresolved: 37, needReply: 2, newCount: 1, ci: 'passing' as const, checkedAt: 0,
      latest: { author: 'rev', path: 'apps/x/gateway.ts', line: 118, body: 'Same bug, new path', createdAt: '' },
    }
    const panel = renderPanel({ workers: [], cols: 3, pr, checklist: list })
    for (const label of ['PR #5042', '2 need a reply', '37 unresolved', '1 new', 'CI passing', 'gateway.ts:118', 'Discord PR review', '1 of 3', 'T3 #5041 link fixes']) {
      expect(panel.svg.includes(label)).toBe(true)
    }
    expect(panel.svg.includes(`viewBox="0 0 ${panel.width} ${panel.height}"`)).toBe(true)
    expect(panel.height > renderPanel({ workers: [], cols: 3, pr: null, checklist: null }).height).toBe(true)
  })

  test('long checklist items wrap to two lines instead of running off the board', () => {
    expect(wrapText('one two three four five six', 9, 2)).toEqual(['one two', 'three fo…'])
    expect(wrapText('short', 20, 2)).toEqual(['short'])
  })

  test('the tool can show a new checklist and tick it in the same call', async ($, on) => {
    mock.clock(on, { now: 1_000 })
    const answer = await $.tool.call({
      tool: 'mcp__agent-office__checklist',
      title: 'Plan: sweep the open PRs',
      items: ['T1 PR #22 access settings', 'T2 PR #21 orders domain', 'T10 Sweep summary'],
      updates: [{ item: 1, status: 'doing' }],
    })
    const text = String(answer.result)
    expect(text.startsWith('Plan: sweep the open PRs (0/3 done)')).toBe(true)
    expect(text.includes('#1 [~] T1 PR #22 access settings')).toBe(true)

    const encoded = await $.tool.call({ tool: 'mcp__agent-office__checklist', title: 'Encoded', items: '["a","b"]', updates: '[{"item":2,"status":"done"}]' })
    expect(String(encoded.result).includes('#2 [x] b')).toBe(true)

    const bad = await $.tool.call({ tool: 'mcp__agent-office__checklist', items: ['only one'] })
    expect('deny' in bad && typeof bad.deny === 'string').toBe(true)
  })

  test('a plan.json drives the whiteboard, failed and work-account tasks marked', async ($, on) => {
    mock.clock(on, { now: 1_000 })
    const plan = {
      goal: 'add the export',
      tasks: [
        { id: 'T1', title: 'acceptance tests', status: 'done' },
        { id: 'T2', title: 'export endpoint', status: 'doing', account: 'work' },
        { id: 'T3', title: 'docs', status: 'failed' },
      ],
    }
    on('fs.read', () => ({ value: JSON.stringify(plan) }))
    const answer = await $.tool.call({ tool: 'mcp__agent-office__checklist', planFile: '/repo/.git/harness/run/plan.json' })
    const text = String(answer.result)
    expect(text.startsWith('Plan: add the export (1/3 done)')).toBe(true)
    expect(text.includes('#2 [~] T2 export endpoint · work account')).toBe(true)
    expect(text.includes('#3 [ ] T3 docs (failed)')).toBe(true)

    expect(planToChecklist('not json', 1)).toBe(null)
    expect(planToChecklist(JSON.stringify({ goal: 'x', tasks: [] }), 1)).toBe(null)
  })

  test('the tool refuses when no checklist was pasted', async ($, on) => {
    mock.clock(on, { now: 1_000 })
    const answer = await $.tool.call({ tool: 'mcp__agent-office__checklist', updates: [{ item: 1, status: 'done' }] })
    expect('deny' in answer && typeof answer.deny === 'string').toBe(true)
  })
})
