import type { On, TurnStepChunk } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const BAND = {
  plugin: 'minion-avatar',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const DONE = {
  answer: 'All fixed.',
  durationMs: 1000,
  isAborted: false,
  reason: 'answer',
  category: null,
  explanation: null,
} as const

const SPAWN = {
  prompt: 'Do the work.',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
} as const

const STEP = { turnId: 't1', model: 'claude-opus-5-5', messageCount: 1 } as const

/**
 * Stands for the engine beneath the band, which draws nothing of its own
 * there (the surveys aside).
 */
function seatBand(on: On) {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box key="engine" />
  })
}

/**
 * Seats the engine beneath the plugin: a clock, turns, a model whose steps
 * yield `script[index]`, and tools that answer `toolAnswer`. `seen` keeps
 * what the box said at each `look()` a step or a tool takes.
 */
function seat(on: On, script: readonly (readonly TurnStepChunk[])[]) {
  const box = {
    read: async () => '',
    seen: [] as string[],
    toolAnswer: { deny: 'stubbed in the test' } as { deny: string },
    onTool: async () => {},
  }

  const clock = mock.clock(on, { now: 1_000_000 })
  seatBand(on)

  const look = async () => {
    box.seen.push(await box.read())
  }

  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.PermissionRequest', () => ({}))

  on('turn.step', async function* ($, e) {
    for (const chunk of script[e.index] ?? []) {
      yield chunk
      await clock.advance(300)
      await look()
    }

    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: e.index + 1 < script.length ? 'tool_use' : 'end_turn',
      usage: null,
    } as const
  })

  on('tool.call', async () => {
    await box.onTool()
    await look()

    return box.toolAnswer
  })

  return { box, clock }
}

async function mount($: Engine, box: { read: () => Promise<string> }) {
  const ui = await $.ui.mount(BAND)

  box.read = async () => (await ui.find({ key: 'activity' }))?.text ?? ''
  // The history starts open; these tests start from the one-line view.
  await ui.press({ key: 'toggle' })

  return ui
}

async function step($: Engine, index: number) {
  for await (const _ of $.turn.step({ ...STEP, index })) {
    // drained: the beneath hook looks at the box between chunks
  }
}

