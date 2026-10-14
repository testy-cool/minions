// Ported from What's Agent Doing by Tzafrir Rehan (MIT, LICENSE.whats-agent-doing),
// https://github.com/tzafrir/whats-agent-doing, drawn beside the portrait.
import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register, Timer, TurnCompleteReason, TurnStepChunk, TurnUsage } from 'claude-code'

import type {
  ActivityAgent,
  ActivityEntry,
  ActivityNow,
  ActivityOutcome,
  ActivityPhase,
  StatusInfo,
  StatusLimit,
} from '../types'
import { activityOf, partialArgsOf } from './activity-of'
import { faceSize, site, type Size } from './face'
import { gaugeRow, modelRow, repoRow } from './status'
import type { Piece } from './status'
import { latestTurn } from './turn'
import { clip, durationOf, oneLine, plural, printable, sizeOf, thoughtOf, wordsAdded } from './text'

const IDLE: ActivityNow = {
  phase: 'idle',
  label: 'Idle, waiting for your prompt',
  sinceMs: 0,
}

const MAX_HISTORY = 100
const MAX_STEP_ROWS = 8
const MAX_THOUGHT_CHARS = 70
const MAX_THOUGHT_BUFFER = 2000
const MAX_INPUT_HEAD = 4000
const LARGE_INPUT_CHARS = 1024
const MAX_LABEL_CHARS = 120
const MAX_AGENT_NAME_CHARS = 40
const MAX_AGENT_ROWS = 6
const STREAM_THROTTLE_MS = 250
const TICK_MS = 1000

const frame = atom({ plugin: 'minion-avatar', key: 'frame' } as const, null as string | null)

const now = atom({ plugin: 'minion-avatar', key: 'now' } as const, IDLE)

const history = atom(
  { plugin: 'minion-avatar', key: 'history' } as const,
  [] as readonly ActivityEntry[],
)

const team = atom(
  { plugin: 'minion-avatar', key: 'agents' } as const,
  [] as readonly ActivityAgent[],
)

const isExpanded = atom(
  { plugin: 'minion-avatar', key: 'isExpanded' } as const,
  false,
)

const status = atom({ plugin: 'minion-avatar', key: 'status' } as const, null as StatusInfo | null)

const limitStart = atom({ plugin: 'minion-avatar', key: 'limitStart' } as const, {} as Record<string, number>)

const PHASE_COLORS: Record<ActivityPhase, string> = {
  idle: 'gray',
  requesting: 'cyan',
  thinking: 'magenta',
  writing: 'green',
  composing: 'blue',
  tool: 'cyan',
  agent: 'cyan',
  approval: 'yellow',
  question: 'yellow',
  compacting: 'blue',
}

const OUTCOME_MARKS: Record<ActivityOutcome, { mark: string; color: string }> = {
  ok: { mark: '✓', color: 'green' },
  error: { mark: '✗', color: 'red' },
  denied: { mark: '⊘', color: 'yellow' },
  interrupted: { mark: '■', color: 'gray' },
}

const KIND_MARKS: Partial<Record<ActivityEntry['kind'], { mark: string; color: string }>> = {
  turn: { mark: '›', color: 'white' },
  reply: { mark: '✎', color: 'green' },
  compact: { mark: '⇣', color: 'blue' },
}

/** What the model is doing in the main loop, between and around tool calls. */
type ModelPhase = 'idle' | 'requesting' | 'thinking' | 'writing' | 'composing' | 'compacting'

/** A main-loop tool call in flight. */
type Call = {
  tool: string
  label: string
  startMs: number
  isAwaitingApproval: boolean
}

/**
 * A subagent at work, from its spawn (or its first call, when the spawn came
 * before a reload) to its stop. `toolUseId` names the Agent call that started
 * it; `activeMs` is when it last did something.
 */
type Agent = {
  name: string
  label: string
  startMs: number
  activeMs: number
  toolUseId: string | null
  isBackground: boolean
}

/**
 * The module's live view of the session, from which the headline is drawn:
 * started over on a reload, while the headline and history in `$.state` stay.
 */
type Live = {
  calls: Map<string, Call>
  agents: Map<string, Agent>
  agentNames: Map<string, string>
  described: Map<string, string>
  phase: ModelPhase
  phaseStartMs: number
  turnStartMs: number | null
  turnActions: number
  isFirstRequest: boolean
  resultsToReview: number
  thought: string
  replyWords: number
  isReplyInWord: boolean
  composing: { tool: string; head: string; chars: number } | null
  lastAction: string | null
  lastTurn: string | null
  lastPublishMs: number
  trailing: Timer | null
  isSweeping: boolean
  ticker: Timer | null
}

/**
 * Registers What's Agent Doing: a box above the prompt naming what Claude is
 * doing right now, and, behind its triangle, what it has done.
 *
 * The model's own stream (`turn.step`) says whether it is reading, thinking
 * (the thought's latest sentence), writing the reply or composing a tool's
 * input; `tool.call` says which tool runs, `classic.PermissionRequest` when
 * one waits for approval, and a subagent's calls show under its Agent call.
 *
 * @param on the engine's registrar
 */
