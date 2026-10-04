import type { Worker, WorkerKind, WorkerStatus } from '../types'

export const LEAD_ID = 'lead'
export const CODEX_ID = 'codex'
export const CURSOR_ID = 'cursor'

/** How long a finished subagent keeps its desk before it is cleared. */
export const DONE_LINGER_MS = 3 * 60_000
/** Most subagent desks kept; the oldest finished ones go first. */
export const MAX_TEAM_DESKS = 16

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

/** Codex, Cursor or the work-account reviewer behind this call, if any. */
export function externalFor(tool: string, input: Record<string, unknown>): External | undefined {
  if (tool.startsWith('mcp__codex__')) {
    const prompt = typeof input.prompt === 'string' ? input.prompt : ''
    return { id: CODEX_ID, task: /verif|plan/i.test(prompt) ? 'verifying plan' : 'reviewing', doneStatus: 'idle' }
  }
  if (tool !== 'Bash' || typeof input.command !== 'string') return undefined
  const command = input.command
  if (/\bclaude-work-review\b/.test(command)) {
    return {
      id: WORK_REVIEW_ID,
      task: 'reviewing diff',
      doneStatus: 'done',
      desk: { name: 'reviewer', kind: 'opus', model: 'opus work' },
    }
  }
  if (/cursor-review|cursor-agent/.test(command)) return { id: CURSOR_ID, task: 'reviewing diff', doneStatus: 'idle' }
  // claude-harness's Codex wrapper (codex-sol is its earlier name).
  if (/\b(?:harness-codex|codex-sol)\b/.test(command)) return { id: CODEX_ID, task: 'verifying plan', doneStatus: 'idle' }
  if (/\bcodex\s+exec\b/.test(command)) return { id: CODEX_ID, task: 'reviewing', doneStatus: 'idle' }
  return undefined
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

/** Clear `activity` only if it is still the label this call set. */
export function clearActivity(list: readonly Worker[], id: string, label: string): Worker[] {
  const current = find(list, id)
  if (!current || current.activity !== label) return [...list]
  return upsert(list, { ...current, activity: '' })
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
    return o !== undefined && w.id === o.id && w.status === o.status && w.activity === o.activity && w.task === o.task
  })
}
