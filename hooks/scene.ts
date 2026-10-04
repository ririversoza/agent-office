import type { Worker, WorkerKind } from '../types'
import { rect, svgDocument, text } from './pixels'
import { CODEX_ID, CURSOR_ID, LEAD_ID, defaultWorker, find } from './state'

// Art is drawn on a small pixel grid and scaled up with crisp edges (pixels.ts).
const HEADER_H = 40
const CELL_W = 48
const CELL_H = 50
const FIXED_DESKS = 3
const TEAM_TOP = HEADER_H + CELL_H + 8
const EMPTY_TEAM_H = 26
const MIN_PLANT_GAP = 10

/** Team desks per row; fewer columns make every desk bigger in a narrow pane. */
export type OfficeColumns = number

// The desktop draws an Svg in a fixed small box unless given a size, and only
// reports the pane's width in text columns. Measured on the desktop app: a
// column is about 8.3 CSS px, and the pane pads its content by ~16px.
const DESKTOP_PX_PER_COLUMN = 8.3
const PANE_PADDING_PX = 16
const MIN_OFFICE_PX = 320
/** Roughly how wide one desk should be drawn, which sets desks per row. */
const TARGET_DESK_PX = 200
const MIN_COLS = 3
const MAX_COLS = 6

/** How to draw the office in a pane `bodyColumns` text columns wide. */
export function paneLayout(bodyColumns: number): { cols: OfficeColumns; widthPx: number } {
  const widthPx = Math.max(MIN_OFFICE_PX, Math.round(bodyColumns * DESKTOP_PX_PER_COLUMN) - PANE_PADDING_PX)
  const cols = Math.min(MAX_COLS, Math.max(MIN_COLS, Math.floor(widthPx / TARGET_DESK_PX)))
  return { cols, widthPx }
}

export function artWidth(cols: OfficeColumns): number {
  return Math.max(cols, FIXED_DESKS) * CELL_W
}

/** The office's size in art pixels, for sizing the box it is drawn in. */
export function officeSize(workers: readonly Worker[], cols: OfficeColumns): { width: number; height: number } {
  const teamSize = workers.filter(w => w.id !== LEAD_ID && w.id !== CODEX_ID && w.id !== CURSOR_ID).length
  return { width: artWidth(cols), height: officeHeight(teamSize, cols) }
}

/** Even spacing for the codex / lead / cursor row across the office width. */
function fixedDeskGap(width: number): number {
  return (width - FIXED_DESKS * CELL_W) / (FIXED_DESKS + 1)
}

type Look = { hair: string; shirt: string; accent: string }

const LOOKS: Record<WorkerKind, Look> = {
  lead: { hair: '#4a2c5e', shirt: '#d97757', accent: '#ffd76a' },
  opus: { hair: '#5b3d8f', shirt: '#a67df2', accent: '#c9a8ff' },
  sonnet: { hair: '#24496b', shirt: '#4f9bd9', accent: '#8fd0ff' },
  haiku: { hair: '#2f5d36', shirt: '#6cc070', accent: '#b4f0a0' },
  fable: { hair: '#7a3f1d', shirt: '#e39b4a', accent: '#ffd08a' },
  codex: { hair: '#1f1f1f', shirt: '#f0f0f0', accent: '#10a37f' },
  cursor: { hair: '#3a3a3a', shirt: '#2b2b33', accent: '#9aa4ff' },
  agent: { hair: '#555555', shirt: '#9a9a9a', accent: '#dddddd' },
}

const SKINS = ['#f6d2b8', '#e8b896', '#c68d62', '#8d5a3b']

const C = {
  wall: '#4b3b5e',
  wallTrim: '#3a2d4a',
  frame: '#2b2238',
  sky: '#9fd3f5',
  cloud: '#ffffff',
  sign: '#ffd76a',
  signText: '#e9dcf5',
  plank: '#d9c3a0',
  plankSeam: '#c7ad86',
  rug: '#b9a3e3',
  rugEdge: '#9a82cc',
  chair: '#5a4a6a',
  deskTop: '#a8744a',
  deskFront: '#8a5a35',
  deskLeg: '#6b4428',
  laptop: '#c9ccd6',
  plate: '#f5e6d0',
  ink: '#3a2f4a',
  dim: '#8a7aa0',
  ok: '#2e7d4f',
  bad: '#c0392b',
  amber: '#f0b429',
  off: '#9b9b9b',
  pot: '#b5653a',
  leaf: '#4f9a4f',
  leafDark: '#3c7a3c',
} as const