// The portrait: a pi-agent-portrait set (the one the minion's pi config
// picks) played beside the activity box, reacting as pi-emote does.
type State =
  | 'hi' | 'idle' | 'heard' | 'think' | 'talk' | 'read' | 'write' | 'bash'
  | 'search' | 'tool' | 'success' | 'failure' | 'wait' | 'interrupted'
  | 'error' | 'compact' | 'sleep'

// takes[state][take] = the frame files of that take, in order
type Set = Partial<Record<State, string[][]>>


const CYCLE_MS = 500
const TALK_MS = 120
const SLEEP_AFTER_MS = 180000

const FALLBACK: Partial<Record<State, State>> = {
  heard: 'idle', wait: 'idle', sleep: 'idle', bash: 'tool', search: 'tool',
  interrupted: 'failure', error: 'failure',
}
// States that play once for a while, then hand over to the next one.
const HOLD: Partial<Record<State, [number, State | 'back']>> = {
  hi: [2000, 'idle'], heard: [700, 'think'], success: [1000, 'back'],
  failure: [1400, 'back'], interrupted: [1500, 'idle'], error: [2000, 'idle'],
}

async function loadSet($: EngineInterface): Promise<{ set: Set; size: Size } | null> {
  const root = await $.session.root()
  const base = `${root}/.pi/extensions/pi-emote`
  let name: string | undefined
  let size = faceSize()
  let isPlain = false
  try {
    const config = JSON.parse(await $.fs.read(`${base}/config.json`))
    size = faceSize(config.avatarRows)
    isPlain = config.avatarPlain === true
    const rules: { model?: string; 'emote-set'?: string }[] = config.emotes ?? []
    const model = (await $.session.model()).toLowerCase()
    const hit = rules.find(r => r.model && r.model !== '*' && model.includes(r.model.toLowerCase()))
      ?? rules.find(r => r.model === '*')
    name = hit?.['emote-set']
  } catch {}
  if (!name) {
    if (!(await $.fs.exists(`${base}/emotes`))) return null
    name = (await $.fs.list(`${base}/emotes`)).find(x => x.kind === 'dir')?.name
  }
  if (!name) return null
  const dir = `${base}/emotes/${name}`
  if (!(await $.fs.exists(dir))) return null

  const set: Set = {}
  for (const entry of await $.fs.list(dir)) {
    if (entry.kind !== 'dir') continue
    const files = (await $.fs.list(`${dir}/${entry.name}`))
      .map(x => x.name).filter(x => x.endsWith('.png')).sort()
    const byTake = new Map<string, string[]>()
    for (const file of files) {
      const take = /_v(\d+)\.png$/.exec(file)?.[1] ?? '1'
      byTake.set(take, [...(byTake.get(take) ?? []), `${dir}/${entry.name}/${file}`])
    }
    if (byTake.size) set[entry.name as State] = [...byTake.values()]
  }
  if (!Object.keys(set).length) return null

  // `avatarPlain` in a minion's config shows its frames as drawn, with no
  // scanlines and no frame.
  if (isPlain) return { set, size }
  return { set: await scanlined($, set, dir, `${base}/.scan-${size.px}/${name}`, size.px), size }
}

// Shrinks a frame to its drawn size, darkens every other pixel row and
// draws a thin frame into the picture; a copy is remade when its frame is newer.
// ImageMagick does the work.
const SCANLINE_SCRIPT = `
for src in "$@"; do
  dst="$CACHE/\${src#"$DIR"/}"
  [ -s "$dst" ] && [ ! "$src" -nt "$dst" ] && continue
  mkdir -p "$(dirname "$dst")"
  convert "$src" -resize "\$((PX - 8))x\$((PX - 8))" -channel RGB -fx 'j%2 ? u*0.82 : u' +channel \\
    -bordercolor '#141414' -border 2 -bordercolor '#6c6c6c' -border 2 "$dst" || exit 1
done
`

/** The set with scanlined copies of its frames, or as given when they cannot be made. */
async function scanlined($: EngineInterface, set: Set, dir: string, cache: string, px: number): Promise<Set> {
  const files = Object.values(set).flat(2)
  try {
    const run = await $.process.run(['sh', '-c', SCANLINE_SCRIPT, 'scanline', ...files], {
      env: { CACHE: cache, DIR: dir, PX: String(px) },
    })
    if (run.exitCode !== 0) return set
  } catch {
    return set
  }
  const moved = (file: string) => `${cache}/${file.slice(dir.length + 1)}`

  return Object.fromEntries(
    Object.entries(set).map(([state, takes]) => [state, takes.map(take => take.map(moved))]),
  ) as Set
}

function stateForTool(tool: string): State {
  const t = tool.toLowerCase()
  if (t === 'askuserquestion') return 'wait'
  if (t === 'read' || t === 'grep' || t === 'glob') return 'read'
  if (t === 'write' || t === 'edit' || t === 'notebookedit') return 'write'
  if (t === 'bash') return 'bash'
  if (/search|web|fetch|browse|scrape|crawl/.test(t)) return 'search'
  return 'tool'
}

const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]!

// The portrait's playback state; a reload starts it over, the drawn frame
// stays in $.state.
const face = {
  set: null as Set | null,
  size: faceSize(),
  state: 'idle' as State,
  working: 'idle' as State,
  frames: [] as string[],
  step: 0,
  ticker: null as Timer | null,
  hold: null as Timer | null,
  sleeper: null as Timer | null,
  blink: null as Timer | null,
}

