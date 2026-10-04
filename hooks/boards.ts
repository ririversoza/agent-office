import type { Checklist, ChecklistItem, PrStatus, Worker } from '../types'
import { progress } from './checklist'
import { charsThatFit, clipText, rect, svgDocument, text, textWidth, wrapText } from './pixels'
import { type OfficeColumns, describeOffice, officeArt } from './scene'

// The PR note and the checklist whiteboard are drawn in the office's pixel
// style and stacked with it into one picture, so the pane reads as one scene.

const BOARD_GAP = 3
const PAD = 10
const CHIP_SIZE = 4.2
const CHIP_H = 7
const CHIP_GAP = 3
const ITEM_SIZE = 4.6
const ITEM_LINE_H = 6
const ITEM_MAX_LINES = 2
const NOTE_H = ITEM_LINE_H + 3

/** The largest Svg the desktop draws: pixels each way, and characters of source. */
export const SVG_MAX_PX = 4096
export const SVG_MAX_CHARS = 131072

const CORK = {
  frame: '#6b4428', cork: '#c99a5b', speck: '#b0814a', paper: '#fff8e7', paperEdge: '#e6dcc3',
  pin: '#e05555', pinShade: '#8a2b2b', ink: '#3a2f4a', dim: '#7d6f8f',
} as const

const CHIPS = {
  needReply: { bg: '#ffe08a', fg: '#7a5200' },
  clear: { bg: '#c8f0c0', fg: '#2e6b38' },
  unresolved: { bg: '#e4ddf0', fg: '#4b3b5e' },
  fresh: { bg: '#cfe8ff', fg: '#1d5a8f' },
  passing: { bg: '#c8f0c0', fg: '#2e6b38' },
  failing: { bg: '#ffd0cc', fg: '#9b2c22' },
  running: { bg: '#ffe9b8', fg: '#7a5200' },
  none: { bg: '#e8e4dc', fg: '#6b6355' },
} as const

const BOARD = {
  frame: '#8a8f9c', frameDark: '#6b6f7a', board: '#fdfdfb', marker: '#2b4a8f', ink: '#3a2f4a',
  done: '#a3a8b3', green: '#4caf6a', barEmpty: '#e3e6ec', doing: '#e3f0fc', doingBox: '#7cc4f0',
  red: '#d64545', check: '#ffffff', dim: '#7d6f8f',
} as const

type Part = { height: number; body: string }
type Chip = { label: string; bg: string; fg: string }

function chipWidth(label: string): number {
  return Math.ceil(textWidth(label, CHIP_SIZE)) + 6
}

function chipsFor(pr: PrStatus): Chip[] {
  const chips: Chip[] = [
    pr.needReply > 0
      ? { label: `${pr.needReply} need a reply`, ...CHIPS.needReply }
      : { label: 'nothing waiting on you', ...CHIPS.clear },
  ]
  if (pr.unresolved > 0) chips.push({ label: `${pr.unresolved} unresolved`, ...CHIPS.unresolved })
  if (pr.newCount > 0) chips.push({ label: `${pr.newCount} new`, ...CHIPS.fresh })
  const ci = { passing: 'CI passing', failing: 'CI failing', running: 'CI running', none: 'no CI' }[pr.ci]
  chips.push({ label: ci, ...CHIPS[pr.ci] })
  return chips
}

/** Places chips left to right, wrapping onto new rows; returns rows used. */
function layoutChips(chips: readonly Chip[], x0: number, y0: number, maxX: number): { body: string; rows: number } {
  let x = x0
  let row = 0
  let body = ''
  for (const chip of chips) {
    const w = chipWidth(chip.label)
    if (x + w > maxX && x > x0) {
      row += 1
      x = x0
    }
    const y = y0 + row * (CHIP_H + 2)
    body += rect(x, y, w, CHIP_H, chip.bg) + text(x + 3, y + 5.2, CHIP_SIZE, chip.fg, chip.label, 'start')
    x += w + CHIP_GAP
  }
  return { body, rows: row + 1 }
}