// 12-wide sprite rows. h hair, s skin, e eye, d shut eye, p blush, m mouth, c shirt, y crown.
const HEAD_TOP = ['...hhhhhh...', '..hhhhhhhh..', '.hhhhhhhhhh.', '.hhsssssshh.', '.hssssssssh.']
const EYES_OPEN = ['.hseesseesh.', '.hseesseesh.']
const EYES_SHUT = ['.hssssssssh.', '.hsddssddsh.']
const HEAD_BOTTOM = ['.hpssmmssph.', '..ssssssss..']
const BODY = ['...cccccc...', '..cccccccc..', '.cccccccccc.', '.cccccccccc.', '.cccccccccc.']
const CROWN = ['...y.yy.y...', '...yyyyyy...']

/** Run-length encodes each sprite row into as few rects as possible. */
function sprite(rows: readonly string[], colors: Record<string, string>, x: number, y: number): string {
  let out = ''
  rows.forEach((row, r) => {
    let c = 0
    while (c < row.length) {
      const ch = row[c] ?? '.'
      let end = c + 1
      while (end < row.length && row[end] === ch) end += 1
      const fill = colors[ch]
      if (fill) out += rect(x + c, y + r, end - c, 1, fill)
      c = end
    }
  })
  return out
}

function hash(id: string): number {
  let n = 0
  for (const ch of id) n = (n * 31 + ch.charCodeAt(0)) >>> 0
  return n
}

/** Discrete two-frame blink between visible and hidden. */
function frames(phase: 'a' | 'b', dur: number, delay: number): string {
  const values = phase === 'a' ? '1;0' : '0;1'
  return `<animate attributeName="opacity" values="${values}" keyTimes="0;0.5" calcMode="discrete" dur="${dur}s" begin="-${delay}s" repeatCount="indefinite"/>`
}

function statusLine(w: Worker): { label: string; color: string } {
  if (w.status === 'working') return { label: w.activity || w.task || 'working', color: C.ok }
  if (w.status === 'done') return { label: 'done ✓', color: C.ok }
  if (w.status === 'failed') return { label: 'failed', color: C.bad }
  if (w.id === LEAD_ID) return { label: 'waiting for you', color: C.dim }
  if ((w.id === CODEX_ID || w.id === CURSOR_ID) && !w.task) return { label: 'off duty', color: C.dim }
  return { label: 'idle', color: C.dim }
}

function lampColor(w: Worker): string {
  if (w.status === 'working') return '#3ddc84'
  if (w.status === 'failed') return C.bad
  if (w.status === 'done') return C.off
  return C.amber
}

function character(w: Worker, x0: number, y0: number, delay: number): string {
  const look = LOOKS[w.kind]
  const skin = w.kind === 'lead' ? SKINS[0] : SKINS[hash(w.id) % SKINS.length]
  const colors = {
    h: look.hair, s: skin ?? '#f6d2b8', e: '#2a1e2e', d: '#6b4a3a',
    p: '#f2a0a0', m: '#a0453f', c: look.shirt, y: C.sign,
  }
  const isAwake = w.status === 'working' || w.status === 'failed'
  const rows = [...HEAD_TOP, ...(isAwake ? EYES_OPEN : EYES_SHUT), ...HEAD_BOTTOM, ...BODY]
  const cx = x0 + 18
  const cy = y0 + 5
  let out = sprite(rows, colors, cx, cy)
  if (w.kind === 'lead') out += sprite(CROWN, colors, cx, cy - 2)

  if (w.status !== 'working') return `<g>${out}</g>`
  const bob = `<animateTransform attributeName="transform" type="translate" values="0 0;0 -1" calcMode="discrete" dur="0.9s" begin="-${delay}s" repeatCount="indefinite"/>`
  const handsA = rect(x0 + 17, y0 + 17, 2, 1, colors.s) + rect(x0 + 29, y0 + 18, 2, 1, colors.s)
  const handsB = rect(x0 + 17, y0 + 18, 2, 1, colors.s) + rect(x0 + 29, y0 + 17, 2, 1, colors.s)
  return `<g>${out}${bob}</g><g>${handsA}${frames('a', 0.36, delay)}</g><g opacity="0">${handsB}${frames('b', 0.36, delay)}</g>`
}