function framesOf(s: State): string[] {
  let at: State | undefined = s
  while (at && !face.set?.[at]) at = FALLBACK[at]
  const takes = at ? face.set?.[at] : undefined
  return takes ? pick(takes) : []
}

// Swaps the drawn picture in place when the band is up, else redraws.
async function show($: EngineInterface, file: string | undefined) {
  if (!file || file === site.file) return
  site.file = file
  if (site.band) {
    try {
      const r = await $.ui.blit({ requestId: site.band, key: 'face', source: { file, format: 'png' } })
      if (!('deny' in r) || r.deny === undefined) return
    } catch {}
    site.band = undefined
  }
  await update($, frame, () => file)
}

// Reads the set and its size again and greets with it. Forgetting the band
// makes the next frame redraw it, so a new size takes effect too.
async function reloadFace($: EngineInterface) {
  stop()
  const loaded = await loadSet($)
  face.set = loaded?.set ?? null
  face.size = loaded?.size ?? faceSize()
  face.state = 'idle'
  site.band = undefined
  site.file = null
  go($, 'hi')
}

function stop() {
  for (const t of [face.ticker, face.hold, face.sleeper, face.blink]) t?.cancel()
  face.ticker = face.hold = face.sleeper = face.blink = null
}

function go($: EngineInterface, next: State) {
  if (!face.set) return
  if (next === face.state && (next === 'talk' || next === 'think' || next === 'idle')) return
  face.state = next
  stop()
  const frames = (face.frames = framesOf(next))
  face.step = 0
  if (!frames.length) return

  if (next === 'talk') {
    face.ticker = $.clock.every(TALK_MS, () => void show($, pick(frames)))
    void show($, frames[0])
    return
  }

  if (next === 'idle' || next === 'think') {
    // the resting face, and the blink or the hard look it flicks to now and then
    const rest = frames.find(f => !/_(blink|hard)/.test(f)) ?? frames[0]
    const alt = frames.filter(f => f !== rest)
    void show($, rest)
    if (alt.length) {
      face.ticker = $.clock.every(next === 'idle' ? 4000 : 1500, () => {
        void show($, pick(alt))
        face.blink = $.clock.after(next === 'idle' ? 160 : 700, () => void show($, rest))
      })
    }
    if (next === 'idle' && SLEEP_AFTER_MS > 0) {
      face.sleeper = $.clock.after(SLEEP_AFTER_MS, () => go($, 'sleep'))
    }
    return
  }

  void show($, frames[0])
  if (frames.length > 1) {
    face.ticker = $.clock.every(CYCLE_MS, () => {
      face.step += 1
      void show($, frames[face.step % frames.length])
    })
  }
  const h = HOLD[next]
  if (h) face.hold = $.clock.after(h[0], () => go($, h[1] === 'back' ? face.working : h[1]))
}

