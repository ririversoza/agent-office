import { describe, expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'

// Regression tests for the confirmed agent-office findings (mod:F1-F10, F12).
// Each drives the mod through the engine as a session does: the test answers
// the nouns beneath the plugin (clock, store, fs, process, session, ui) and
// reads what the model and the person would see (tool results, prompt
// context, the drawn pane, transcript log lines).

const PANE = { plugin: 'agent-office', component: 'Pane', requestId: 'agent-office' } as const
const PANE_PROPS = { title: 'Agent Office', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as const
const CHECKLIST = 'mcp__agent-office__checklist'
const CWD = '/tmp/agent-office-regression/repo'
const PLAN_PATH = `${CWD}/.git/harness/20261004-000000/plan.json`
const SVG_MAX_PX = 4096
const SVG_MAX_CHARS = 131072
const PR_REFRESH_MS = 3 * 60_000

type Run = { exitCode: number; stdout: string; stderr: string }
type Message = { role: 'user' | 'assistant'; text: string; toolUses: unknown[]; toolResults?: unknown[] }
type Task = { id: string; title: string; status?: string; account?: string }

const ok = (stdout: string): Run => ({ exitCode: 0, stdout, stderr: '' })
const fail = (stderr: string): Run => ({ exitCode: 1, stdout: '', stderr })

const NO_PR = 'no pull requests found for branch "feature-x"'
const NO_THREADS = JSON.stringify({ data: { viewer: { login: 'me' }, repository: { pullRequest: { reviewThreads: { nodes: [] }, comments: { nodes: [] } } } } })

function planJson(goal: string, tasks: readonly Task[]): string {
  return JSON.stringify({ goal, tasks })
}

function prView(url: string, fields: { title?: string; state?: string } = {}): string {
  const number = Number(url.split('/').pop())
  return JSON.stringify({ number, title: fields.title ?? `pr ${number}`, url, state: fields.state ?? 'OPEN', statusCheckRollup: [] })
}

/** The URL a `gh pr view` call names, or null for the checked-out branch's lookup. */
function viewedUrl(argv: readonly string[]): string | null {
  return argv.slice(3).find(a => /^https?:\/\//.test(a)) ?? null
}

const isGhView = (argv: readonly string[]) => argv[0] === 'gh' && argv[1] === 'pr' && argv[2] === 'view'
const isGhApi = (argv: readonly string[]) => argv[0] === 'gh' && argv[1] === 'api'

/** gh with no PR on the branch, git on branch feature-x, and nothing else known. */
function defaultRun(argv: readonly string[]): Run {
  if (isGhView(argv)) return fail(NO_PR)
  if (isGhApi(argv)) return ok(NO_THREADS)
  if (argv[0] === 'git') return ok('feature-x\n')
  return fail(`unknown command ${argv.join(' ')}`)
}

type WorldOptions = {
  now?: number
  store?: Record<string, unknown>
  /** fs.read for any path; throw to make it unreadable. Unreadable when not given. */
  readFile?: (path: string) => string | Promise<string>
  run?: (argv: readonly string[]) => Run | Promise<Run>
  messages?: Message[]
}

type World = {
  clock: MockClock
  logs: string[]
  contexts: (readonly string[])[]
  runs: string[][]
  reads: string[]
  setMessages: (messages: Message[]) => void
}

/** Answers every noun the mod calls, so its session.start hook and timers run as in a session. */
function world(on: any, options: WorldOptions = {}): World {
  const clock = mock.clock(on, { now: options.now ?? 1_000 })
  mock.store(on, options.store ?? {})
  let messages: Message[] = options.messages ?? []
  const w: World = { clock, logs: [], contexts: [], runs: [], reads: [], setMessages: m => { messages = m } }
  const readFile = options.readFile ?? ((path: string) => { throw new Error(`ENOENT: no such file or directory, open '${path}'`) })
  const run = options.run ?? defaultRun
  on('session.cwd', () => ({ value: CWD }))
  on('session.messages', () => ({ value: messages }))
  on('prompt.submit', (_$: unknown, e: { text: string; context?: readonly string[] }) => {
    w.contexts.push(e.context ?? [])
    return { text: e.text }
  })
  on('fs.read', async (_$: unknown, e: { path: string }) => {
    w.reads.push(e.path)
    return { value: await readFile(e.path) }
  })
  on('process.run', async (_$: unknown, e: { argv: readonly string[] }) => {
    w.runs.push([...e.argv])
    const r = await run(e.argv)
    return { value: { ...r, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.log', (_$: unknown, e: { text: string }) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'office' } }))
  on('tool.register', (_$: unknown, e: { name: string }) => ({ value: { tool: `mcp__agent-office__${e.name}` } }))
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [] }))
  return w
}

async function startSession($: any, w: World): Promise<void> {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await w.clock.settle()
}

/** What the checklist tool answers the model right now: the result, or `DENY: <reason>`. */
async function toolAnswer($: any, input: Record<string, unknown> = {}): Promise<string> {
  const r = await $.tool.call({ tool: CHECKLIST, ...input })
  if (r && typeof r === 'object' && 'deny' in r && typeof r.deny === 'string') return `DENY: ${r.deny}`
  return String(r?.result)
}

/** The first line of the checklist tool's answer: `<title> (<done>/<total> done)`. */
async function headline($: any): Promise<string> {
  return (await toolAnswer($)).split('\n')[0] ?? ''
}

/** Every Text the terminal pane draws, joined by newlines. */
async function terminalText($: any): Promise<string> {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return texts.map((t: { text: string }) => t.text).join('\n')
}

/** The desktop pane's Svg as drawn at `bodyColumns`; mount rejects when the surface refuses the tree. */
async function desktopSvg($: any, bodyColumns: number): Promise<{ source: string; width: number; height: number; alt: string }> {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE_PROPS, bodyColumns } })
  const svg = await ui.find({ type: 'Svg' })
  await ui.unmount()
  expect(svg, 'the desktop pane draws the office Svg').toBeDefined()
  const props = svg.props as { source: string; width: number; height: number; alt: string }
  return props
}

const PLAN_TWO = planJson('ship the export', [
  { id: 'T1', title: 'acceptance tests', status: 'doing' },
  { id: 'T2', title: 'export endpoint', status: 'todo' },
])
const PLAN_TWO_T1_DONE = planJson('ship the export', [
  { id: 'T1', title: 'acceptance tests', status: 'done' },
  { id: 'T2', title: 'export endpoint', status: 'doing' },
])
const REPLY_LIST: Message[] = [
  { role: 'user', text: 'go on', toolUses: [] },
  { role: 'assistant', text: 'Next up:\n- [ ] write docs\n- [ ] ship it', toolUses: [] },
]

describe('regression: agent-office mod findings', () => {
  // ---- mod:F1 -------------------------------------------------------------
  test('mod:F1 a reply checklist adopted at the next prompt stays on the board after the plan follow timer fires', async ($, on) => {
    let planText = PLAN_TWO
    const w = world(on, { readFile: () => planText })
    await startSession($, w)
    expect(await toolAnswer($, { planFile: PLAN_PATH })).toStartWith('Plan: ship the export (0/2 done)')

    w.setMessages(REPLY_LIST)
    await $.prompt.submit({ text: 'thanks, carry on' })
    expect(await headline($)).toBe('Next up (0/2 done)')

    await w.clock.advance(3_100)
    expect(await headline($), 'the follow timer must not put the plan back over a newer reply list').toBe('Next up (0/2 done)')

    const ticked = await toolAnswer($, { updates: [{ item: 2, status: 'done' }] })
    expect(ticked).toContain('#2 [x] ship it')

    // A later rewrite of the old run's plan.json does not take the board back either.
    planText = PLAN_TWO_T1_DONE
    await w.clock.advance(9_100)
    expect(await headline($)).toBe('Next up (1/2 done)')
  })

  test('mod:F1 a reply checklist the model ticks with the tool is not reverted to the followed plan', async ($, on) => {
    const w = world(on, { readFile: () => PLAN_TWO })
    await startSession($, w)
    await toolAnswer($, { planFile: PLAN_PATH })

    w.setMessages(REPLY_LIST)
    const ticked = await toolAnswer($, { updates: [{ item: 1, status: 'doing' }] })
    expect(ticked).toStartWith('Next up (0/2 done)')
    expect(ticked).toContain('#1 [~] write docs')

    await w.clock.advance(3_100)
    const after = await toolAnswer($)
    expect(after.split('\n')[0]).toBe('Next up (0/2 done)')
    expect(after).toContain('#1 [~] write docs')
  })

  // ---- mod:F2 -------------------------------------------------------------
  test('mod:F2 a planFile that is not a plan is denied even while another checklist is showing', async ($, on) => {
    const w = world(on, { readFile: () => '{"not":"a plan"}' })
    await startSession($, w)
    await toolAnswer($, { title: 'Old', items: ['x one', 'y two'] })

    const answer = await toolAnswer($, { planFile: '/tmp/agent-office-regression/not-a-plan.json' })
    expect(answer, 'the model must learn the pane does not follow that file').toStartWith('DENY: ')
    expect(answer).toContain('/tmp/agent-office-regression/not-a-plan.json')
  })

  test('mod:F2 an unreadable planFile is denied and is not polled afterwards', async ($, on) => {
    const w = world(on) // every fs.read fails with ENOENT
    await startSession($, w)
    await toolAnswer($, { title: 'Old', items: ['x one', 'y two'] })

    const missing = '/tmp/agent-office-regression/$RUN/plan.json'
    const answer = await toolAnswer($, { planFile: missing })
    expect(answer).toStartWith('DENY: ')
    expect(answer).toContain(missing)

    const readsAtDeny = w.reads.filter(p => p === missing).length
    await w.clock.advance(10_000)
    expect(w.reads.filter(p => p === missing).length, 'a denied planFile must not stay followed').toBe(readsAtDeny)
  })

  // ---- mod:F3 -------------------------------------------------------------
  test('mod:F3 a 60-task plan with 16 subagent desks still draws within the Svg limits on a docked pane', async ($, on) => {
    const tasks = Array.from({ length: 60 }, (_, i) => ({
      id: `T${i + 1}`,
      title: 'implement the export endpoint & its acceptance tests <with> "quotes" across several modules and files',
      status: 'done',
      account: 'work',
    }))
    const w = world(on, { readFile: () => planJson('tall board', tasks) })
    on('agent.spawn', (_$: unknown, e: { description: string }) => ({ agentId: `agent-${e.description}`, model: 'claude-sonnet-5-5' }))
    for (let i = 0; i < 16; i += 1) {
      await $.agent.spawn({ prompt: 'work', description: `T${i} & <things>`, subagentType: 'harness-implementer' } as never)
    }
    expect(await toolAnswer($, { planFile: PLAN_PATH })).toStartWith('Plan: tall board (60/60 done)')
    await w.clock.settle()

    const svg = await desktopSvg($, 60)
    expect(svg.height).toBeLessThanOrEqual(SVG_MAX_PX)
    expect(svg.width).toBeLessThanOrEqual(SVG_MAX_PX)
    expect(svg.source.length).toBeLessThan(SVG_MAX_CHARS)
    expect(svg.source, 'the whiteboard is still part of the picture').toContain('Plan: tall board')
  })

  test('mod:F3 a 50-item checklist with no subagents still draws within the Svg limits at 80 columns', async ($, on) => {
    const w = world(on)
    const items = Array.from({ length: 50 }, (_, i) => `step ${i + 1}: migrate the billing tables and backfill the ledger rows for region ${i}`)
    expect(await toolAnswer($, { title: 'Long list', items })).toStartWith('Long list (0/50 done)')
    await w.clock.settle()

    const svg = await desktopSvg($, 80)
    expect(svg.height).toBeLessThanOrEqual(SVG_MAX_PX)
    expect(svg.width).toBeLessThanOrEqual(SVG_MAX_PX)
    expect(svg.source.length).toBeLessThan(SVG_MAX_CHARS)
    expect(svg.source).toContain('Long list')
  })

  test('mod:F3 a full board with 16 desks and an escaped PR note stays under the Svg limits on a maximised pane', async ($, on) => {
    const url = 'https://github.com/acme/widgets/pull/5042'
    const title = '<Fix> "quoted" & escaped titles & more <tags> & "quotes" '.repeat(4)
    const threads = JSON.stringify({
      data: {
        viewer: { login: 'me' },
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [{ isResolved: false, comments: { nodes: [{ author: { login: 'rev' }, path: 'a/b.ts', line: 1, body: '<&"> '.repeat(30), createdAt: '2026-10-03T16:20:00Z' }] } }],
            },
            comments: { nodes: [] },
          },
        },
      },
    })
    const tasks = Array.from({ length: 60 }, (_, i) => ({
      id: `T${i + 1}`,
      title: '<b>&amp; "escape" & <i>every</i> & "char" & <u>here</u> & "and" & <s>there</s> & more & more',
      status: 'done',
    }))
    const w = world(on, {
      readFile: () => planJson('tall board', tasks),
      run: argv => (isGhView(argv) ? (viewedUrl(argv) ? ok(prView(url, { title })) : fail(NO_PR)) : isGhApi(argv) ? ok(threads) : defaultRun(argv)),
    })
    on('agent.spawn', (_$: unknown, e: { description: string }) => ({ agentId: `agent-${e.description}`, model: 'claude-opus-5-5' }))
    for (let i = 0; i < 16; i += 1) {
      await $.agent.spawn({ prompt: 'work', description: `<T${i}> & "x"`, subagentType: 'harness-implementer' } as never)
    }
    await $.prompt.submit({ text: `please watch ${url}` })
    await toolAnswer($, { planFile: PLAN_PATH })
    await w.clock.settle()

    for (const columns of [120, 181]) {
      const svg = await desktopSvg($, columns)
      expect(svg.height).toBeLessThanOrEqual(SVG_MAX_PX)
      expect(svg.width).toBeLessThanOrEqual(SVG_MAX_PX)
      expect(svg.source.length).toBeLessThan(SVG_MAX_CHARS)
      expect(svg.source).toContain('PR #5042')
    }
  })

  // ---- mod:F4 -------------------------------------------------------------
  const BRANCH_PR = 'https://github.com/acme/widgets/pull/7'
  const OTHER_PR = 'https://github.com/other-org/lib/pull/2'
  const prByUrl = (states: Record<string, string>) => (argv: readonly string[]): Run => {
    if (isGhView(argv)) {
      const url = viewedUrl(argv)
      return url ? ok(prView(url, { state: states[url] ?? 'OPEN' })) : ok(prView(BRANCH_PR, { title: 'branch work' }))
    }
    return defaultRun(argv)
  }

  test('mod:F4 a new session shows the checked-out branch PR, not one an earlier session remembered for the folder', async ($, on) => {
    // What an earlier session left in the store after a PR link to another repo was pasted "for reference".
    const w = world(on, { store: { [`pr-ref:${CWD}`]: OTHER_PR }, run: prByUrl({}) })
    await startSession($, w)

    const shown = await terminalText($)
    expect(shown).toContain('PR #7 · branch work')
    expect(shown).not.toContain('PR #2')
    expect(w.runs.filter(isGhView).some(argv => viewedUrl(argv) === null), 'the branch PR is looked up').toBe(true)
  })

  test('mod:F4 when the PR the session followed is merged, the row falls back to the branch PR', async ($, on) => {
    const merged = 'https://github.com/acme/widgets/pull/2'
    const w = world(on, { run: prByUrl({ [merged]: 'MERGED' }) })
    await startSession($, w)
    await $.prompt.submit({ text: `this was merged: ${merged}` })
    await w.clock.settle()

    const shown = await terminalText($)
    expect(shown).toContain('PR #7 · branch work')
  })

  // ---- mod:F5 -------------------------------------------------------------
  test('mod:F5 a PR named while a refresh is in flight is fetched and shown, not overwritten by the older refresh', async ($, on) => {
    const named = 'https://github.com/acme/widgets/pull/2'
    const branchPr = 'https://github.com/acme/widgets/pull/1'
    let views = 0
    let clock: MockClock | null = null
    const w = world(on, {
      run: async argv => {
        if (!isGhView(argv)) return defaultRun(argv)
        views += 1
        if (views === 1) await clock?.sleep(2_000) // the startup lookup is slow
        const url = viewedUrl(argv)
        return ok(prView(url ?? branchPr))
      },
    })
    clock = w.clock
    await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
    await w.clock.settle()
    await $.prompt.submit({ text: `look at ${named}` })
    await w.clock.advance(2_500)

    const shown = await terminalText($)
    expect(shown).toContain('PR #2')
    expect(shown).not.toContain('PR #1')
    expect(w.runs.filter(isGhView).some(argv => viewedUrl(argv) === named)).toBe(true)
  })

  // ---- mod:F6 -------------------------------------------------------------
  test('mod:F6 a checklist pasted while a plan read is in flight is not overwritten by that read', async ($, on) => {
    let reads = 0
    let clock: MockClock | null = null
    const w = world(on, {
      readFile: async () => {
        reads += 1
        if (reads > 1) await clock?.sleep(50)
        return PLAN_TWO
      },
    })
    clock = w.clock
    await startSession($, w)
    await toolAnswer($, { planFile: PLAN_PATH })
    await w.clock.advance(3_000) // the follow timer's read is now waiting 50 ms

    await $.prompt.submit({ text: 'my list:\n- [ ] write docs\n- [ ] ship it' })
    expect(await headline($)).toBe('my list (0/2 done)')
    await w.clock.advance(60)
    expect(await headline($), 'the in-flight plan read must not replace the pasted list').toBe('my list (0/2 done)')
    await w.clock.advance(10_000)
    expect(await headline($)).toBe('my list (0/2 done)')
  })

  // ---- mod:F7 -------------------------------------------------------------
  const GITLAB = 'none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`'
  const DETACHED = 'could not determine current branch: failed to run git: not on any branch'

  test('mod:F7 a repo with no GitHub remote logs nothing, and a later real gh error is still reported', async ($, on) => {
    let viewError = GITLAB
    const w = world(on, { run: argv => (isGhView(argv) ? fail(viewError) : defaultRun(argv)) })
    await startSession($, w)
    expect(w.logs, 'a non-GitHub remote is "no PR here", not an error').toEqual([])

    viewError = 'HTTP 401: Bad credentials'
    await w.clock.advance(PR_REFRESH_MS + 100)
    expect(w.logs.filter(l => l.includes('HTTP 401'))).toHaveLength(1)
  })

  test('mod:F7 a detached HEAD is not logged as an error and clears the PR row it no longer applies to', async ($, on) => {
    let isDetached = false
    const branchPr = 'https://github.com/acme/widgets/pull/1'
    const w = world(on, {
      run: argv => (isGhView(argv) ? (isDetached ? fail(DETACHED) : ok(prView(branchPr, { title: 'branch work' }))) : defaultRun(argv)),
    })
    await startSession($, w)
    expect(await terminalText($)).toContain('PR #1 · branch work')

    isDetached = true // e.g. mid-rebase
    await w.clock.advance(PR_REFRESH_MS + 100)
    expect(w.logs).toEqual([])
    expect(await terminalText($)).not.toContain('PR #1')
  })

  test('mod:F7 a GitHub Enterprise PR is not reported as an error in the transcript', async ($, on) => {
    const ghe = 'https://github.acme-corp.com/platform/api/pull/3'
    const w = world(on, { run: argv => (isGhView(argv) ? ok(prView(ghe)) : defaultRun(argv)) })
    await startSession($, w)
    expect(w.logs).toEqual([])
  })

  // ---- mod:F8 -------------------------------------------------------------
  test('mod:F8 checkboxes inside a code fence in a prompt do not replace the followed plan', async ($, on) => {
    let planText = PLAN_TWO
    const w = world(on, { readFile: () => planText })
    await startSession($, w)
    await toolAnswer($, { planFile: PLAN_PATH })

    await $.prompt.submit({ text: 'does this PR template look right?\n```md\n## Checklist\n- [ ] Tests added\n- [ ] Docs updated\n```' })
    expect(await headline($)).toBe('Plan: ship the export (0/2 done)')
    expect(w.contexts.flat().some(c => c.includes('Tests added')), 'the model is not told to tick an example list').toBe(false)

    planText = PLAN_TWO_T1_DONE
    await w.clock.advance(3_100)
    expect(await headline($), 'the plan is still followed').toBe('Plan: ship the export (1/2 done)')
  })

  // ---- mod:F9 -------------------------------------------------------------
  test('mod:F9 a resumed session does not re-adopt a reply checklist the old session had superseded', async ($, on) => {
    const previous: Message[] = [
      { role: 'user', text: 'plan it', toolUses: [] },
      {
        role: 'assistant',
        text: 'Draft:\n- [ ] old step one\n- [ ] old step two',
        toolUses: [{ tool_use_id: 'tu1', tool: CHECKLIST, input: { title: 'Real plan', items: ['real one', 'real two'] }, text: 'Real plan (0/2 done)' }],
      },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'tu1', text: 'Real plan (0/2 done)', isError: false }] },
      { role: 'assistant', text: 'Switched to the real list in the pane.', toolUses: [] },
    ]
    const w = world(on, { messages: previous })
    await startSession($, w)

    await $.prompt.submit({ text: 'continue' })
    expect(w.contexts.flat().some(c => c.includes('old step one')), 'the superseded list is not announced again').toBe(false)
    expect(await toolAnswer($)).toStartWith('DENY: ')

    // A list Claude writes after the resume is still picked up.
    w.setMessages([
      ...previous,
      { role: 'user', text: 'continue', toolUses: [] },
      { role: 'assistant', text: 'Now:\n- [ ] new one\n- [ ] new two', toolUses: [] },
    ])
    await $.prompt.submit({ text: 'ok' })
    expect(w.contexts.flat().some(c => c.includes('new one'))).toBe(true)
  })

  // ---- mod:F10 ------------------------------------------------------------
  test('mod:F10 a plan with more than 60 tasks counts progress against every task', async ($, on) => {
    const tasks = Array.from({ length: 75 }, (_, i) => ({ id: `T${i + 1}`, title: `task ${i + 1}`, status: i >= 60 ? 'done' : 'todo' }))
    const w = world(on, { readFile: () => planJson('long run', tasks) })
    await startSession($, w)
    expect(await toolAnswer($, { planFile: PLAN_PATH })).toStartWith('Plan: long run (15/75 done)')
  })

  test('mod:F10 items past the 60th of a long checklist can be ticked', async ($, on) => {
    const w = world(on)
    await startSession($, w)
    const items = Array.from({ length: 65 }, (_, i) => `item ${i + 1}`)
    expect(await toolAnswer($, { title: 'Long', items })).toStartWith('Long (0/65 done)')
    const ticked = await toolAnswer($, { updates: [{ item: 65, status: 'done' }] })
    expect(ticked).toStartWith('Long (1/65 done)')
  })

  // ---- mod:F12 ------------------------------------------------------------
  /** The variables `gh api graphql` sends: -F/--field converts integers, true/false/null; -f/--raw-field keeps strings. */
  function ghFields(argv: readonly string[]): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i] ?? ''
      let typed: boolean
      let pair: string
      if (a === '-f' || a === '--raw-field') [typed, pair] = [false, argv[++i] ?? '']
      else if (a === '-F' || a === '--field') [typed, pair] = [true, argv[++i] ?? '']
      else if (a.startsWith('--raw-field=')) [typed, pair] = [false, a.slice('--raw-field='.length)]
      else if (a.startsWith('--field=')) [typed, pair] = [true, a.slice('--field='.length)]
      else if (/^-f./.test(a)) [typed, pair] = [false, a.slice(2)]
      else if (/^-F./.test(a)) [typed, pair] = [true, a.slice(2)]
      else continue
      const eq = pair.indexOf('=')
      const key = pair.slice(0, eq)
      const value = pair.slice(eq + 1)
      out[key] = typed && /^-?\d+$/.test(value) ? Number(value) : typed && ['true', 'false', 'null'].includes(value) ? JSON.parse(value) : value
    }
    return out
  }

  test('mod:F12 the review-thread query works for a repo whose owner and name are all digits', async ($, on) => {
    const url = 'https://github.com/1234/2048/pull/5'
    const threads = JSON.stringify({
      data: {
        viewer: { login: 'me' },
        repository: {
          pullRequest: {
            reviewThreads: { nodes: [{ isResolved: false, comments: { nodes: [{ author: { login: 'rev' }, path: 'game.ts', line: 9, body: 'Why?', createdAt: '2026-10-03T16:20:00Z' }] } }] },
            comments: { nodes: [] },
          },
        },
      },
    })
    const w = world(on, {
      run: argv => {
        if (isGhView(argv)) return viewedUrl(argv) ? ok(prView(url, { title: 'merge tiles' })) : fail(NO_PR)
        if (isGhApi(argv)) {
          const vars = ghFields(argv)
          if (typeof vars.owner !== 'string') return fail('GraphQL: Variable $owner of type String! was provided invalid value')
          if (typeof vars.name !== 'string') return fail('GraphQL: Variable $name of type String! was provided invalid value')
          if (typeof vars.number !== 'number') return fail('GraphQL: Variable $number of type Int! was provided invalid value')
          return ok(threads)
        }
        return defaultRun(argv)
      },
    })
    await startSession($, w)
    await $.prompt.submit({ text: `review ${url}` })
    await w.clock.settle()

    expect(w.logs).toEqual([])
    const shown = await terminalText($)
    expect(shown).toContain('PR #5 · merge tiles')
    expect(shown).toContain('1 need a reply')
  })
})