/** The session's PR as a note pinned to a corkboard. */
export function prBoard(pr: PrStatus, width: number): Part {
  const chips = layoutChips(chipsFor(pr), PAD, 18, width - PAD)
  const chipsBottom = 18 + chips.rows * (CHIP_H + 2)
  const latestY = chipsBottom + 5
  const height = (pr.latest ? latestY : chipsBottom) + 6

  let body = rect(0, 0, width, height, CORK.frame) + rect(2, 2, width - 4, height - 4, CORK.cork)
  for (let i = 0; i < Math.floor(width / 7); i += 1) {
    body += rect(3 + ((i * 37) % (width - 6)), 3 + ((i * 13) % (height - 6)), 1, 1, CORK.speck)
  }
  body += rect(6, 5, width - 12, height - 9, CORK.paperEdge) + rect(6, 5, width - 13, height - 10, CORK.paper)
  const pinX = Math.round(width / 2)
  body += rect(pinX - 1, 3, 3, 3, CORK.pin) + rect(pinX, 5, 1, 1, CORK.pinShade)

  const titleMax = charsThatFit(width - 2 * PAD, 5)
  body += text(PAD, 13, 5, CORK.ink, clipText(`PR #${pr.number} · ${pr.title}`, titleMax), 'start')
  body += chips.body
  if (pr.latest) {
    const where = pr.latest.path ? ` on ${pr.latest.path.split('/').pop()}${pr.latest.line ? `:${pr.latest.line}` : ''}` : ''
    const line = `${pr.latest.author}${where}: “${pr.latest.body}”`
    body += text(PAD, latestY, 4, CORK.dim, clipText(line, charsThatFit(width - 2 * PAD, 4)), 'start')
  }
  return { height, body }
}

// A tick drawn inside the 4×4 inside of a 6×6 box: a short stroke down, a long one up.
const TICK = [[1, 2], [2, 3], [3, 2], [4, 1]] as const

function checkbox(item: ChecklistItem, x: number, y: number): string {
  const fill = item.status === 'done' ? BOARD.green : item.status === 'doing' ? BOARD.doingBox : BOARD.board
  let out = rect(x, y - 0.5, 6, 6, BOARD.frameDark) + rect(x + 1, y + 0.5, 4, 4, fill)
  if (item.status === 'done') {
    for (const [dx, dy] of TICK) out += rect(x + dx, y - 0.5 + dy, 1, 1, BOARD.check)
  }
  return out
}

/** How much of the checklist the whiteboard draws: lines per item, and how many items. */
export type BoardDetail = { itemLines: number; maxItems: number }

const FULL_DETAIL: BoardDetail = { itemLines: ITEM_MAX_LINES, maxItems: Infinity }

// From the most detail to the least: a long checklist first drops its second
// lines, then shows a run of items around the work in progress and counts
// the rest, until the picture fits what the desktop draws.
const DETAILS: readonly BoardDetail[] = [
  FULL_DETAIL,
  { itemLines: 1, maxItems: Infinity },
  ...[40, 24, 12, 6].map(maxItems => ({ itemLines: 1, maxItems })),
]

/** The items to draw when there are more than `maxItems`: from just before the first one not done. */
function visibleRange(items: readonly ChecklistItem[], maxItems: number): { start: number; end: number } {
  if (items.length <= maxItems) return { start: 0, end: items.length }
  const firstOpen = items.findIndex(it => it.status !== 'done')
  const focus = firstOpen < 0 ? items.length : firstOpen
  const start = Math.max(0, Math.min(focus - 1, items.length - maxItems))
  return { start, end: start + maxItems }
}