async function gitLine($: EngineInterface, cwd: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const run = await $.process.run(['git', ...args], { cwd })

    return run.exitCode === 0 ? run.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

async function effortLevel($: EngineInterface): Promise<string | undefined> {
  try {
    const home = await $.env.get('HOME')
    const settings = JSON.parse(await $.fs.read(`${home}/.claude/settings.json`)) as { effortLevel?: unknown }

    return typeof settings.effortLevel === 'string' ? settings.effortLevel : undefined
  } catch {
    return undefined
  }
}

/**
 * Gathers what the old status line showed. `usage` is the turn that just
 * ended, for the cache share and the output count.
 */
async function refreshStatus($: EngineInterface, usage?: TurnUsage) {
  try {
    await gatherStatus($, usage)
  } catch {
    // The rows keep their last facts; the old status line is no worse off.
  }
}

async function gatherStatus($: EngineInterface, usage?: TurnUsage) {
  const [model, used, cwd, effort, home, commands] = await Promise.all([
    $.session.model(),
    $.session.usage(),
    $.session.cwd(),
    effortLevel($),
    $.env.get('HOME'),
    $.command.list(),
  ])
  const [branch, porcelain, lastCommit] = await Promise.all([
    gitLine($, cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    gitLine($, cwd, ['status', '--porcelain']),
    gitLine($, cwd, ['log', '-1', '--format=%ar']),
  ])

  const known = await read($, limitStart)
  const fresh = used.rateLimits.filter(limit => known[limit.kind] === undefined)
  if (fresh.length > 0) {
    await update($, limitStart, start => ({
      ...start,
      ...Object.fromEntries(fresh.map(limit => [limit.kind, limit.percentUsed])),
    }))
  }
  const start = await read($, limitStart)
  const limits: StatusLimit[] = used.rateLimits.map(limit => ({
    kind: limit.kind,
    percent: limit.percentUsed,
    delta: Math.max(0, limit.percentUsed - (start[limit.kind] ?? limit.percentUsed)),
  }))

  const prompt = usage ? usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens : 0
  await update($, status, last => ({
    model,
    effort,
    ctxTokens: used.context.tokens ?? 0,
    ctxPercent: used.context.percent ?? 0,
    cachePct: usage && prompt > 0 ? Math.round((usage.cache_read_input_tokens / prompt) * 100) : (last?.cachePct ?? null),
    outTokens: (last?.outTokens ?? 0) + (usage?.output_tokens ?? 0),
    limits,
    cwd,
    branch,
    isDirty: Boolean(porcelain),
    lastCommit,
    home,
    hasSide: commands.some(command => command.name === 'side'),
  }))
}

export const register: Register = (on, options) => {
  const showStatus = options.statusRows === true

  const live: Live = {
    calls: new Map(),
    agents: new Map(),
    agentNames: new Map(),
    described: new Map(),
    phase: 'idle',
    phaseStartMs: 0,
    turnStartMs: null,
    turnActions: 0,
    isFirstRequest: false,
    resultsToReview: 0,
    thought: '',
    replyWords: 0,
    isReplyInWord: false,
    composing: null,
    lastAction: null,
    lastTurn: null,
    lastPublishMs: 0,
    trailing: null,
    isSweeping: false,
    ticker: null,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'portrait',
      description: "Reload this minion's portrait: a redrawn face, or a changed size or look",
      immediate: true,
    })
    await reloadFace($)

    const result = await next(e)

    await publish($, live)
    $.clock.after(0, () => void refreshStatus($))

    return result
  })

  on('command.run', { command: 'portrait' }, async $ => {
    await reloadFace($)

    return { text: face.set ? 'Portrait reloaded.' : 'No portrait set found for this minion.' }
  })

  on('prompt.submit', ($, e, next) => {
    face.working = 'think'
    go($, 'heard')

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    go($, 'compact')
    const result = await next(e)
    go($, 'idle')

    return result
  })

  on('turn.start', async ($, e, next) => {
    if (live.turnStartMs !== null) {
      return next(e)
    }

    live.turnStartMs = await $.clock.now()
    live.turnActions = 0
    live.isFirstRequest = true
    live.resultsToReview = 0
    live.lastAction = null
    live.calls.clear()

    const prompt = oneLine(e.text)

    if (prompt !== '') {
      await remember($, { kind: 'turn', label: clip(prompt, 60), durationMs: null, outcome: 'ok' })
    }

    await enter($, live, 'requesting')

    keepTicking($, live)
    await publish($, live)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      return yield* next(e)
    }

    await enter($, live, 'requesting')
    await publish($, live)

    try {
      for await (const chunk of next(e)) {
        if (chunk.kind === 'thinking' && face.state !== 'think') {
          face.working = 'think'
          go($, 'think')
        }
        if (chunk.kind === 'text' && face.state !== 'talk') {
          face.working = 'talk'
          go($, 'talk')
        }
        await follow($, live, chunk)
        yield chunk
      }
    } finally {
      live.isFirstRequest = false
      live.composing = null
      await enter($, live, 'requesting')
      await publish($, live)
    }
  })

  on('tool.call', async ($, e, next) => {
    const label = activityOf(e.tool, e as unknown as Record<string, unknown>)

    if (e.agentId !== undefined) {
      const agent = await agentOf($, live, e.agentId)

      // Kept after the call: the agent's last action stands while it thinks.
      agent.label = label
      agent.activeMs = await $.clock.now()
      await publish($, live, false)

      try {
        return await next(e)
      } finally {
        agent.label = label
        await publish($, live, false)
      }
    }

    const startMs = await $.clock.now()

    live.calls.set(e.tool_use_id, { tool: e.tool, label, startMs, isAwaitingApproval: false })
    live.lastAction = label
    live.turnActions += 1
    face.working = 'think'
    go($, stateForTool(e.tool))
    await publish($, live)

    let outcome: ActivityOutcome = 'interrupted'

    try {
      const result = await next(e)

      outcome = result.deny !== undefined ? 'denied' : result.isError ? 'error' : 'ok'
      go($, outcome === 'ok' ? 'success' : 'failure')

      if (isAgentTool(e.tool)) {
        const args = e as unknown as Record<string, unknown>
        const handle = args['name']
        const description = args['description']

        // A named agent runs as a teammate, which the engine lists by the
        // call's `name`; the call's `description` is what to show for it.
        if (typeof handle === 'string' && typeof description === 'string' && oneLine(description) !== '') {
          live.described.set(handle, description)
          void sweep($, live)
        }

        await launched($, live, result.result, description)
      }

      return result
    } finally {
      live.calls.delete(e.tool_use_id)
      live.resultsToReview += 1

      await remember($, {
        kind: 'tool',
        label,
        durationMs: (await $.clock.now()) - startMs,
        outcome,
      })

      await publish($, live)
    }
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    if (e.agent_id !== undefined) {
      const agent = await agentOf($, live, e.agent_id)

      agent.label = `Waiting for your approval: ${agent.label}`
    } else {
      const waiting = [...live.calls.values()]
        .reverse()
        .find(call => call.tool === e.tool_name && !call.isAwaitingApproval)

      if (waiting) {
        waiting.isAwaitingApproval = true
      }
    }

    await publish($, live)

    return next(e)
  })

  // The run-in-background pill shows only under a call that is running, so
  // its drawing means the person has answered the approval it waited on.
  on('ui.render', { component: 'ToolProgress' }, ($, e, next) => {
    const call = live.calls.get(e.props.tool_use_id)

    if (call?.isAwaitingApproval) {
      call.isAwaitingApproval = false
      $.clock.after(0, () => void publish($, live))
    }

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)

    if (result.agentId !== undefined) {
      const startMs = await $.clock.now()
      const name = e.description || e.name || 'Agent'

      live.agentNames.set(result.agentId, name)
      live.agents.set(result.agentId, {
        name,
        label: 'Getting started',
        startMs,
        activeMs: startMs,
        toolUseId: e.tool_use_id,
        isBackground: e.background,
      })
      keepTicking($, live)
      await publish($, live)
    }

    return result
  })

  on('classic.SubagentStop', async ($, e, next) => {
    await finish($, live, e.agent_id, 'ok')

    return next(e)
  })

  on('classic.PreCompact', async ($, e, next) => {
    await enter($, live, 'compacting')
    await publish($, live)

    return next(e)
  })

  on('classic.PostCompact', async ($, e, next) => {
    const durationMs = (await $.clock.now()) - live.phaseStartMs

    live.phase = live.turnStartMs === null ? 'idle' : 'requesting'
    await remember($, { kind: 'compact', label: 'Compacted the conversation', durationMs, outcome: 'ok' })
    await publish($, live)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      await finish($, live, e.agentId, outcomeOf(e.reason))

      return next(e)
    }

    if (live.turnStartMs === null) {
      return next(e)
    }

    const durationMs = (await $.clock.now()) - live.turnStartMs
    const took = durationOf(durationMs)

    const [label, outcome]: [string, ActivityOutcome] =
      e.reason === 'aborted'
        ? [`interrupted after ${took}`, 'interrupted']
        : e.reason === 'error'
          ? [`stopped on an error after ${took}`, 'error']
          : e.reason === 'refusal'
            ? ['declined the request', 'denied']
            : [`done in ${took}, ${plural(live.turnActions, 'action')}`, 'ok']

    face.working = 'idle'
    go($, e.reason === 'aborted' ? 'interrupted' : e.reason === 'error' ? 'error' : 'idle')
    await enter($, live, 'idle')
    await remember($, { kind: 'end', label: capitalized(label), durationMs, outcome })

    live.lastTurn = label
    live.turnStartMs = null
    live.calls.clear()

    keepTicking($, live)
    await publish($, live)
    const usage = e.usage
    $.clock.after(0, () => void refreshStatus($, usage))

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    // The band is one site for every plugin: what the plugins beneath draw
    // stays, under the box, so another mod's band is never hidden.
    const below = await next(e)

    const { Box, Text, Button } = $.ui.resolve(e)

    const headline = await read($, now)
    const entries = await read($, history)
    const working = await read($, team)
    const isOpen = await read($, isExpanded)
    const nowMs = await $.clock.now()

    const isWorking = headline.phase !== 'idle'
    const color = PHASE_COLORS[headline.phase]
    const elapsed = isWorking ? ` · ${durationOf(nowMs - headline.sinceMs)}` : ''

    // One agent the headline names; more, or one beside the main loop's
    // work, get a row each.
    const isTeamListed = working.length > 1 || (working.length === 1 && headline.phase !== 'agent')
    const listed = isTeamListed ? working.slice(-MAX_AGENT_ROWS) : []
    const unlisted = isTeamListed ? working.length - listed.length : 0

    const agentRows = listed.map((agent, i) => (
      <Box key={`agent-${i}`} flexDirection="row">
        <Box flexShrink={0}>
          <Text color={PHASE_COLORS.agent}>{'◆ '}</Text>
        </Box>
        <Text bold wrap="truncate-end">{printable(agent.name, MAX_AGENT_NAME_CHARS)}</Text>
        <Text wrap="truncate-end">{` › ${printable(agent.label, MAX_LABEL_CHARS)}`}</Text>
        <Box flexShrink={0}>
          <Text dimColor>{`  ${durationOf(nowMs - agent.sinceMs)}`}</Text>
        </Box>
      </Box>
    ))

    const moreAgents = unlisted > 0 ? [<Text dimColor>{`… ${plural(unlisted, 'more agent')}`}</Text>] : []

    const teamBox = isTeamListed
      ? [
          <Box key="agents" flexDirection="column">
            {agentRows}
            {moreAgents}
          </Box>,
        ]
      : []

    const teamRows = listed.length + moreAgents.length
    const { turn, steps } = latestTurn(entries)
    const stepRows = Math.min(MAX_STEP_ROWS, Math.max(2, e.props.maxRows - 4 - teamRows))
    const hidden = steps.length > stepRows ? steps.length - (stepRows - 1) : 0
    const shown = steps.slice(hidden)

    const rowOf = (entry: ActivityEntry, key: string, indent: string) => {
      const { mark, color: markColor } = KIND_MARKS[entry.kind] ?? OUTCOME_MARKS[entry.outcome]
      const took = entry.durationMs === null || entry.kind === 'end' || entry.kind === 'reply' ? '' : `  ${durationOf(entry.durationMs)}`

      return (
        <Box key={key} flexDirection="row">
          <Box flexShrink={0}>
            <Text color={markColor}>{`${indent}${mark} `}</Text>
          </Box>
          <Text bold={entry.kind === 'turn'} dimColor={entry.kind === 'end'} wrap="truncate-end">
            {printable(entry.label, MAX_LABEL_CHARS)}
          </Text>
          <Box flexShrink={0}>
            <Text dimColor>{took}</Text>
          </Box>
        </Box>
      )
    }

    const turnRow = turn ? [rowOf(turn, 'turn', '')] : []
    const stepList = shown.map((entry, i) => rowOf(entry, `row-${i}`, '  '))
    const earlier = hidden > 0 ? [<Text key="earlier" dimColor>{`  … ${hidden} earlier in this turn`}</Text>] : []
    const empty = entries.length === 0 ? [<Text key="empty" dimColor>No actions yet</Text>] : []

    const body = isOpen
      ? [
          <Box key="history" flexDirection="column" marginTop={1}>
            {turnRow}
            {earlier}
            {stepList}
            {empty}
          </Box>,
        ]
      : []

    // The old status line's two rows, beside the face instead of under the prompt.
    const info = await read($, status)
    const line = (key: string, pieces: Piece[]) => (
      <Text key={key} wrap="truncate-end">
        {pieces.map((piece, i) => (
          <Text key={`${key}-${i}`} color={piece.color} dimColor={piece.color === undefined}>
            {piece.text}
          </Text>
        ))}
      </Text>
    )
    const statusRows = showStatus && info
      ? [line('model', modelRow(info)), line('gauge', gaugeRow(info)), line('repo', repoRow(info))]
      : []

    // The side mod's pane, opened from the band's top row beside [-].
    const hasSide = info?.hasSide ?? false

    const file = site.file ?? (await read($, frame))
    site.band = file && e.surface === 'terminal' ? e.requestId : undefined
    // Only the terminal draws pictures.
    const Image = e.surface === 'terminal' ? $.ui.resolve(e).Image : undefined

    const box = (
      <Box flexDirection="column" flexGrow={1} justifyContent={isOpen ? 'flex-start' : showStatus ? 'flex-end' : 'center'}>
        {showStatus ? (
          <Box key="activity" flexDirection="row">
            {/* The headline: bright, its color the state. On a narrow screen only
                the label gives way: the rest would wrap. */}
            <Text bold color={isWorking ? color : 'white'} wrap="truncate-end">
              {printable(headline.label, MAX_LABEL_CHARS)}
            </Text>
            <Box flexShrink={0}>
              <Text dimColor>{elapsed}</Text>
            </Box>
            <Box flexShrink={0} marginLeft={2}>
              <Button
                key="toggle"
                plain
                dimColor
                label={isOpen ? 'history ▾' : 'history ▸'}
                onPress={() => update($, isExpanded, open => !open)}
              />
            </Box>
          </Box>
        ) : (
          <Box key="activity" flexDirection="row">
            <Button
              key="toggle"
              plain
              label={isOpen ? '▾' : '▸'}
              onPress={() => update($, isExpanded, open => !open)}
            />
            {/* On a narrow screen only the label gives way: the rest would wrap. */}
            <Box flexShrink={0}>
              <Text color={color}>{isWorking ? ' ● ' : ' ○ '}</Text>
            </Box>
            <Text wrap="truncate-end">{printable(headline.label, MAX_LABEL_CHARS)}</Text>
            <Box flexShrink={0}>
              <Text dimColor>{elapsed}</Text>
            </Box>
          </Box>
        )}
        {statusRows}
        {teamBox}
        {body}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          {site.band && file && Image ? (
            <Box flexShrink={0} marginRight={2}>
              <Image key="face" source={{ file, format: 'png' }} columns={face.size.columns} rows={face.size.rows} alt=" " />
            </Box>
          ) : null}
          {box}
        </Box>
        {below}
        {hasSide ? (
          <Box position="absolute" top={0} right={0}>
            <Button key="side" label="side" onPress={() => void $.command.run({ command: 'side' })} />
          </Box>
        ) : null}
      </Box>
    )
  })
}