function zzz(x0: number, y0: number, delay: number): string {
  return [0, 0.7, 1.4]
    .map(offset => {
      const begin = -(delay + offset)
      return `<text x="${x0 + 32}" y="${y0 + 8}" font-size="4.5" fill="${C.dim}" opacity="0">z<animate attributeName="y" values="${y0 + 9};${y0 + 1}" dur="2.1s" begin="${begin}s" repeatCount="indefinite"/><animate attributeName="opacity" values="0;1;0" dur="2.1s" begin="${begin}s" repeatCount="indefinite"/></text>`
    })
    .join('')
}

function desk(w: Worker, x0: number, y0: number, index: number, hasRug: boolean): string {
  const look = LOOKS[w.kind]
  const delay = (index * 0.23) % 1
  const isGone = w.status === 'done'
  let out = ''

  if (hasRug) out += rect(x0 + 1, y0 + 24, 46, 14, C.rugEdge) + rect(x0 + 2, y0 + 25, 44, 12, C.rug)
  out += rect(x0 + 16, y0 + 9, 16, 10, C.chair)
  if (!isGone) out += character(w, x0, y0, delay)

  // desk, legs, laptop lid seen from behind, status lamp
  out += rect(x0 + 6, y0 + 19, 36, 2, C.deskTop)
  out += rect(x0 + 8, y0 + 21, 32, 9, C.deskFront)
  out += rect(x0 + 9, y0 + 30, 2, 3, C.deskLeg) + rect(x0 + 37, y0 + 30, 2, 3, C.deskLeg)
  out += rect(x0 + 19, y0 + 14, 10, 5, C.laptop)
  const glow = w.status === 'working'
    ? `<animate attributeName="opacity" values="1;0.35;1" dur="1.6s" begin="-${delay}s" repeatCount="indefinite"/>`
    : ''
  out += `<rect x="${x0 + 23}" y="${y0 + 15}" width="2" height="2" fill="${look.accent}" opacity="${w.status === 'working' ? 1 : 0.4}">${glow}</rect>`
  out += rect(x0 + 38, y0 + 17, 2, 2, lampColor(w))
  if (w.model) out += text(x0 + 24, y0 + 27.5, 3.8, C.plate, w.model)

  if (w.status === 'idle') out += zzz(x0, y0, delay)
  if (w.status === 'failed') {
    out += rect(x0 + 31, y0 + 2, 7, 7, C.bad) + text(x0 + 34.5, y0 + 7.6, 6, '#ffffff', '!')
  }
  if (isGone) out += rect(x0 + 21, y0 + 15, 6, 4, '#c8f0c0') + text(x0 + 24, y0 + 18.3, 3.6, C.ok, '✓')

  const { label, color } = statusLine(w)
  out += text(x0 + 24, y0 + 39, 5.5, C.ink, w.name)
  out += text(x0 + 24, y0 + 46, 4.2, color, label)

  return `<g${isGone ? ' opacity="0.6"' : ''}>${out}</g>`
}

function plant(x: number, y: number): string {
  return rect(x + 2, y, 4, 3, C.leaf) + rect(x, y + 2, 8, 3, C.leafDark) + rect(x + 1, y + 1, 2, 2, C.leaf)
    + rect(x + 5, y + 1, 2, 2, C.leaf) + rect(x + 1, y + 5, 6, 5, C.pot)
}

