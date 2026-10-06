import type { Worker, WorkerKind, WorkerStatus } from '../types'

export const LEAD_ID = 'lead'
export const CODEX_ID = 'codex'
export const CURSOR_ID = 'cursor'

/** How long a finished subagent keeps its desk before it is cleared. */
export const DONE_LINGER_MS = 3 * 60_000
/** Most subagent desks kept; the oldest finished ones go first. */
export const MAX_TEAM_DESKS = 16
/**
 * Activity labels change on every tool call; they are drawn at most this often,
 * since each state write redraws the pane (a reload of the desktop's frame).
 */
export const ACTIVITY_FLUSH_MS = 2_000
/** Longest a background Bash run can last; a desk waiting on one longer is released. */
export const BACKGROUND_MAX_MS = 2 * 60 * 60_000

const ACTIVITY_MAX = 18

export function kindOfModel(model: string | undefined): WorkerKind {
  const m = (model ?? '').toLowerCase()
  if (m.includes('opus')) return 'opus'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('fable')) return 'fable'
  return 'agent'
}

export function shortModel(kind: WorkerKind): string {
  return kind === 'agent' || kind === 'lead' ? '' : kind
}

export function deskName(subagentType: string): string {
  const name = subagentType.replace(/^harness-/, '').replace(/^.*:/, '')
  return clip(name || 'agent', 12)
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function basename(path: unknown): string {
  return typeof path === 'string' ? path.split('/').pop() ?? '' : ''
}

/** A short "what am I doing" label for a tool call. */
export function activityFor(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') {
    return clip(`editing ${basename(input.file_path ?? input.notebook_path)}`, ACTIVITY_MAX)
  }
  if (tool === 'Read') return clip(`reading ${basename(input.file_path)}`, ACTIVITY_MAX)
  if (tool === 'Grep' || tool === 'Glob') return 'searching'
  if (tool === 'Bash') return 'running a command'
  if (tool === 'Agent') return 'delegating'
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'browsing'
  if (tool.startsWith('mcp__codex__')) return 'asking Codex'
  if (tool.startsWith('mcp__')) return clip(tool.split('__').pop() ?? tool, ACTIVITY_MAX)
  return clip(tool.toLowerCase(), ACTIVITY_MAX)
}

export const WORK_REVIEW_ID = 'work-review'

/** An agent outside this session, working for whoever made a tool call. */
export type External = {
  id: string
  task: string
  /** Codex and Cursor go back to idle at their desks; a one-off reviewer finishes. */
  doneStatus: WorkerStatus
  /** Desk details for a worker that has no fixed desk. */
  desk?: Pick<Worker, 'name' | 'kind' | 'model'>
}

/** What Codex is doing in a Bash command, by the claude-harness wrapper it runs. */
function codexTask(command: string): string | undefined {
  if (/\bcodex-diff-review\b/.test(command)) return 'reviewing diff'
  // claude-harness's plan verifier (codex-sol is its earlier name).
  if (/\b(?:harness-codex|codex-sol)\b/.test(command)) return 'verifying plan'
  if (/\bcodex\s+exec\b/.test(command)) return 'reviewing'
  return undefined
}

/** A desk per `claude-work-agent <agent> ... --task <id>` the command starts (claude-harness's work account). */
function workAgents(command: string): External[] {
  return command.split(/\bclaude-work-agent\b/).slice(1).flatMap(rest => {
    const agent = rest.trim().split(/\s+/)[0] ?? ''
    if (!agent || agent.startsWith('-')) return []
    // A task named by a shell variable ($t) has no literal id: the desk goes by the agent's name.
    const task = /--task\s+["']?([\w.-]+)/.exec(rest)?.[1]
    const name = deskName(agent)
    const kind: WorkerKind = /worker/.test(agent) ? 'sonnet' : 'opus'
    return [{ id: `work:${task ?? name}`, task: task ?? 'working', doneStatus: 'done' as const, desk: { name, kind, model: `${kind} work` } }]
  })
}

/** Every agent outside this session a call puts to work: Codex, Cursor, the work-account reviewer and agents. */
export function externalsFor(tool: string, input: Record<string, unknown>): External[] {
  if (tool.startsWith('mcp__codex__')) {
    const prompt = typeof input.prompt === 'string' ? input.prompt : ''
    return [{ id: CODEX_ID, task: /verif|plan/i.test(prompt) ? 'verifying plan' : 'reviewing', doneStatus: 'idle' }]
  }
  if (tool !== 'Bash' || typeof input.command !== 'string') return []
  const command = input.command
  const found: External[] = []
  if (/\bclaude-work-review\b/.test(command)) {
    found.push({ id: WORK_REVIEW_ID, task: 'reviewing diff', doneStatus: 'done', desk: { name: 'reviewer', kind: 'opus', model: 'opus work' } })
  }
  if (/\b(?:cursor-review|cursor-agent)\b/.test(command)) found.push({ id: CURSOR_ID, task: 'reviewing diff', doneStatus: 'idle' })
  const codex = codexTask(command)
  if (codex) found.push({ id: CODEX_ID, task: codex, doneStatus: 'idle' })
  return [...found, ...workAgents(command)]
}

/** The first agent outside this session behind a call, if any. */
export function externalFor(tool: string, input: Record<string, unknown>): External | undefined {
  return externalsFor(tool, input)[0]
}

/** Puts each external agent to work at its desk. */
export function startExternals(list: readonly Worker[], externals: readonly External[], now: number): Worker[] {
  return externals.reduce<Worker[]>(
    (acc, x) => patch(acc, x.id, { ...x.desk, status: 'working', task: x.task, activity: x.task }, now),
    [...list],
  )
}

/** Sends each external agent back: Codex and Cursor to idle, one-off agents to done (or failed). */
export function finishExternals(list: readonly Worker[], externals: readonly External[], now: number, isFailed = false): Worker[] {
  return externals.reduce<Worker[]>((acc, x) => {
    const status: WorkerStatus = isFailed && x.doneStatus === 'done' ? 'failed' : x.doneStatus
    return patch(acc, x.id, { status, activity: '' }, now)
  }, [...list])
}

/** Applies coalesced activity labels to desks still working; others are left alone. */
export function applyActivity(list: readonly Worker[], labels: ReadonlyMap<string, string>, now: number): Worker[] {
  return [...labels].reduce<Worker[]>((acc, [id, label]) => {
    const current = find(acc, id)
    return current?.status === 'working' ? patch(acc, id, { activity: label }, now) : acc
  }, [...list])
}

/**
 * The id Bash gives a command it moved to the background; undefined when it ran
 * in the foreground. Core's Bash record carries it as `backgroundTaskId`; the
 * text the model reads ("running in background with ID: ...") is the fallback.
 */
export function backgroundTaskId(ran: { result?: unknown; text?: string }): string | undefined {
  const id = (ran.result as { backgroundTaskId?: unknown } | null | undefined)?.backgroundTaskId
  if (typeof id === 'string' && id) return id
  const text = ran.text ?? (typeof ran.result === 'string' ? ran.result : '')
  return /running in background with ID:\s*([\w-]+)/.exec(text)?.[1]
}

/** The background tasks a `<task-notification>` row reports as ended, with whether each failed. */
export function endedTasks(text: string): { id: string; isFailed: boolean }[] {
  return [...text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)].flatMap(([, body = '']) => {
    const id = /<task-id>\s*([\w-]+)\s*<\/task-id>/.exec(body)?.[1]
    const status = /<status>\s*(\w+)\s*<\/status>/.exec(body)?.[1] ?? 'completed'
    return id ? [{ id, isFailed: status === 'failed' || status === 'killed' }] : []
  })
}