/** The headline as the live view has it. */
function current(live: Live): ActivityNow {
  if (live.phase === 'compacting') {
    return { phase: 'compacting', label: 'Compacting the conversation', sinceMs: live.phaseStartMs }
  }

  const open = [...live.calls.entries()]
  const [newestId, newest] = open.at(-1) ?? []

  if (newestId !== undefined && newest !== undefined) {
    const more = open.length > 1 ? ` (+${open.length - 1} more)` : ''

    if (newest.isAwaitingApproval) {
      return {
        phase: 'approval',
        label: `Waiting for your approval: ${newest.label}${more}`,
        sinceMs: newest.startMs,
      }
    }

    if (newest.tool === 'AskUserQuestion') {
      return { phase: 'question', label: newest.label, sinceMs: newest.startMs }
    }

    const inner = isAgentTool(newest.tool) ? agentUnder(live, newestId)?.label : undefined

    return inner === undefined
      ? { phase: 'tool', label: `${newest.label}${more}`, sinceMs: newest.startMs }
      : { phase: 'agent', label: `${newest.label} › ${inner}${more}`, sinceMs: newest.startMs }
  }

  if (live.phase === 'idle' && live.agents.size > 0) {
    // Between turns, background agents may still be at work.
    const working = [...live.agents.values()]
    const sinceMs = Math.min(...working.map(agent => agent.startMs))
    const busiest = working.reduce((a, b) => (b.activeMs > a.activeMs ? b : a))

    return {
      phase: 'agent',
      label: working.length === 1
        ? `${busiest.name} › ${busiest.label}`
        : `${plural(working.length, 'agent')} working`,
      sinceMs,
    }
  }

  const sinceMs = live.phaseStartMs

  switch (live.phase) {
    case 'requesting':
      return {
        phase: 'requesting',
        label: live.isFirstRequest
          ? 'Reading your prompt'
          : live.resultsToReview > 0
            ? `Reviewing the results of ${plural(live.resultsToReview, 'action')}`
            : 'Waiting for the model',
        sinceMs,
      }
    case 'thinking': {
      // With no thought text to quote, the last action stands, the dot
      // turned to thinking's color; before any, the prompt is what it reads.
      const snippet = thoughtOf(live.thought, MAX_THOUGHT_CHARS)
      const label = snippet ? `Thinking: ${snippet}` : standingLabel(live)

      return { phase: 'thinking', label, sinceMs }
    }
    case 'writing':
      return {
        phase: 'writing',
        label: `Writing the reply · ${plural(live.replyWords, 'word')}`,
        sinceMs,
      }
    case 'composing': {
      // A call is named once its input says what it does: a file tool by
      // its path, a command by its description, which streams after the
      // command itself. Until then the last action stands.
      const { composing } = live
      const args = composing ? partialArgsOf(composing.head) : {}
      const isDescribed = composing !== null && (isShellTool(composing.tool)
        ? typeof args['description'] === 'string'
        : Object.keys(args).length > 0)

      if (!composing || !isDescribed) {
        return { phase: 'composing', label: standingLabel(live), sinceMs }
      }

      const size = composing.chars >= LARGE_INPUT_CHARS ? ` · ${sizeOf(composing.chars)}` : ''

      return { phase: 'composing', label: `${activityOf(composing.tool, args)}${size}`, sinceMs }
    }
    case 'idle':
      return live.lastTurn === null
        ? IDLE
        : { ...IDLE, label: `Idle · last turn ${live.lastTurn}` }
  }
}

