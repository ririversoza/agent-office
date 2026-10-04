import type { Checklist, ChecklistItem, ChecklistStatus } from '../types'

export const CHECKLIST_TOOL = 'checklist'
export const CHECKLIST_TOOL_FULL = `mcp__agent-office__${CHECKLIST_TOOL}`

// Lists are kept whole, however long: progress counts every item and every
// item can be ticked. The desktop board fits long lists to its size itself.
const MIN_ITEMS = 2
const TITLE_MAX = 48
const ITEM_MAX = 140
const ITEM_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX~-])\]\s+(.+?)\s*$/
const STATUSES: readonly ChecklistStatus[] = ['todo', 'doing', 'done']

export const CHECKLIST_TOOL_SPEC = {
  name: CHECKLIST_TOOL,
  description:
    "Shows and updates the checklist in the user's Agent Office pane. To show a new checklist (a plan, a " +
    'task list), pass `title` and `items`; it replaces the current one. To tick items, pass `updates` when ' +
    'an item starts (doing) or finishes (done), so the pane stays current without the user asking. The ' +
    'current checklist is the newest of: one the user pasted, one you set with this tool, or one you wrote ' +
    'in a reply. Items are numbered from 1 in order. Returns the checklist as it now stands.',
  inputSchema: {
    type: 'object',
    properties: {
      planFile: {
        type: 'string',
        description: 'Absolute path to a plan.json ({"goal", "tasks": [{"id", "title", "status"}]}, as a /harness run writes): the pane then follows that file on its own, with no further calls needed',
      },
      title: { type: 'string', description: 'Heading for a new checklist, e.g. "Plan: sweep the open PRs"' },
      items: {
        type: 'array',
        minItems: 2,
        items: { type: 'string' },
        description: 'Items of a new checklist, in order; replaces the current checklist',
      },
      updates: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            item: { type: 'integer', minimum: 1, description: 'Item number, from 1' },
            status: { type: 'string', enum: STATUSES },
          },
          required: ['item', 'status'],
        },
      },
    },
  },
} as const

/**
 * A new checklist from the tool's `title` and `items`, null when the call
 * sets none, or a message for the model when they are malformed.
 */
export function readNewChecklist(input: Record<string, unknown>, now: number): Checklist | null | string {
  if (input.items === undefined) return null
  const raw = asArray(input.items)
  if (!raw || raw.length < MIN_ITEMS || !raw.every(i => typeof i === 'string' && i.trim())) {
    return `Pass items as at least ${MIN_ITEMS} non-empty strings.`
  }
  const title = typeof input.title === 'string' && input.title.trim() ? clip(input.title, TITLE_MAX) : 'Checklist'
  const items = (raw as string[]).map(text => ({ text: clip(text, ITEM_MAX), status: 'todo' as const }))
  return { title, items, updatedAt: now, source: 'assistant', isAnnounced: true }
}

/**
 * An array argument, also when a caller sent it JSON-encoded (a model holding
 * an older copy of the tool's schema passes unknown fields as strings).
 */
function asArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function statusOfMark(mark: string): ChecklistStatus {
  if (mark === 'x' || mark === 'X') return 'done'
  if (mark === '~' || mark === '-') return 'doing'
  return 'todo'
}

/** The nearest heading or lead-in line above the first item, else a default. */
function titleAbove(lines: readonly string[], firstItem: number): string {
  for (let i = firstItem - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? '').replace(/^#+\s*/, '').replace(/[:：]\s*$/, '').trim()
    if (line && !ITEM_LINE.test(lines[i] ?? '')) return clip(line, TITLE_MAX)
  }
  return 'Checklist'
}

/** `text` without fenced code blocks, whose checkboxes are examples, not a list to track. */
export function withoutCodeFences(text: string): string {
  return text.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1\s*$/gm, '')
}

/** The text blocks of a stored message, joined. */
export function textOf(content: readonly unknown[]): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map(b => b.text)
    .join('\n')
}

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

type PlanTask = { id?: unknown; title?: unknown; status?: unknown; account?: unknown }

/**
 * A /harness run's plan.json as the pane's checklist, so the whiteboard follows
 * the run with no tick calls; null when the text is not a plan with tasks.
 */
export function planToChecklist(text: string, now: number): Checklist | null {
  let plan: { goal?: unknown; tasks?: unknown }
  try {
    plan = JSON.parse(text) as { goal?: unknown; tasks?: unknown }
  } catch {
    return null
  }
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) return null
  const items = (plan.tasks as PlanTask[]).map(task => {
    const suffix = (task.status === 'failed' ? ' (failed)' : '') + (task.account === 'work' ? ' · work account' : '')
    const status: ChecklistStatus = task.status === 'done' ? 'done' : task.status === 'doing' ? 'doing' : 'todo'
    return { text: clip(`${String(task.id ?? '')} ${String(task.title ?? '')}${suffix}`, ITEM_MAX), status }
  })
  const goal = typeof plan.goal === 'string' && plan.goal.trim() ? plan.goal : 'plan'
  return { title: clip(`Plan: ${goal}`, TITLE_MAX), items, updatedAt: now, source: 'assistant', isAnnounced: true }
}

/** Whether two checklists would draw the same, title, items and ticks included. */
export function sameBoard(a: Checklist | null, b: Checklist | null): boolean {
  if (!a || !b) return a === b
  return a.title === b.title && a.items.length === b.items.length &&
    a.items.every((it, i) => it.text === b.items[i]?.text && it.status === b.items[i]?.status)
}

