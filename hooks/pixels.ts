// Shared pixel-art drawing helpers: every board and the office are drawn on
// one small grid and scaled up with crisp edges.

/** The markup's own size multiplier, large so the drawing fills its box. */
export const FILL_SCALE = 8

/** Monospace glyphs are about this wide relative to the font size. */
const GLYPH_WIDTH = 0.6

export const SVG_STYLE = '<style>text{font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:700}</style>'

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`)
}

export function rect(x: number, y: number, w: number, h: number, fill: string, extra = ''): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${extra}/>`
}

export function text(x: number, y: number, size: number, fill: string, body: string, anchor = 'middle'): string {
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${anchor}">${escapeXml(body)}</text>`
}

/** How many characters of `size` text fit across `width` art pixels. */
export function charsThatFit(width: number, size: number): number {
  return Math.max(4, Math.floor(width / (size * GLYPH_WIDTH)))
}

export function textWidth(body: string, size: number): number {
  return body.length * size * GLYPH_WIDTH
}

export function clipText(body: string, max: number): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Word-wraps `body` to lines of at most `max` characters; the last kept line is clipped. */
export function wrapText(body: string, max: number, maxLines: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of body.replace(/\s+/g, ' ').trim().split(' ')) {
    const next = line ? `${line} ${word}` : word
    if (next.length <= max) {
      line = next
      continue
    }
    if (line) lines.push(line)
    line = word
  }
  if (line) lines.push(line)
  if (lines.length <= maxLines) return lines
  const kept = lines.slice(0, maxLines)
  kept[maxLines - 1] = clipText(`${kept[maxLines - 1]} ${lines.slice(maxLines).join(' ')}`, max)
  return kept
}

/** A complete SVG document of `width` × `height` art pixels. */
export function svgDocument(width: number, height: number, defs: string, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width * FILL_SCALE}" height="${height * FILL_SCALE}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">${SVG_STYLE}<defs>${defs}</defs>${body}</svg>`
}