/**
 * Writes the headline. A streaming update (`isUrgent` false) lands at most
 * every STREAM_THROTTLE_MS, the last one held on a timer.
 */
async function publish($: EngineInterface, live: Live, isUrgent = true): Promise<void> {
  const nowMs = await $.clock.now()

  if (!isUrgent && nowMs - live.lastPublishMs < STREAM_THROTTLE_MS) {
    live.trailing ??= $.clock.after(STREAM_THROTTLE_MS, () => {
      live.trailing = null
      void publish($, live)
    })

    return
  }

  live.lastPublishMs = nowMs
  const headline = current(live)
  const working = [...live.agents.values()].map(agent => ({
    name: agent.name,
    label: agent.label,
    sinceMs: agent.startMs,
  }))

  await update($, now, () => headline)
  await update($, team, () => working)
}

/** The agent at work under `agentId`, taken up if its spawn came before a reload. */
async function agentOf($: EngineInterface, live: Live, agentId: string): Promise<Agent> {
  const known = live.agents.get(agentId)

  if (known) {
    return known
  }

  const startMs = await $.clock.now()
  const agent: Agent = {
    name: live.agentNames.get(agentId) ?? 'Agent',
    label: 'Getting started',
    startMs,
    activeMs: startMs,
    toolUseId: null,
    isBackground: true,
  }

  live.agents.set(agentId, agent)
  keepTicking($, live)

  return agent
}