describe('register', () => {
  test('the box says idle before any turn, its history open', async ($, on) => {
    mock.clock(on)
    seatBand(on)

    const ui = await $.ui.mount(BAND)
    const text = (await ui.find({ key: 'activity' }))?.text ?? ''

    expect(text.trim()).toBe('▾ No actions yet')
  })

  test('another plugin drawing the band keeps its box, under this one', async ($, on) => {
    mock.clock(on)

    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Box, Text } = $.ui.resolve(e)

      return (
        <Box key="beneath">
          <Text>2 tasks for you</Text>
        </Box>
      )
    })

    const ui = await $.ui.mount(BAND)

    expect((await ui.find({ key: 'activity' }))?.text ?? '').toContain('▾')
    expect((await ui.find({ key: 'beneath' }))?.text ?? '').toContain('2 tasks for you')
  })

  test('a turn reads, thinks, prepares, runs, reviews, writes and ends', async ($, on) => {
    const { box } = seat(on, [
      [
        { kind: 'thinking', index: 0, text: 'The config looks off. I should check the loader first' },
        { kind: 'tool', index: 1, id: 'tu1', name: 'Read' },
        { kind: 'input', index: 1, json: '{"file_path": "src/app.ts"' },
      ],
      [{ kind: 'text', index: 0, text: 'All fixed now, the loader reads it.' }],
    ])

    await mount($, box)

    const { turnId } = await $.turn.start({ text: 'fix the config', turnId: 't1' })

    expect(await box.read()).toContain('Reading your prompt')

    await step($, 0)

    expect(box.seen[0]).toContain('Thinking: I should check the loader first')
    expect(box.seen[1]).toContain('Reading your prompt')
    expect(box.seen[2]).toContain('Reading app.ts')
    expect(box.seen.join(' ')).not.toContain('Preparing')

    await $.tool.call({ tool: 'Read', file_path: 'src/app.ts' })

    expect(box.seen[3]).toContain('Reading app.ts')
    expect(await box.read()).toContain('Reviewing the results of 1 action')

    await step($, 1)

    expect(box.seen[4]).toContain('Writing the reply · 7 words')

    await $.turn.complete({ ...DONE, turnId })

    expect((await box.read()).trim()).toBe('▸')
  })

  test('the triangle opens the history of the turn', async ($, on) => {
    const { box } = seat(on, [
      [{ kind: 'thinking', index: 0, text: 'Look at the file.' }],
      [{ kind: 'text', index: 0, text: 'Done.' }],
    ])

    const ui = await mount($, box)

    const { turnId } = await $.turn.start({ text: 'fix the config', turnId: 't1' })

    await step($, 0)
    await $.tool.call({ tool: 'Read', file_path: 'src/app.ts' })
    await step($, 1)
    await $.turn.complete({ ...DONE, turnId })

    expect(await ui.find({ key: 'history' })).toBeUndefined()

    await ui.press({ key: 'toggle' })

    const history = (await ui.find({ key: 'history' }))?.text ?? ''

    expect(history).toContain('⊘ Reading app.ts')
    expect(history).toContain('Wrote the reply (1 word)')
    expect((await ui.find({ key: 'activity' }))?.text).toMatch(/▾\s+› fix the config/)
  })

  test('the history keeps only the latest turn, without thought or done rows', async ($, on) => {
    const { box } = seat(on, [[{ kind: 'thinking', index: 0, text: 'Think it over.' }]])
    const ui = await mount($, box)

    box.toolAnswer = { result: 'ok' } as never

    await $.turn.start({ text: 'first question', turnId: 't1' })
    await step($, 0)
    await $.tool.call({ tool: 'Read', file_path: 'old.ts' })
    await $.turn.complete({ ...DONE, turnId: 't1' })

    await $.turn.start({ text: 'second question', turnId: 't2' })
    await step($, 0)
    await $.tool.call({ tool: 'Read', file_path: 'new.ts' })
    await $.turn.complete({ ...DONE, turnId: 't2' })
    await ui.press({ key: 'toggle' })

    const history = (await ui.find({ key: 'history' }))?.text ?? ''
    const message = (await ui.find({ key: 'activity' }))?.text ?? ''

    expect(message).toContain('› second question')
    expect(message).not.toContain('first question')
    expect(history).toContain('✓ Reading new.ts')
    expect(history).not.toContain('first question')
    expect(history).not.toContain('old.ts')
    expect(history).not.toContain('earlier')
    expect(history).not.toContain('Thought')
    expect(history).not.toContain('Done in')
  })

  test('the step running now is the last row, and its clock is its own', async ($, on) => {
    const { box, clock } = seat(on, [])
    const ui = await mount($, box)
    const seen = { open: { row: '', steps: '' }, closed: '' }

    box.toolAnswer = { result: 'ok' } as never
    box.onTool = async () => {
      await clock.advance(2000)
      seen.closed = (await ui.find({ key: 'activity' }))?.text ?? ''
      await ui.press({ key: 'toggle' })
      seen.open.row = (await ui.find({ key: 'activity' }))?.text ?? ''
      seen.open.steps = (await ui.find({ key: 'history' }))?.text ?? ''
      await ui.press({ key: 'toggle' })
    }

    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: 'a.ts' })
    await clock.advance(5000)
    await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List the files' })

    // Closed: one line, the running step.
    expect(seen.closed).toMatch(/^▸\s+● List the files\s+2\.0s$/)
    // Open: the message row holds the whole turn's clock (2s + 5s + 2s).
    expect(seen.open.row).toMatch(/^▾\s+› fix it\s+9\.0s$/)
    // The finished step comes first and the running one is last.
    expect(seen.open.steps).toMatch(/✓ Reading a\.ts.*● List the files\s+2\.0s$/)
  })

  test('a finished turn shows its final time on the message row, and nothing running', async ($, on) => {
    const { box, clock } = seat(on, [])
    const ui = await mount($, box)

    await $.turn.start({ text: 'quick one', turnId: 't1' })
    await clock.advance(4200)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.advance(9000)
    await ui.press({ key: 'toggle' })

    expect((await ui.find({ key: 'activity' }))?.text).toMatch(/^▾\s+› quick one\s+4\.2s$/)
    expect((await ui.find({ key: 'history' }))?.text ?? '').not.toContain('●')
  })

  test('a turn that was interrupted keeps the row that says so', async ($, on) => {
    const { box } = seat(on, [])
    const ui = await mount($, box)

    await $.turn.start({ text: 'long job', turnId: 't1' })
    await $.turn.complete({ ...DONE, turnId: 't1', reason: 'aborted', isAborted: true })
    await ui.press({ key: 'toggle' })

    expect((await ui.find({ key: 'history' }))?.text ?? '').toContain('■ Interrupted after')
  })

  test('a long turn keeps its newest steps under one row counting the rest', async ($, on) => {
    const { box } = seat(on, [])
    const ui = await mount($, box)

    box.toolAnswer = { result: 'ok' } as never

    await $.turn.start({ text: 'read everything', turnId: 't1' })

    for (let i = 0; i < 10; i += 1) {
      await $.tool.call({ tool: 'Read', file_path: `f${i}.ts` })
    }

    await $.turn.complete({ ...DONE, turnId: 't1' })
    await ui.press({ key: 'toggle' })

    const history = (await ui.find({ key: 'history' }))?.text ?? ''

    expect(history).toContain('… 3 earlier in this turn')
    expect(history).not.toContain('f2.ts')
    expect(history).toContain('f3.ts')
    expect(history).toContain('f9.ts')
    expect(history.match(/✓/g)).toHaveLength(7)
  })

  test('thinking with no thought text keeps the last action', async ($, on) => {
    const { box } = seat(on, [
      [{ kind: 'thinking', index: 0, text: '' }],
      [{ kind: 'thinking', index: 0, text: '' }],
    ])

    await mount($, box)
    await $.turn.start({ text: 'fix the config', turnId: 't1' })
    await step($, 0)
    await $.tool.call({ tool: 'Read', file_path: 'src/app.ts' })
    await step($, 1)

    expect(box.seen[0]).toContain('Reading your prompt')
    expect(box.seen[2]).toContain('Reading app.ts')
    expect(box.seen.join(' ')).not.toContain('Thinking')
  })

  test('a command being written shows its description, never the command', async ($, on) => {
    const { box } = seat(on, [
      [
        { kind: 'tool', index: 0, id: 'tu1', name: 'Bash' },
        { kind: 'input', index: 0, json: '{"command": "npm test --silent"' },
        { kind: 'input', index: 0, json: ', "description": "Run the tests"' },
      ],
    ])

    await mount($, box)
    await $.turn.start({ text: 'test it', turnId: 't1' })
    await step($, 0)

    expect(box.seen[1]).toContain('Reading your prompt')
    expect(box.seen[2]).toContain('Run the tests')
    expect(box.seen.join(' ')).not.toContain('npm test')
  })

  test('control characters in a label never take the box down', async ($, on) => {
    const { box } = seat(on, [])
    const ui = await mount($, box)
    const esc = String.fromCharCode(27)
    const bel = String.fromCharCode(7)
    const rlo = String.fromCharCode(0x202e)

    await $.turn.start({ text: 'x', turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: `src/${esc}]0;title${bel}${esc}[31m${rlo}red.ts` })
    await $.tool.call({ tool: 'Read', file_path: `src/${'x'.repeat(200000)}.ts` })
    await ui.press({ key: 'toggle' })

    const history = (await ui.find({ key: 'history' }))?.text ?? ''

    expect(box.seen[0]).toContain('Reading')
    expect(box.seen[0]).toContain('red.ts')
    expect(box.seen[0]).not.toContain(esc)
    expect(box.seen[0]).not.toContain(rlo)
    expect(box.seen[1]?.length ?? 0).toBeLessThan(400)
    expect(history).toContain('red.ts')
  })

  test('a call waiting on a permission prompt says so', async ($, on) => {
    const { box } = seat(on, [])

    box.onTool = async () => {
      await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm test' } })
    }

    await mount($, box)
    await $.turn.start({ text: 'test it', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the tests' })

    expect(box.seen[0]).toContain('Waiting for your approval: Run the tests')
  })

  test('agents still at work after the turn keep the box busy', async ($, on) => {
    const { box, clock } = seat(on, [])

    on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: e.tool_use_id === 'tu1' ? 'a1' : 'a2' }))

    const ui = await mount($, box)
    const { turnId } = await $.turn.start({ text: 'launch the panel', turnId: 't1' })

    await $.agent.spawn({ ...SPAWN, tool_use_id: 'tu1', description: 'Draft the plan' })
    await $.agent.spawn({ ...SPAWN, tool_use_id: 'tu2', description: 'Storyboard the video' })
    await $.turn.complete({ ...DONE, turnId })
    // A call made inside a subagent's loop, which carries its id.
    await $.tool.call({ tool: 'Read', file_path: 'README.md', agentId: 'a1' } as Parameters<Engine['tool']['call']>[0])
    await clock.advance(300)

    const team = (await ui.find({ key: 'agents' }))?.text ?? ''

    expect(await box.read()).toContain('2 agents working')
    expect(team).toContain('Draft the plan › Reading README.md')
    expect(team).toContain('Storyboard the video › Getting started')

    await $.turn.complete({ ...DONE, turnId: 't2', agentId: 'a2' })

    expect(await box.read()).toContain('Draft the plan › Reading README.md')
    expect(await ui.find({ key: 'agents' })).toBeUndefined()

    await $.turn.complete({ ...DONE, turnId: 't3', agentId: 'a1', reason: 'error' })
    await ui.press({ key: 'toggle' })

    const history = (await ui.find({ key: 'history' }))?.text ?? ''

    expect(history).toContain('✓ Agent: Storyboard the video')
    expect(history).toContain('✗ Agent: Draft the plan')
  })

  test('a named agent is shown by its Agent call description, never its prompt', async ($, on) => {
    const { box, clock } = seat(on, [])

    on('agent.list', () => ({
      value: [{
        id: 'areviewer-1f2e',
        description: 'You are reviewing the diff. Read every file and',
        name: 'reviewer',
        type: 'general-purpose',
        status: 'running',
      }],
    }))

    const ui = await mount($, box)

    await $.tool.call({ tool: 'Read', file_path: 'src/app.ts', agentId: 'areviewer-1f2e' } as Parameters<Engine['tool']['call']>[0])
    await clock.advance(1000)

    // Before its Agent call is seen, the engine's handle for it stands.
    expect(await box.read()).toContain('reviewer › Reading app.ts')

    box.toolAnswer = { result: { status: 'teammate_spawned' } } as never
    await $.tool.call({
      tool: 'Agent',
      name: 'reviewer',
      description: 'Review the diff',
      prompt: 'You are reviewing the diff. Read every file and…',
    } as Parameters<Engine['tool']['call']>[0])
    await clock.advance(1000)

    expect(await box.read()).toContain('Review the diff › Reading app.ts')
    expect(await box.read()).not.toContain('You are reviewing')
    expect(await ui.find({ key: 'agents' })).toBeUndefined()
  })

  test('a background agent is named from the Agent call that launched it', async ($, on) => {
    const { box, clock } = seat(on, [])

    await mount($, box)

    box.toolAnswer = {
      result: { status: 'async_launched', agentId: 'b1', description: 'This is a long prompt. Read it all.' },
    } as never

    await $.tool.call({ tool: 'Agent', description: 'Tour the source', prompt: 'Read it.' } as Parameters<Engine['tool']['call']>[0])

    expect(await box.read()).toContain('Tour the source › Getting started')

    await $.tool.call({ tool: 'Read', file_path: 'src/app.ts', agentId: 'b1' } as Parameters<Engine['tool']['call']>[0])
    await clock.advance(300)

    expect(await box.read()).toContain('Tour the source › Reading app.ts')
  })
})
