import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Checklist, PrStatus, Worker, WorkerStatus } from '../types'
import {
  CHECKLIST_TOOL_SPEC,
  adoptReplyChecklist,
  applyUpdates,
  checklistContext,
  describeChecklist,
  latestReplyChecklist,
  parseChecklist,
  readNewChecklist,
  readUpdates,
  planToChecklist,
  replyKey,
  sameBoard,
  sameItems,
  textOf,
  withoutCodeFences,
} from './checklist'
import { checklistSection, prSection } from './pane'
import {
  GH_RUN,
  type PrView,
  buildStatus,
  draftRepliesPrompt,
  findPrUrl,
  prUrlFromResult,
  readThreads,
  viewArgv,
  viewError,
} from './pr'
import { describePanel, fitPanel } from './boards'
import { paneLayout } from './scene'
import {
  CODEX_ID,
  CURSOR_ID,
  LEAD_ID,
  activityFor,
  clearActivity,
  clip,
  defaultWorker,
  deskName,
  externalFor,
  find,
  kindOfModel,
  patch,
  prune,
  reconcile,
  sameWorkers,
  shortModel,
  upsert,
} from './state'

const PANE = 'agent-office'
const TITLE = 'Agent Office'
const RECONCILE_MS = 3000
const PR_REFRESH_MS = 3 * 60_000
const TASK_MAX = 18
/** Bash commands after which the PR is worth re-reading straight away. */
const PR_CHANGING_COMMAND = /\bgit\s+push\b|\bgh\s+pr\b/

const workers = atom({ plugin: 'agent-office', key: 'workers' } as const, [])
const isOpened = atom({ plugin: 'agent-office', key: 'isOpened' } as const, false)
const checklist = atom({ plugin: 'agent-office', key: 'checklist' } as const, null)
const pr = atom({ plugin: 'agent-office', key: 'pr' } as const, null)
const prUrl = atom({ plugin: 'agent-office', key: 'prUrl' } as const, null)
const seenReplyKey = atom({ plugin: 'agent-office', key: 'seenReplyKey' } as const, null)
const planFile = atom({ plugin: 'agent-office', key: 'planFile' } as const, null)

const PLAN_FOLLOW_MS = 3000
const USAGE_TOOL_SPEC = {
  name: 'usage',
  description:
    "The user's Claude usage on this account: each rate-limit window (five_hour, seven_day) with percentUsed " +
    'and resetsAt. Call it before starting a large batch of work to check how much headroom is left.',
  inputSchema: { type: 'object', properties: {} },
} as const

let hasLoggedPlanError = false

type PlanRead = { board: Checklist } | { problem: string; isUnreadable: boolean }

/** The whiteboard for the plan.json at `path`, or why it cannot be followed, naming the path. */
async function readPlan($: EngineInterface, path: string): Promise<PlanRead> {
  let text: string
  try {
    text = await $.fs.read(path)
  } catch (err: unknown) {
    return { problem: `could not read ${path} (${String(err)})`, isUnreadable: true }
  }
  const board = planToChecklist(text, await $.clock.now())
  return board ? { board } : { problem: `${path} is not a plan.json with tasks`, isUnreadable: false }
}

/** Whether the checklist is still the one read earlier, ticks and last change included. */
const isUnchanged = (current: Checklist | null, before: Checklist | null) =>
  sameBoard(current, before) && current?.updatedAt === before?.updatedAt

/**
 * Redraws the whiteboard from the followed plan.json when the file changed.
 * A checklist set while the file was being read (a paste, the tool, a reply)
 * is newer than the plan, so this read is dropped rather than drawn over it.
 */