/**
 * Lets an agent go. A background agent's run is recorded in the history; a
 * foreground one's is its Agent call's row.
 */
async function finish(
  $: EngineInterface,
  live: Live,
  agentId: string,
  outcome: ActivityOutcome,
): Promise<void> {
  const agent = live.agents.get(agentId)

  if (!agent) {
    return
  }

  live.agents.delete(agentId)

  if (agent.isBackground) {
    await remember($, {
      kind: 'tool',
      label: `Agent: ${agent.name}`,
      durationMs: (await $.clock.now()) - agent.startMs,
      outcome,
    })
  }

  keepTicking($, live)
  await publish($, live)
}

/**
 * Names agents first met by their calls, and lets go of agents the engine
 * lists as no longer running, in case their stop never reached the box.
 */
async function sweep($: EngineInterface, live: Live): Promise<void> {
  if (live.agents.size === 0 || live.isSweeping) {
    return
  }

  live.isSweeping = true

  try {
    await sweepListed($, live, await $.agent.list())
  } catch {
    // The list is a backstop; the box keeps going without it.
  } finally {
    live.isSweeping = false
  }
}

async function sweepListed($: EngineInterface, live: Live, listed: readonly AgentInfo[]): Promise<void> {
  const statuses = new Map(listed.map(info => [info.id, info.status]))
  let isRenamed = false

  for (const [agentId, agent] of [...live.agents.entries()]) {
    const status = statuses.get(agentId)

    // An agent first met by its calls is named once the engine lists it.
    if (!live.agentNames.has(agentId)) {
      const handle = listed.find(info => info.id === agentId)?.name
      const described = handle === undefined ? undefined : live.described.get(handle)

      if (described !== undefined) {
        live.agentNames.set(agentId, described)
      }

      const name = described ?? handle

      if (name !== undefined && name !== agent.name) {
        agent.name = name
        isRenamed = true
      }
    }

    if (status !== undefined && status !== 'running') {
      await finish($, live, agentId, status === 'completed' ? 'ok' : status === 'failed' ? 'error' : 'interrupted')
    }
  }

  if (isRenamed) {
    await publish($, live)
  }
}