/**
 * Identifies a reply checklist by its items and their ticks, so a later reply
 * restating the same items with new ticks reads as unseen.
 */
export function replyKey(list: Checklist): string {
  return list.items.map(it => `${MARK[it.status]} ${it.text.trim().toLowerCase()}`).join('\n')
}

/** Whether two checklists list the same items in the same order, ticks aside. */
export function sameItems(a: Checklist, b: Checklist): boolean {
  return a.items.length === b.items.length && a.items.every((it, i) => sameText(it.text, b.items[i]?.text ?? ''))
}

/**
 * What the pane shows after one of Claude's replies contains `found`: the
 * same list restated keeps its title and announcement with the reply's ticks;
 * a different list replaces it and still needs announcing.
 */
export function adoptReplyChecklist(current: Checklist | null, found: Checklist): Checklist {
  if (current && sameItems(current, found)) {
    return { ...current, items: found.items, updatedAt: found.updatedAt }
  }
  return { ...found, source: 'assistant', isAnnounced: false }
}

/** A markdown checklist in `text`, or null when it has fewer than two items. */
export function parseChecklist(text: string, now: number, source: Checklist['source'] = 'user'): Checklist | null {
  const lines = text.split('\n')
  const items: ChecklistItem[] = []
  let firstItem = -1
  lines.forEach((line, i) => {
    const match = ITEM_LINE.exec(line)
    if (!match) return
    if (firstItem < 0) firstItem = i
    items.push({ text: clip(match[2] ?? '', ITEM_MAX), status: statusOfMark(match[1] ?? ' ') })
  })
  if (items.length < MIN_ITEMS) return null
  return { title: titleAbove(lines, firstItem), items, updatedAt: now, source, isAnnounced: source === 'user' }
}

export type ChecklistUpdate = { item: number; status: ChecklistStatus }

/** Validates the tool's input; returns the updates or a message for the model. */
export function readUpdates(input: Record<string, unknown>, size: number): ChecklistUpdate[] | string {
  const raw = asArray(input.updates)
  if (!raw || raw.length === 0) return 'Pass updates: [{ item, status }].'
  const updates: ChecklistUpdate[] = []
  for (const entry of raw) {
    const item = (entry as { item?: unknown }).item
    const status = (entry as { status?: unknown }).status
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 1 || item > size) {
      return `Item numbers run from 1 to ${size}.`
    }
    if (typeof status !== 'string' || !STATUSES.includes(status as ChecklistStatus)) {
      return `Status must be one of: ${STATUSES.join(', ')}.`
    }
    updates.push({ item, status: status as ChecklistStatus })
  }
  return updates
}

export function applyUpdates(list: Checklist, updates: readonly ChecklistUpdate[], now: number): Checklist {
  const byIndex = new Map(updates.map(u => [u.item - 1, u.status]))
  return {
    ...list,
    items: list.items.map((it, i) => ({ ...it, status: byIndex.get(i) ?? it.status })),
    updatedAt: now,
  }
}

export function progress(list: Checklist): { done: number; total: number } {
  return { done: list.items.filter(i => i.status === 'done').length, total: list.items.length }
}

const MARK: Record<ChecklistStatus, string> = { todo: '[ ]', doing: '[~]', done: '[x]' }

/**
 * The checklist as numbered lines, for the model. Numbered `#1`, not `1.`, so
 * these notes and tool results never read as a markdown checklist themselves.
 */
export function describeChecklist(list: Checklist): string {
  const { done, total } = progress(list)
  const lines = list.items.map((it, i) => `#${i + 1} ${MARK[it.status]} ${it.text}`)
  return `${list.title} (${done}/${total} done)\n${lines.join('\n')}`
}

type StoredToolUse = { tool: string; input?: Record<string, unknown>; isError?: boolean }

/** Whether a stored tool call put a new list in the pane (items or a planFile), not just ticks. */
function setsChecklist(use: StoredToolUse): boolean {
  if (use.tool !== CHECKLIST_TOOL_FULL || use.isError) return false
  const input = use.input ?? {}
  return input.items !== undefined || (typeof input.planFile === 'string' && input.planFile.trim() !== '')
}

/**
 * A checklist Claude wrote since the last message with text from the user's
 * side, scanning back from the latest; null otherwise. It never reaches past
 * that message, nor past a checklist tool call that set a list (that list is
 * newer than any reply list at or before it), so an old list cannot come back
 * when the mod's state is fresh (a resumed session). Catches reply text the
 * `session.append` hook did not see.
 */
export function latestReplyChecklist(
  messages: readonly { role: 'user' | 'assistant'; text: string; toolUses?: readonly StoredToolUse[] }[],
  now: number,
): Checklist | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.toolUses?.some(setsChecklist)) return null
    if (!message?.text) continue
    if (message.role === 'user') return null
    const found = parseChecklist(withoutCodeFences(message.text), now, 'assistant')
    if (found) return found
  }
  return null
}

/** The note the model reads beside a prompt once a new checklist is in the pane. */
export function checklistContext(list: Checklist): string {
  const lead = list.source === 'assistant'
    ? "The checklist from your last reply is now shown in the user's Agent Office pane:\n"
    : "The user's checklist is now shown in their Agent Office pane:\n"
  return (
    lead +
    `${describeChecklist(list)}\n` +
    `As you work, call the ${CHECKLIST_TOOL_FULL} tool to mark items doing and done, so the pane stays ` +
    'current. Mark an item done only once its work is actually finished and checked.'
  )
}