function header(workers: readonly Worker[], width: number): string {
  const count = (s: Worker['status']) => workers.filter(w => w.status === s).length
  const summary = `${count('working')} working · ${count('idle')} idle · ${count('done')} done`
  let out = rect(0, 0, width, HEADER_H, C.wall) + rect(0, HEADER_H - 4, width, 4, C.wallTrim)
  for (const wx of [8, width - 32]) {
    out += rect(wx - 1, 5, 26, 20, C.frame) + rect(wx, 6, 24, 18, C.sky)
    out += `<g>${rect(wx + 2, 9, 7, 2, C.cloud)}${rect(wx + 3, 8, 4, 1, C.cloud)}<animateTransform attributeName="transform" type="translate" values="0 0;13 0;0 0" dur="14s" repeatCount="indefinite"/></g>`
    out += rect(wx + 11, 6, 2, 18, C.frame) + rect(wx, 14, 24, 2, C.frame)
  }
  const signW = Math.min(100, width - 72)
  const signX = (width - signW) / 2
  out += rect(signX, 6, signW, 17, C.frame) + rect(signX + 1, 7, signW - 2, 15, C.wallTrim)
  out += text(width / 2, 18, 8, C.sign, 'AGENT OFFICE')
  out += text(width / 2, 31.5, 5, C.signText, summary)
  return out
}

function teamDesks(team: readonly Worker[], cols: OfficeColumns, width: number): string {
  if (team.length === 0) {
    return text(width / 2, TEAM_TOP + 14, 4.5, C.dim, 'no subagents yet')
  }
  const left = (width - cols * CELL_W) / 2
  return team
    .map((w, i) => desk(w, left + (i % cols) * CELL_W, TEAM_TOP + Math.floor(i / cols) * CELL_H, i + FIXED_DESKS, false))
    .join('')
}

export function officeHeight(teamSize: number, cols: OfficeColumns): number {
  const teamH = teamSize === 0 ? EMPTY_TEAM_H : Math.ceil(teamSize / cols) * CELL_H
  return TEAM_TOP + teamH + 4
}

export type Art = { width: number; height: number; defs: string; body: string }

/** The office's drawing, to stand alone or be stacked with the boards. */
export function officeArt(workers: readonly Worker[], cols: OfficeColumns): Art {
  const fixed = [CODEX_ID, LEAD_ID, CURSOR_ID].map(id => find(workers, id) ?? defaultWorker(id, 0))
  const team = workers.filter(w => w.id !== LEAD_ID && w.id !== CODEX_ID && w.id !== CURSOR_ID)
  const width = artWidth(cols)
  const height = officeHeight(team.length, cols)
  const gap = fixedDeskGap(width)

  const defs = `<pattern id="planks" width="24" height="8" patternUnits="userSpaceOnUse">${rect(0, 0, 24, 8, C.plank)}${rect(0, 7, 24, 1, C.plankSeam)}${rect(12, 0, 1, 7, C.plankSeam)}</pattern>`
  const floor = `<rect x="0" y="${HEADER_H}" width="${width}" height="${height - HEADER_H}" fill="url(#planks)"/>`
  const plants = gap >= MIN_PLANT_GAP ? plant(1, HEADER_H + 6) + plant(width - 9, HEADER_H + 6) : ''
  const fixedDesks = fixed.map((w, i) => desk(w, gap + i * (CELL_W + gap), HEADER_H, i, w.id === LEAD_ID)).join('')
  const divider = rect(0, TEAM_TOP - 5, width, 1, C.plankSeam) + text(3, TEAM_TOP - 1, 3.8, C.dim, 'TEAM', 'start')
  const body = `${floor}${header([...fixed, ...team], width)}${plants}${fixedDesks}${divider}${teamDesks(team, cols, width)}`
  return { width, height, defs, body }
}

/** The whole office as one SVG document. */
export function renderOffice(workers: readonly Worker[], cols: OfficeColumns = 4): string {
  const art = officeArt(workers, cols)
  return svgDocument(art.width, art.height, art.defs, art.body)
}

/** One-line text version, used as the SVG's alt text. */
export function describeOffice(workers: readonly Worker[]): string {
  const working = workers.filter(w => w.status === 'working')
  if (working.length === 0) return 'Agent Office: nobody is working right now.'
  return `Agent Office: ${working.map(w => `${w.name}${w.model ? ` (${w.model})` : ''} ${w.activity || 'working'}`).join('; ')}.`
}