/**
 * Keeps the elapsed time ticking while a turn runs or an agent works, and
 * stops it once neither does.
 */
function keepTicking($: EngineInterface, live: Live): void {
  const isBusy = live.turnStartMs !== null || live.agents.size > 0

  if (isBusy && live.ticker === null) {
    live.ticker = $.clock.every(TICK_MS, () => {
      $.ui.invalidate('ui.render')
      void sweep($, live)
    })
  } else if (!isBusy && live.ticker !== null) {
    live.ticker.cancel()
    live.ticker = null
  }
}

async function remember($: EngineInterface, entry: ActivityEntry): Promise<void> {
  await update($, history, entries => [...entries, entry].slice(-MAX_HISTORY))
}

/** Enters a model phase, recording the thinking or reply block it closes. */
async function enter($: EngineInterface, live: Live, next: ModelPhase): Promise<void> {
  if (next === live.phase) {
    return
  }

  const nowMs = await $.clock.now()

  if (live.phase === 'writing' && live.replyWords > 0) {
    await remember($, {
      kind: 'reply',
      label: `Wrote the reply (${plural(live.replyWords, 'word')})`,
      durationMs: null,
      outcome: 'ok',
    })
  }

  if (next === 'thinking') {
    live.thought = ''
  }

  if (next === 'writing') {
    live.replyWords = 0
    live.isReplyInWord = false
  }

  live.phase = next
  live.phaseStartMs = nowMs
}

/** Follows one chunk of the main loop's response. */
async function follow($: EngineInterface, live: Live, chunk: TurnStepChunk): Promise<void> {
  switch (chunk.kind) {
    case 'thinking': {
      const isNew = live.phase !== 'thinking'

      await enter($, live, 'thinking')
      live.resultsToReview = 0
      live.thought = (live.thought + chunk.text).slice(-MAX_THOUGHT_BUFFER)
      await publish($, live, isNew)

      return
    }
    case 'text': {
      const isNew = live.phase !== 'writing'

      await enter($, live, 'writing')
      live.resultsToReview = 0
      const { added, isInWord } = wordsAdded(chunk.text, live.isReplyInWord)

      live.replyWords += added
      live.isReplyInWord = isInWord
      await publish($, live, isNew)

      return
    }
    case 'tool':
      await enter($, live, 'composing')
      live.resultsToReview = 0
      live.composing = { tool: chunk.name, head: '', chars: 0 }
      await publish($, live)

      return
    case 'input': {
      const { composing } = live

      if (composing) {
        composing.chars += chunk.json.length

        if (composing.head.length < MAX_INPUT_HEAD) {
          composing.head += chunk.json
        }

        await publish($, live, false)
      }

      return
    }
  }
}

/**
 * What the box keeps saying while Claude thinks or writes a call it cannot
 * name yet: the turn's last action, or the prompt before there is one.
 */
function standingLabel(live: Live): string {
  return live.lastAction ?? 'Reading your prompt'
}

/**
 * Names a background agent by the Agent call that launched it: the call's
 * short `description`, keyed by the id its result carries (the result's own
 * `description` can hold the whole prompt). Its own calls may already have
 * shown it.
 */
async function launched(
  $: EngineInterface,
  live: Live,
  result: unknown,
  asked: unknown,
): Promise<void> {
  if (typeof result !== 'object' || result === null) {
    return
  }

  const { agentId, description, status } = result as Record<string, unknown>

  if (typeof agentId !== 'string' || status !== 'async_launched') {
    return
  }

  const name = [asked, description].find(
    (text): text is string => typeof text === 'string' && oneLine(text) !== '',
  )

  if (name === undefined) {
    return
  }

  const agent = await agentOf($, live, agentId)

  live.agentNames.set(agentId, name)
  agent.name = name
  await publish($, live)
}

/** The agent an Agent call started, or the one that last did something. */
function agentUnder(live: Live, toolUseId: string): Agent | undefined {
  const working = [...live.agents.values()]

  return working.find(agent => agent.toolUseId === toolUseId)
    ?? working.reduce<Agent | undefined>((a, b) => (a === undefined || b.activeMs > a.activeMs ? b : a), undefined)
}

function outcomeOf(reason: TurnCompleteReason): ActivityOutcome {
  return reason === 'aborted' ? 'interrupted' : reason === 'error' ? 'error' : reason === 'refusal' ? 'denied' : 'ok'
}

function isShellTool(tool: string): boolean {
  return tool === 'Bash' || tool === 'PowerShell'
}

function isAgentTool(tool: string): boolean {
  return tool === 'Agent' || tool === 'Task'
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}