import { describe, expect, mock, test } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'

// Regression tests for the review-round-1 findings on the agent-office mod (plan task T15):
//   R11  PR review threads and conversation comments are read past the first page, and each
//        thread's latest comment is the one that decides whether it waits on the person
//   G2   when the reply-checklist fallback (session.append missed the reply) finds the same items
//        with different ticks, the pane takes the new ticks
// The world below answers the engine's nouns as tests/regressions.test.ts does; `gh api graphql`
// is answered by a small GitHub GraphQL stand-in that honours first/last/after/before and the
// 100-record page limit, so only a query that really pages sees every thread and comment.

const PANE = { plugin: 'agent-office', component: 'Pane', requestId: 'agent-office' } as const
const PANE_PROPS = { title: 'Agent Office', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as const
const CHECKLIST = 'mcp__agent-office__checklist'
const CWD = '/tmp/agent-office-review1/repo'

type Run = { exitCode: number; stdout: string; stderr: string }
type Message = { role: 'user' | 'assistant'; text: string; toolUses: unknown[]; toolResults?: unknown[] }

const ok = (stdout: string): Run => ({ exitCode: 0, stdout, stderr: '' })
const fail = (stderr: string): Run => ({ exitCode: 1, stdout: '', stderr })
const NO_PR = 'no pull requests found for branch "feature-x"'
const isGhView = (argv: readonly string[]) => argv[0] === 'gh' && argv[1] === 'pr' && argv[2] === 'view'
const isGhApi = (argv: readonly string[]) => argv[0] === 'gh' && argv[1] === 'api'

type WorldOptions = { store?: Record<string, unknown>; run?: (argv: readonly string[]) => Run | Promise<Run> }
type World = { clock: MockClock; logs: string[]; runs: string[][]; setMessages: (messages: Message[]) => void }

function world(on: any, options: WorldOptions = {}): World {
  const clock = mock.clock(on, { now: Date.parse('2026-10-03T12:00:00Z') })
  mock.store(on, options.store ?? {})
  let messages: Message[] = []
  const w: World = { clock, logs: [], runs: [], setMessages: m => { messages = m } }
  const run = options.run ?? ((argv: readonly string[]) => (isGhView(argv) ? fail(NO_PR) : argv[0] === 'git' ? ok('feature-x\n') : fail(`unknown command ${argv.join(' ')}`)))
  on('session.cwd', () => ({ value: CWD }))
  on('session.messages', () => ({ value: messages }))
  on('prompt.submit', (_$: unknown, e: { text: string }) => ({ text: e.text }))
  on('fs.read', (_$: unknown, e: { path: string }) => {
    throw new Error(`ENOENT: no such file or directory, open '${e.path}'`)
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

async function toolAnswer($: any, input: Record<string, unknown> = {}): Promise<string> {
  const r = await $.tool.call({ tool: CHECKLIST, ...input })
  if (r && typeof r === 'object' && 'deny' in r && typeof r.deny === 'string') return `DENY: ${r.deny}`
  return String(r?.result)
}

async function terminalText($: any): Promise<string> {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return texts.map((t: { text: string }) => t.text).join('\n')
}

// ---------------------------------------------------------------------------------------------
// A GitHub GraphQL stand-in for the PR query
// ---------------------------------------------------------------------------------------------
type Comment = { author: { login: string }; path: string | null; line: number | null; body: string; createdAt: string }
type Thread = { id: string; isResolved: boolean; comments: Comment[] }

/** The variables `gh api` sends: -F/--field types integers, -f/--raw-field keeps strings. */
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
    else continue
    const eq = pair.indexOf('=')
    const value = pair.slice(eq + 1)
    out[pair.slice(0, eq)] = typed && /^-?\d+$/.test(value) ? Number(value) : value
  }
  return out
}

type Connection = { key: string; args: string; selection: string; start: number; end: number }

/** Every `name(args){...}` (optionally aliased) in `text`, with its selection set. */
function connections(text: string, name: string): Connection[] {
  const found: Connection[] = []
  const re = new RegExp(`(?:(\\w+)\\s*:\\s*)?\\b${name}\\b\\s*(?:\\(([^)]*)\\))?\\s*\\{`, 'g')
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const open = m.index + m[0].length - 1
    let depth = 0
    let i = open
    for (; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1
      else if (text[i] === '}' && (depth -= 1) === 0) break
    }
    found.push({ key: m[1] ?? name, args: m[2] ?? '', selection: text.slice(open, i + 1), start: m.index, end: i + 1 })
  }
  return found
}

/** The selection of `c` without the nested connections listed in `nested`. */
function ownSelection(c: Connection, nested: readonly Connection[]): string {
  let s = c.selection
  for (const n of nested) s = s.replace(n.selection, '{}')
  return s
}

function argNumber(args: string, key: string, vars: Record<string, unknown>): number | undefined {
  const m = new RegExp(`\\b${key}\\s*:\\s*(\\$?\\w+)`).exec(args)
  if (!m) return undefined
  const raw = m[1] ?? ''
  const value = raw.startsWith('$') ? vars[raw.slice(1)] : Number(raw)
  return typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined
}

/**
 * One page of `items` as GitHub answers a connection: first/last (at most 100, one required),
 * after/before a cursor this stand-in issued. Cursors are `<prefix><index>.` tokens; they are
 * looked up wherever the caller put them (a variable or inline in the query).
 */
function pageOf<T>(items: readonly T[], c: Connection, vars: Record<string, unknown>, prefix: string, argvText: string, name: string) {
  const first = argNumber(c.args, 'first', vars)
  const last = argNumber(c.args, 'last', vars)
  if (first === undefined && last === undefined) return `You must provide a \`first\` or \`last\` value to properly paginate the \`${name}\` connection.`
  const asked = first ?? last ?? 0
  if (asked > 100) return `Requesting ${asked} records on the \`${name}\` connection exceeds the \`${first !== undefined ? 'first' : 'last'}\` limit of 100 records.`
  const cursor = new RegExp(`${prefix}(\\d+)\\.`).exec(argvText)
  const at = cursor ? Number(cursor[1]) : undefined
  let lo = 0
  let hi = items.length
  if (at !== undefined && /\bafter\s*:/.test(c.args)) lo = at + 1
  if (at !== undefined && /\bbefore\s*:/.test(c.args)) hi = at
  const [s, e] = first !== undefined ? [lo, Math.min(hi, lo + first)] : [Math.max(lo, hi - (last ?? 0)), hi]
  const page: Record<string, unknown> = { nodes: items.slice(s, Math.max(s, e)) }
  if (/\bpageInfo\b/.test(c.selection)) {
    page.pageInfo = { hasNextPage: e < items.length, hasPreviousPage: s > 0, startCursor: `${prefix}${s}.`, endCursor: `${prefix}${Math.max(s, e) - 1}.` }
  }
  if (/\btotalCount\b/.test(c.selection)) page.totalCount = items.length
  return page
}

/** Answers one `gh api graphql` call for a PR with these review threads and conversation comments. */
function answerGraphql(argv: readonly string[], threads: readonly Thread[], conversation: readonly Comment[]): Run {
  const vars = ghFields(argv)
  const query = typeof vars.query === 'string' ? vars.query : ''
  if (!query) return fail('gh: no GraphQL query given')
  const argvText = argv.join('\n')
  const pr: Record<string, unknown> = {}
  const rt = connections(query, 'reviewThreads')[0]
  if (rt) {
    const tc = connections(rt.selection, 'comments')[0]
    const threadPage = pageOf(threads, { ...rt, selection: ownSelection(rt, tc ? [tc] : []) }, vars, 'THREADPOS', argvText, 'reviewThreads')
    if (typeof threadPage === 'string') return fail(`GraphQL: ${threadPage}`)
    const nodes: Record<string, unknown>[] = []
    for (const [i, t] of (threadPage.nodes as Thread[]).entries()) {
      const node: Record<string, unknown> = { id: t.id, isResolved: t.isResolved }
      if (tc) {
        const commentPage = pageOf(t.comments, tc, vars, `T${i}COMMENTPOS`, '', 'comments')
        if (typeof commentPage === 'string') return fail(`GraphQL: ${commentPage}`)
        node[tc.key] = commentPage
      }
      nodes.push(node)
    }
    pr[rt.key] = { ...threadPage, nodes }
  }
  const conv = connections(query, 'comments').find(c => !rt || c.start < rt.start || c.start >= rt.end)
  if (conv) {
    const convPage = pageOf(conversation, conv, vars, 'CONVPOS', argvText, 'comments')
    if (typeof convPage === 'string') return fail(`GraphQL: ${convPage}`)
    pr[conv.key] = convPage
  }
  return ok(JSON.stringify({ data: { viewer: { login: 'me' }, repository: { pullRequest: pr } } }))
}

const PR_URL = 'https://github.com/acme/widgets/pull/77'
const prView = JSON.stringify({ number: 77, title: 'big pr', url: PR_URL, state: 'OPEN', statusCheckRollup: [] })
const SEEN_AT = Date.parse('2026-10-02T00:00:00Z')

const at = (day: string, minute: number) => new Date(Date.parse(`${day}T00:00:00Z`) + minute * 60_000).toISOString()
const comment = (login: string, body: string, createdAt: string, path: string | null = 'src/a.ts', line: number | null = 3): Comment => ({ author: { login }, path, line, body, createdAt })

function prWorld(on: any, threads: readonly Thread[], conversation: readonly Comment[]): World {
  return world(on, {
    store: { [`pr-seen:${PR_URL}`]: SEEN_AT },
    run: argv => {
      if (isGhView(argv)) return ok(prView)
      if (isGhApi(argv)) return answerGraphql(argv, threads, conversation)
      if (argv[0] === 'git') return ok('feature-x\n')
      return fail(`unknown command ${argv.join(' ')}`)
    },
  })
}

describe('review1 agent-office round-1 findings', () => {
  // ---- R11 ------------------------------------------------------------------------------------
  test('review1 R11 threads past the first 100 are counted and each thread is judged by its latest comment', async ($, on) => {
    const threads: Thread[] = []
    for (let i = 0; i < 100; i += 1) {
      threads.push({ id: `RT${i}`, isResolved: true, comments: [comment('rev', `resolved ${i}`, at('2026-09-20', i))] })
    }
    for (let i = 100; i < 103; i += 1) {
      threads.push({ id: `RT${i}`, isResolved: false, comments: [comment('rev', `fix the null check ${i}`, at('2026-09-25', i))] })
    }
    // 60 comments: the 50th is mine, the last (60th) is a reviewer's, so it waits on me.
    threads.push({
      id: 'RT103',
      isResolved: false,
      comments: Array.from({ length: 60 }, (_, j) =>
        j === 59
          ? comment('rev2', 'please rename the export helper', '2026-10-01T12:00:00Z', 'src/export.ts', 42)
          : comment(j % 2 === 0 ? 'rev' : 'me', `round ${j}`, at('2026-09-30', j))),
    })
    // 55 comments: the 50th is a reviewer's, but I answered last, so it does not wait on me.
    threads.push({
      id: 'RT104',
      isResolved: false,
      comments: Array.from({ length: 55 }, (_, j) =>
        comment(j === 54 ? 'me' : j === 49 ? 'rev' : j % 2 === 0 ? 'rev' : 'me', `talk ${j}`, at('2026-09-29', j))),
    })
    const w = prWorld(on, threads, [])
    await startSession($, w)

    expect(w.logs, 'the query must stay within GitHub limits (no errors)').toEqual([])
    const shown = await terminalText($)
    expect(shown).toContain('PR #77 · big pr')
    expect(shown).toMatch(/(^|\D)5 unresolved/)
    expect(shown, 'threads 101-104 wait on me; thread 105 does not').toMatch(/(^|\D)4 need a reply/)
    expect(shown, 'the newest waiting comment is the 60th of a long thread').toContain('please rename the export helper')
    expect(shown).toContain('rev2 on src/export.ts:42')
  })

  test('review1 R11 conversation comments past the newest 50 are counted as new', async ($, on) => {
    const conversation: Comment[] = [
      ...Array.from({ length: 10 }, (_, j) => comment('rev', `old ${j}`, at('2026-10-01', j), null, null)),
      ...Array.from({ length: 75 }, (_, j) => comment('rev', `new ${j}`, at('2026-10-03', j), null, null)),
      ...Array.from({ length: 5 }, (_, j) => comment('me', `mine ${j}`, at('2026-10-03', 100 + j), null, null)),
    ]
    const threads: Thread[] = [{ id: 'RT0', isResolved: false, comments: [comment('rev', 'one open thread', at('2026-09-25', 0))] }]
    const w = prWorld(on, threads, conversation)
    await startSession($, w)

    expect(w.logs).toEqual([])
    const shown = await terminalText($)
    expect(shown).toContain('PR #77 · big pr')
    expect(shown, '75 comments by others since I last looked').toMatch(/(^|\D)75 new/)
    expect(shown).toMatch(/(^|\D)1 need a reply/)
  })

  // ---- G2 -------------------------------------------------------------------------------------
  const FIRST_REPLY: Message[] = [
    { role: 'user', text: 'go on', toolUses: [] },
    { role: 'assistant', text: 'Next up:\n- [ ] write docs\n- [ ] ship it', toolUses: [] },
  ]

  test('review1 G2 a later reply restating the same items with new ticks updates the pane when session.append missed it', async ($, on) => {
    const w = world(on)
    await startSession($, w)
    w.setMessages(FIRST_REPLY)
    await $.prompt.submit({ text: 'thanks, carry on' })
    expect((await toolAnswer($)).split('\n')[0]).toBe('Next up (0/2 done)')

    const ticked: Message[] = [
      ...FIRST_REPLY,
      { role: 'user', text: 'thanks, carry on', toolUses: [] },
      { role: 'assistant', text: 'Progress:\n- [x] write docs\n- [ ] ship it', toolUses: [] },
    ]
    w.setMessages(ticked)
    await $.prompt.submit({ text: 'and then?' })
    const pane = await terminalText($)
    expect(pane, 'the pane shows the reply’s new tick').toContain('✓ write docs')
    expect(pane).toContain('○ ship it')
    const answer = await toolAnswer($)
    expect(answer.split('\n')[0]).toMatch(/\(1\/2 done\)$/)
    expect(answer).toContain('#1 [x] write docs')

    // A tick made with the tool afterwards is not undone by the same (older) reply on the next prompt.
    expect((await toolAnswer($, { updates: [{ item: 2, status: 'done' }] })).split('\n')[0]).toMatch(/\(2\/2 done\)$/)
    await $.prompt.submit({ text: 'great' })
    expect((await toolAnswer($)).split('\n')[0]).toMatch(/\(2\/2 done\)$/)
  })

  test('review1 G2 a reply ticking items of the list the person pasted applies its ticks when session.append missed it', async ($, on) => {
    const w = world(on)
    await startSession($, w)
    const paste = 'my list:\n- [ ] write docs\n- [ ] ship it'
    await $.prompt.submit({ text: paste })
    expect((await toolAnswer($)).split('\n')[0]).toBe('my list (0/2 done)')

    w.setMessages([
      { role: 'user', text: paste, toolUses: [] },
      { role: 'assistant', text: 'Done with the first one:\n- [x] write docs\n- [ ] ship it', toolUses: [] },
    ])
    await $.prompt.submit({ text: 'nice' })
    const pane = await terminalText($)
    expect(pane, 'the pane shows the reply’s tick on the pasted list').toContain('✓ write docs')
    const answer = await toolAnswer($)
    expect(answer.split('\n')[0]).toMatch(/\(1\/2 done\)$/)
    expect(answer).toContain('#1 [x] write docs')
    expect(answer).toContain('#2 [ ] ship it')
  })
})