export function defaultWorker(id: string, now: number): Worker {
  const kind: WorkerKind = id === LEAD_ID ? 'lead' : id === CODEX_ID ? 'codex' : id === CURSOR_ID ? 'cursor' : 'agent'
  const name = id === LEAD_ID ? 'lead' : id === CODEX_ID ? 'codex' : id === CURSOR_ID ? 'cursor' : 'agent'
  // The CLIs do not report which model they run, so the Codex and Cursor desks carry no model label.
  return { id, name, kind, model: '', task: '', activity: '', status: 'idle', changedAt: now }
}

export function find(list: readonly Worker[], id: string): Worker | undefined {
  return list.find(w => w.id === id)
}

/** Insert or replace one worker, leaving the rest untouched. */
export function upsert(list: readonly Worker[], worker: Worker): Worker[] {
  return find(list, worker.id)
    ? list.map(w => (w.id === worker.id ? worker : w))
    : [...list, worker]
}

/** Change some fields of one worker, creating it from defaults if it is new. */
export function patch(
  list: readonly Worker[],
  id: string,
  fields: Partial<Omit<Worker, 'id'>>,
  now: number,
): Worker[] {
  const current = find(list, id) ?? defaultWorker(id, now)
  const changedAt = fields.status && fields.status !== current.status ? now : current.changedAt
  return upsert(list, { ...current, ...fields, changedAt })
}

const isFixedDesk = (w: Worker) => w.id === LEAD_ID || w.id === CODEX_ID || w.id === CURSOR_ID
const isFinished = (s: WorkerStatus) => s === 'done' || s === 'failed'

/** Drop finished subagents after they linger, and cap the team size. */
export function prune(list: readonly Worker[], now: number): Worker[] {
  const kept = list.filter(w => isFixedDesk(w) || !isFinished(w.status) || now - w.changedAt < DONE_LINGER_MS)
  const team = kept.filter(w => !isFixedDesk(w))
  if (team.length <= MAX_TEAM_DESKS) return kept
  const finishedOldestFirst = team
    .filter(w => isFinished(w.status))
    .sort((a, b) => a.changedAt - b.changedAt)
  const drop = new Set(finishedOldestFirst.slice(0, team.length - MAX_TEAM_DESKS).map(w => w.id))
  return kept.filter(w => !drop.has(w.id))
}

/** Apply `$.agent.list()` statuses to subagents still marked working. */
export function reconcile(
  list: readonly Worker[],
  agents: readonly { id: string; status: string }[],
  now: number,
): Worker[] {
  const statusById = new Map(agents.map(a => [a.id, a.status]))
  return list.map(w => {
    const status = statusById.get(w.id)
    if (w.status !== 'working' || status === undefined || status === 'running') return w
    const next: WorkerStatus = status === 'completed' ? 'done' : 'failed'
    return { ...w, status: next, activity: '', changedAt: now }
  })
}

export function sameWorkers(a: readonly Worker[], b: readonly Worker[]): boolean {
  return a.length === b.length && a.every((w, i) => {
    const o = b[i]
    return o !== undefined && w.id === o.id && w.status === o.status && w.activity === o.activity && w.task === o.task &&
      w.name === o.name && w.model === o.model && w.kind === o.kind
  })
}
