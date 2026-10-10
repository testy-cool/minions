/**
 * What the box says Claude is doing: `idle` between turns, a model phase
 * (`requesting`, `thinking`, `writing`, `composing`), a tool phase (`tool`,
 * `agent`, `approval`, `question`), or `compacting`.
 */
export type ActivityPhase =
  | 'idle'
  | 'requesting'
  | 'thinking'
  | 'writing'
  | 'composing'
  | 'tool'
  | 'agent'
  | 'approval'
  | 'question'
  | 'compacting'

/** The box's headline: the phase, its words, and when it began. */
export type ActivityNow = {
  phase: ActivityPhase
  label: string
  sinceMs: number
}

/**
 * A subagent at work: what it was asked to do, its latest action, and when
 * it started.
 */
export type ActivityAgent = {
  name: string
  label: string
  sinceMs: number
}

export type ActivityOutcome = 'ok' | 'error' | 'denied' | 'interrupted'

/**
 * One row of the expanded box: a prompt that started a turn, a stretch of
 * thinking, a reply, a tool call, a compaction, or how a turn ended.
 */
export type ActivityEntry = {
  kind: 'turn' | 'thought' | 'reply' | 'tool' | 'compact' | 'end'
  label: string
  durationMs: number | null
  outcome: ActivityOutcome
}

/** One rate-limit window and how much of it this session used. */
export type StatusLimit = { kind: string; percent: number; delta: number }

/** What the old status line showed, gathered after each turn. */
export type StatusInfo = {
  model: string
  effort?: string
  ctxTokens: number
  ctxPercent: number
  cachePct: number | null
  outTokens: number
  limits: StatusLimit[]
  cwd: string
  branch?: string
  isDirty: boolean
  lastCommit?: string
  home?: string
  hasSide: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'minion-avatar': {
      frame: string | null
      now: ActivityNow
      history: readonly ActivityEntry[]
      agents: readonly ActivityAgent[]
      isExpanded: boolean
      status: StatusInfo | null
      limitStart: Record<string, number>
    }
  }
}