/** The checklist as an office whiteboard with a block progress bar. */
export function checklistBoard(list: Checklist, width: number, detail: BoardDetail = FULL_DETAIL): Part {
  const textMax = charsThatFit(width - 30, ITEM_SIZE)
  const { start, end } = visibleRange(list.items, detail.maxItems)
  const above = start
  const below = list.items.length - end
  const items = list.items.slice(start, end).map(item => ({ item, lines: wrapText(item.text, textMax, detail.itemLines) }))
  const itemsH = items.reduce((sum, it) => sum + it.lines.length * ITEM_LINE_H + 3, 0)
  const notesH = (above > 0 ? NOTE_H : 0) + (below > 0 ? NOTE_H : 0)
  const height = 24 + notesH + itemsH + 8
  const { done, total } = progress(list)
  const moreNote = (count: number, where: string, y: number) =>
    text(17, y + 4.4, ITEM_SIZE, BOARD.dim, `… ${count} more ${where}`, 'start')

  let body = rect(0, 0, width, height, BOARD.frame) + rect(2, 2, width - 4, height - 4, BOARD.board)
  body += text(8, 11, 5.5, BOARD.marker, clipText(list.title, charsThatFit(width - 40, 5.5)), 'start')
  body += text(width - 8, 11, 4.6, BOARD.dim, `${done} of ${total}`, 'end')

  const cells = Math.floor((width - 16) / 4)
  const filled = total === 0 ? 0 : Math.round((done / total) * cells)
  for (let i = 0; i < cells; i += 1) body += rect(8 + i * 4, 15, 3, 3, i < filled ? BOARD.green : BOARD.barEmpty)

  let y = 24
  if (above > 0) {
    body += moreNote(above, 'above', y)
    y += NOTE_H
  }
  for (const { item, lines } of items) {
    const blockH = lines.length * ITEM_LINE_H
    if (item.status === 'doing') {
      body += `<rect x="5" y="${y - 1.5}" width="${width - 10}" height="${blockH + 2}" fill="${BOARD.doing}"><animate attributeName="opacity" values="1;0.45;1" dur="2s" repeatCount="indefinite"/></rect>`
    }
    body += checkbox(item, 8, y)
    const color = item.status === 'done' ? BOARD.done : item.status === 'doing' ? BOARD.marker : BOARD.ink
    lines.forEach((line, k) => {
      const baseline = y + 4.4 + k * ITEM_LINE_H
      body += text(17, baseline, ITEM_SIZE, color, line, 'start')
      if (item.status === 'done') body += rect(17, baseline - 1.6, textWidth(line, ITEM_SIZE), 0.6, BOARD.done)
    })
    y += blockH + 3
  }
  if (below > 0) body += moreNote(below, 'below', y)

  body += rect(10, height - 5, 30, 2, BOARD.frameDark)
  body += rect(12, height - 6.5, 7, 1.5, BOARD.red) + rect(21, height - 6.5, 7, 1.5, BOARD.marker) + rect(30, height - 6.5, 7, 1.5, BOARD.green)
  return { height, body }
}

export type PanelInput = {
  workers: readonly Worker[]
  cols: OfficeColumns
  pr: PrStatus | null
  checklist: Checklist | null
}

/** The PR note, the office and the checklist whiteboard as one SVG document. */
export function renderPanel(
  { workers, cols, pr, checklist }: PanelInput,
  detail: BoardDetail = FULL_DETAIL,
): { svg: string; width: number; height: number } {
  const office = officeArt(workers, cols)
  const width = office.width
  const parts: string[] = []
  let y = 0
  const place = (part: Part) => {
    parts.push(`<g transform="translate(0 ${y})">${part.body}</g>`)
    y += part.height
  }
  if (pr) {
    place(prBoard(pr, width))
    y += BOARD_GAP
  }
  place(office)
  if (checklist) {
    y += BOARD_GAP
    place(checklistBoard(checklist, width, detail))
  }
  return { svg: svgDocument(width, y, office.defs, parts.join('')), width, height: y }
}

/** The height in pixels a panel is drawn at when it is `widthPx` wide. */
const heightAt = (panel: { width: number; height: number }, widthPx: number) => Math.round((widthPx * panel.height) / panel.width)

/**
 * The panel as the desktop's Svg draws it `widthPx` wide: within SVG_MAX_PX
 * each way and SVG_MAX_CHARS of source. A long checklist is drawn with less
 * detail until it fits; if even the least is too tall, the picture is scaled
 * down. The PR note and the whiteboard always stay in the picture.
 */
export function fitPanel(input: PanelInput, widthPx: number): { svg: string; widthPx: number; heightPx: number } {
  const details = input.checklist ? DETAILS : [FULL_DETAIL]
  let panel = renderPanel(input, FULL_DETAIL)
  for (const detail of details.slice(1)) {
    if (heightAt(panel, widthPx) <= SVG_MAX_PX && panel.svg.length < SVG_MAX_CHARS) break
    panel = renderPanel(input, detail)
  }
  const fittedWidth = Math.min(widthPx, SVG_MAX_PX, Math.floor((SVG_MAX_PX * panel.width) / panel.height))
  return { svg: panel.svg, widthPx: fittedWidth, heightPx: heightAt(panel, fittedWidth) }
}

/** The text version of the whole picture, for its alt text. */
export function describePanel({ workers, pr, checklist }: PanelInput): string {
  const parts = [describeOffice(workers)]
  if (pr) parts.push(`PR #${pr.number}: ${pr.needReply} need a reply, ${pr.unresolved} unresolved, CI ${pr.ci}.`)
  if (checklist) {
    const { done, total } = progress(checklist)
    parts.push(`${checklist.title}: ${done} of ${total} done.`)
  }
  return parts.join(' ')
}