async function followPlan($: EngineInterface): Promise<void> {
  const path = await read($, planFile)
  if (!path) return
  const before = await read($, checklist)
  const plan = await readPlan($, path)
  if ('problem' in plan) {
    // A plan.json mid-rewrite parses as nothing for a moment; only an unreadable file is worth a note.
    if (plan.isUnreadable && !hasLoggedPlanError) note($, `agent-office: ${plan.problem}`)
    hasLoggedPlanError ||= plan.isUnreadable
    return
  }
  if ((await read($, planFile)) !== path) return
  await update($, checklist, current =>
    sameBoard(current, plan.board) || !isUnchanged(current, before) ? current : plan.board,
  )
}

/** Stops following a plan.json: a newer checklist from elsewhere took over the board. */
async function stopFollowingPlan($: EngineInterface): Promise<void> {
  await update($, planFile, () => null)
}

async function change($: EngineInterface, fn: (list: readonly Worker[], now: number) => Worker[]): Promise<void> {
  const now = await $.clock.now()
  await update($, workers, list => fn(list, now))
}

/** Writes a line to the transcript; if even that fails there is nowhere left to report it. */
function note($: EngineInterface, line: string): void {
  try {
    $.ui.log(line)
  } catch {
    // A surface that cannot even log has nowhere left to show this.
  }
}

/** The newest checklist Claude wrote, from the stored conversation; null if none or unreadable. */
async function newestReplyChecklist($: EngineInterface): Promise<Checklist | null> {
  try {
    return latestReplyChecklist(await $.session.messages(), await $.clock.now())
  } catch (err: unknown) {
    note($, `agent-office: could not read the conversation to find reply checklists (${String(err)})`)
    return null
  }
}

/** Marks every reply checklist written so far as seen, before a list set by the tool takes over. */
async function markRepliesSeen($: EngineInterface): Promise<void> {
  const newest = await newestReplyChecklist($)
  if (newest) await update($, seenReplyKey, () => replyKey(newest))
}

/**
 * Adopts a checklist from Claude's latest replies that the `session.append`
 * hook missed (long reply text does not always pass through it). Returns
 * whether the pane now shows a different list.
 */
async function syncFromConversation($: EngineInterface): Promise<boolean> {
  const fromReply = await newestReplyChecklist($)
  if (!fromReply) return false
  // Only a reply checklist not seen before is adopted: the transcript does not
  // say when a list was written, so an older one must never come back. The key
  // carries the ticks, so the same items restated with new ticks are adopted too.
  const key = replyKey(fromReply)
  if ((await read($, seenReplyKey)) === key) return false
  await update($, seenReplyKey, () => key)
  let isNewList = false
  await update($, checklist, current => {
    isNewList = !current || !sameItems(current, fromReply)
    return adoptReplyChecklist(current, fromReply)
  })
  if (isNewList) {
    await stopFollowingPlan($)
    open($)
  }
  return isNewList
}

let hasLoggedOpenError = false

/** Shows the pane; a surface that cannot seat it is noted once, not thrown. */
function showPane($: EngineInterface): void {
  $.ui.open({ id: PANE, title: TITLE }).catch((err: unknown) => {
    if (hasLoggedOpenError) return
    hasLoggedOpenError = true
    note($, `agent-office: could not open the pane (${String(err)})`)
  })
}

function open($: EngineInterface): void {
  void update($, isOpened, () => true)
  showPane($)
}

/** Opens the pane the first time this session has something worth showing unasked. */
async function openOnce($: EngineInterface): Promise<void> {
  let wasOpened = false
  await update($, isOpened, prev => {
    wasOpened = prev
    return true
  })
  if (!wasOpened) showPane($)
}

/** Catches subagents that ended without a turn.complete we saw, and clears old desks. */
async function tick($: EngineInterface): Promise<void> {
  const agents = await $.agent.list()
  const now = await $.clock.now()
  const current = await read($, workers)
  const next = prune(reconcile(current, agents, now), now)
  if (!sameWorkers(current, next)) await update($, workers, list => prune(reconcile(list, agents, now), now))
}

const seenKey = (url: string) => `pr-seen:${url}`

