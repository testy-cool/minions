// The two status-line rows, drawn beside the portrait instead of under the
// prompt: model and usage, then folder and git. Pure: the facts are gathered
// in register.tsx, which holds the `$` calls.

import type { StatusInfo } from '../types'

/** One colored run of text; `color` absent draws it dim. */
export type Piece = { text: string; color?: string }

const AUTO_COMPACT_BUFFER_PCT = 16.5

/** `claude-opus-5-5[1m]` → `Opus 5.5`; anything else as given. */
export function modelName(id: string): string {
  const match = /claude-([a-z]+)-(\d+)-(\d+)/.exec(id)
  if (match === null) return id
  const [, family = '', major, minor] = match

  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}.${minor}`
}

export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`

  return String(n)
}

/** Yellow from 70%, red from 90%; below that nothing, so the row stays dim. */
function warnColor(percent: number): string | undefined {
  return percent >= 90 ? 'red' : percent >= 70 ? 'yellow' : undefined
}

/** Context used as the old status line counted it: of the room left before auto-compact. */
export function contextUsed(percent: number): number {
  const usable = Math.max(0, ((100 - percent - AUTO_COMPACT_BUFFER_PCT) / (100 - AUTO_COMPACT_BUFFER_PCT)) * 100)

  return Math.max(0, Math.min(100, Math.round(100 - usable)))
}

const LIMIT_LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d' }

/** The model and its effort. */
export function modelRow(info: StatusInfo): Piece[] {
  return [{ text: info.effort ? `${modelName(info.model)} · ${info.effort}` : modelName(info.model) }]
}

/** The context gauge, then each rate-limit window; colored only when near full. */
export function gaugeRow(info: StatusInfo): Piece[] {
  const used = contextUsed(info.ctxPercent)
  const filled = Math.floor(used / 10)
  const pieces: Piece[] = [
    { text: `ctx ${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)} ${used}%`, color: warnColor(used) },
  ]
  for (const limit of info.limits) {
    const label = LIMIT_LABELS[limit.kind]
    if (label === undefined) continue
    const percent = Math.round(limit.percent)
    pieces.push({ text: '   ' }, { text: `${label} ${percent}%`, color: warnColor(percent) })
  }

  return pieces
}

/** The folder's own name, the branch with a mark when it has changes, and the last commit's age. */
export function repoRow(info: StatusInfo): Piece[] {
  const name = info.cwd.split('/').filter(Boolean).at(-1) ?? info.cwd
  let text = name
  if (info.branch) text += ` · ${info.branch}${info.isDirty ? '*' : ''}`
  if (info.lastCommit) text += ` · committed ${info.lastCommit}`

  return [{ text }]
}