/** When the person last looked at this PR; the first sighting counts as looking. */
async function seenAtFor($: EngineInterface, url: string): Promise<number> {
  const stored = await $.store.get(seenKey(url))
  if (typeof stored === 'number') return stored
  const now = await $.clock.now()
  await $.store.set(seenKey(url), now)
  return now
}

let isRefreshingPr = false
/** A refresh was asked for while one ran; it runs again once that one ends. */
let isRefreshQueued = false
let hasLoggedPrError = false

/**
 * Points the PR section at `url` (from a command's result or a pasted link) and
 * re-reads it. Only this session follows it: a later session in the same
 * folder starts from its checked-out branch again.
 */
async function followPr($: EngineInterface, url: string): Promise<void> {
  if ((await read($, prUrl)) === url) return
  await update($, prUrl, () => url)
  refreshPrQuietly($)
}

type PrFetch = { status: PrStatus | null; error?: string }

/** `gh pr view` for `url`, or for the checked-out branch when null; null view means no PR here. */
async function viewPr($: EngineInterface, url: string | null, cwd: string): Promise<{ view: PrView | null; error?: string }> {
  const ran = await $.process.run(viewArgv(url), { ...GH_RUN, cwd })
  if (ran.exitCode === 0) return { view: JSON.parse(ran.stdout) as PrView }
  const error = viewError(ran.stderr)
  return error ? { view: null, error } : { view: null }
}

/**
 * The open PR `url` names, else (none named, or it was merged or closed) the
 * one for the checked-out branch. `status: null` without an error means there
 * is no open PR to show.
 */
async function fetchPr($: EngineInterface, url: string | null): Promise<PrFetch> {
  const cwd = await $.session.cwd()
  let found = await viewPr($, url, cwd)
  if (url && !found.error && found.view?.state !== 'OPEN') found = await viewPr($, null, cwd)
  if (found.error) return { status: null, error: found.error }
  const prView = found.view
  if (!prView || prView.state !== 'OPEN') return { status: null }
  const fetched = await readThreads(prView, argv => $.process.run(argv, { ...GH_RUN, cwd }))
  if ('error' in fetched) return { status: null, error: fetched.error }
  const seenAt = await seenAtFor($, prView.url)
  return { status: buildStatus(prView, fetched.threads, seenAt, await $.clock.now()) }
}

async function refreshPr($: EngineInterface): Promise<void> {
  if (isRefreshingPr) {
    isRefreshQueued = true
    return
  }
  isRefreshingPr = true
  try {
    const url = await read($, prUrl)
    const { status, error } = await fetchPr($, url)
    // A PR named while this ran is newer; the queued refresh reads that one.
    if ((await read($, prUrl)) !== url) return
    if (error && !hasLoggedPrError) {
      hasLoggedPrError = true
      note($, `agent-office: could not read the PR for this branch (${error})`)
    }
    if (error) return
    await update($, pr, () => status)
    if (status && (status.needReply > 0 || status.ci === 'failing')) await openOnce($)
  } finally {
    isRefreshingPr = false
    if (isRefreshQueued) {
      isRefreshQueued = false
      refreshPrQuietly($)
    }
  }
}

function refreshPrQuietly($: EngineInterface): void {
  refreshPr($).catch((err: unknown) => {
    if (hasLoggedPrError) return
    hasLoggedPrError = true
    note($, `agent-office: PR refresh failed (${String(err)})`)
  })
}

async function draftReplies($: EngineInterface): Promise<void> {
  const current = await read($, pr)
  if (!current) return
  await $.store.set(seenKey(current.url), await $.clock.now())
  await update($, pr, p => (p ? { ...p, newCount: 0 } : p))
  await $.prompt.submit({ text: draftRepliesPrompt(current) })
}

const STATUS_MARK: Record<WorkerStatus, string> = { working: '●', idle: '○', done: '✓', failed: '✗' }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'office',
      description: 'Open the Agent Office: agents at work, your checklist, and this branch’s PR',
    })
    await $.tool.register(CHECKLIST_TOOL_SPEC)
    await $.tool.register(USAGE_TOOL_SPEC)
    $.clock.every(PLAN_FOLLOW_MS, () => {
      followPlan($).catch(() => undefined)
    })
    let hasLoggedError = false
    $.clock.every(RECONCILE_MS, () => {
      tick($).catch((err: unknown) => {
        if (hasLoggedError) return
        hasLoggedError = true
        note($, `agent-office: could not refresh agent statuses (${String(err)})`)
      })
    })
    $.clock.every(PR_REFRESH_MS, () => refreshPrQuietly($))
    refreshPrQuietly($)
    return next(e)
  })

  on('command.run', { command: 'office' }, async $ => {
    open($)
    refreshPrQuietly($)
    return { text: 'Agent Office opened.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const linkedPr = findPrUrl(e.text)
    if (linkedPr) await followPr($, linkedPr)
    // Checkboxes in a fenced block are an example (a PR template), not a list to track.
    const found = parseChecklist(withoutCodeFences(e.text), await $.clock.now())
    if (found) {
      await stopFollowingPlan($)
      await update($, checklist, () => found)
      open($)
      return next({ ...e, context: [...(e.context ?? []), checklistContext(found)] })
    }
    // A checklist from Claude's last reply is announced once, with the next prompt.
    await syncFromConversation($)
    const current = await read($, checklist)
    if (!current || current.isAnnounced) return next(e)
    await update($, checklist, list => (list ? { ...list, isAnnounced: true } : list))
    return next({ ...e, context: [...(e.context ?? []), checklistContext(current)] })
  })

  // Checklists Claude writes in its own replies (main loop only: a subagent's
  // working notes would otherwise replace the list the person is following).
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.door !== 'response' || e.agentId || e.message.role !== 'assistant') return stored
    const found = parseChecklist(withoutCodeFences(textOf(e.message.content)), await $.clock.now(), 'assistant')
    if (!found) return stored
    await update($, seenReplyKey, () => replyKey(found))
    let isNewList = false
    await update($, checklist, current => {
      isNewList = !current || !sameItems(current, found)
      return adoptReplyChecklist(current, found)
    })
    if (isNewList) {
      await stopFollowingPlan($)
      open($)
    }
    return stored
  })

  on('tool.call', { tool: 'mcp__agent-office__usage' }, async $ => {
    const usage = await $.session.usage()
    return { result: JSON.stringify(usage.rateLimits) }
  })

  on('tool.call', { tool: 'mcp__agent-office__checklist' }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const now = await $.clock.now()
    if (typeof input.planFile === 'string' && input.planFile.trim()) {
      // Followed only once it reads as a plan, so a wrong path is denied, not polled.
      const path = input.planFile.trim()
      const plan = await readPlan($, path)
      if ('problem' in plan) return { deny: `Not following it: ${plan.problem}. Pass the absolute path of a /harness run's plan.json.` }
      await markRepliesSeen($)
      await update($, planFile, () => path)
      await update($, checklist, () => plan.board)
      open($)
      return { result: describeChecklist(plan.board) }
    }
    const fresh = readNewChecklist(input, now)
    if (typeof fresh === 'string') return { deny: fresh }
    if (fresh) {
      await stopFollowingPlan($)
      await markRepliesSeen($)
      await update($, checklist, () => fresh)
      open($)
    } else if (await syncFromConversation($)) {
      // Claude is ticking a list it wrote in a reply, so it already knows the pane tracks it.
      await update($, checklist, list => (list ? { ...list, isAnnounced: true } : list))
    }
    const current = await read($, checklist)
    if (!current) return { deny: 'No checklist is active. Pass title and items to show one.' }
    if (input.updates === undefined) return { result: describeChecklist(current) }
    const updates = readUpdates(input, current.items.length)
    if (typeof updates === 'string') return { deny: updates }
    const next = applyUpdates(current, updates, now)
    await update($, checklist, () => next)
    return { result: describeChecklist(next) }
  })

  on('turn.start', async ($, e, next) => {
    await change($, (list, now) => patch(list, LEAD_ID, { status: 'working', activity: 'thinking' }, now))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId ?? LEAD_ID
    const status: WorkerStatus = !e.agentId ? 'idle' : e.reason === 'error' || e.isAborted ? 'failed' : 'done'
    await change($, (list, now) =>
      e.agentId && !find(list, id) ? [...list] : patch(list, id, { status, activity: '' }, now),
    )
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (!result.agentId) return result
    const agentId = result.agentId
    const kind = kindOfModel(result.model)
    await change($, (list, now) =>
      upsert(list, {
        id: agentId,
        name: deskName(e.subagentType),
        kind,
        model: shortModel(kind),
        task: clip(e.description, TASK_MAX),
        activity: '',
        status: 'working',
        changedAt: now,
      }),
    )
    await openOnce($)
    return result
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId ?? LEAD_ID
    const input = e as unknown as Record<string, unknown>
    const label = activityFor(e.tool, input)
    const external = externalFor(e.tool, input)

    await change($, (list, now) => {
      const isTracked = id === LEAD_ID || find(list, id) !== undefined
      const withActivity = isTracked ? patch(list, id, { activity: label }, now) : [...list]
      return external
        ? patch(withActivity, external.id, { ...external.desk, status: 'working', task: external.task, activity: external.task }, now)
        : withActivity
    })
    if (external) await openOnce($)

    try {
      const ran = await next(e)
      const touchedPr = prUrlFromResult(ran.result)
      if (touchedPr) await followPr($, touchedPr)
      else if (e.tool === 'Bash' && typeof input.command === 'string' && PR_CHANGING_COMMAND.test(input.command)) {
        refreshPrQuietly($)
      }
      return ran
    } finally {
      await change($, (list, now) => {
        const cleared = clearActivity(list, id, label)
        return external ? patch(cleared, external.id, { status: external.doneStatus, activity: '' }, now) : cleared
      })
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, workers)
    const currentChecklist = await read($, checklist)
    const currentPr = await read($, pr)
    const onDraftReplies = () => void draftReplies($)

    if (e.surface === 'terminal') {
      const els = $.ui.resolve(e)
      const { Box, Text } = els
      const fixed = [LEAD_ID, CODEX_ID, CURSOR_ID].map(id => find(list, id) ?? defaultWorker(id, 0))
      const team = list.filter(w => w.id !== LEAD_ID && w.id !== CODEX_ID && w.id !== CURSOR_ID)
      return (
        <Box flexDirection="column">
          {currentPr && prSection(els, currentPr, onDraftReplies)}
          {[...fixed, ...team].map(w => (
            <Text dimColor={w.status !== 'working'} color={w.status === 'failed' ? 'red' : undefined} wrap="truncate-end">
              {STATUS_MARK[w.status]} {w.name}{w.model ? ` (${w.model})` : ''} — {w.status === 'working' ? w.activity || w.task || 'working' : w.status}
            </Text>
          ))}
          {currentChecklist && checklistSection(els, currentChecklist)}
        </Box>
      )
    }

    const { Box, Button, Svg } = $.ui.resolve(e)
    const { cols, widthPx } = paneLayout(e.props.bodyColumns)
    const input = { workers: list, cols, pr: currentPr, checklist: currentChecklist }
    const panel = fitPanel(input, widthPx)
    const needReply = currentPr?.needReply ?? 0
    return (
      <Box flexDirection="column">
        <Svg source={panel.svg} alt={describePanel(input)} width={panel.widthPx} height={panel.heightPx} isInteractive />
        {needReply > 0 && (
          <Box flexDirection="row" marginTop={1}>
            <Button
              key="draft-replies"
              variant="primary"
              label={`Draft replies to ${needReply} thread${needReply === 1 ? '' : 's'}`}
              onPress={onDraftReplies}
            />
          </Box>
        )}
      </Box>
    )
  })
}
