import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { parseAssumptions } from '../hooks/register'

const PANE = {
  plugin: 'side',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'side',
  props: { title: 'Side', isFocused: false, bodyColumns: 60, placement: 'dock' },
} as const

const DONE = {
  answer: 'Done.',
  durationMs: 1000,
  isAborted: false,
  reason: 'answer',
  category: null,
  explanation: null,
} as const

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

/**
 * Seats the engine beneath the plugin and records what reaches it: the
 * context of each prompt, the rows appended, the questions forked.
 */
function seat(on: On, forkReply = 'The header is not used elsewhere\nTests run with pnpm') {
  const seen = { contexts: [] as (readonly string[] | undefined)[], rows: [] as string[], forks: 0, opened: [] as string[], shown: false }
  const clock = mock.clock(on)

  on('session.start', () => ({ cwd: '/x' }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('ui.panes', () => ({ value: seen.shown ? [{ id: 'side', title: 'Side', isShown: true, isFocused: false, isPlaced: true }] : [] }) as any)
  on('ui.open', ($, e) => {
    seen.opened.push(e.id)

    return { value: { isShown: true } } as any
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => {
    seen.contexts.push(e.context)

    return { text: e.text, context: e.context }
  })
  on('session.append', ($, e) => {
    seen.rows.push(JSON.stringify(e.message.content))

    return { message: e.message, uuid: 'u1' } as any
  })
  on('model.fork', () => {
    seen.forks += 1

    return { value: { isAnswered: true, text: forkReply, usage: USAGE } } as any
  })

  return { seen, clock }
}

async function start($: Engine) {
  await $.session.start({ cwd: '/x' } as any)

  return $.ui.mount(PANE as any)
}

describe('parseAssumptions', () => {
  test('strips bullets and numbers, caps at five', () => {
    const reply = '- one\n2. two\n* three\nfour\nfive\nsix'
    expect(parseAssumptions(reply)).toEqual(['one', 'two', 'three', 'four', 'five'])
  })

  test('NONE means no assumptions', () => {
    expect(parseAssumptions('NONE')).toEqual([])
    expect(parseAssumptions('none.')).toEqual([])
  })
})

describe('side pane', () => {
  test('a note stays in the pane and never reaches the agent', async ($, on) => {
    const { seen } = seat(on)
    const ui = await start($)

    await $.turn.start({ text: 'work', turnId: 't1' })
    await $.ui.input({ plugin: 'side', key: 'note-0', text: 'tell it about the header' })
    expect(await ui.find({ text: 'tell it about the header' })).toBeDefined()
    expect(seen.rows).toEqual([])

    await $.prompt.submit({ text: 'go on' } as any)
    expect(seen.contexts.at(-1)).toBeUndefined()
  })

  test('x removes a note', async ($, on) => {
    seat(on)
    const ui = await start($)

    await $.ui.input({ plugin: 'side', key: 'note-0', text: 'temporary' })
    const remove = await ui.find({ type: 'Button', text: 'x' })
    await ui.press({ key: remove!.key! })
    expect(await ui.find({ text: 'temporary' })).toBeUndefined()
  })

  test('a turn asks nothing, even with the pane open; ask now lists doubts, numbered', async ($, on) => {
    const { seen, clock } = seat(on)
    const ui = await start($)
    await $.command.run({ command: 'side', args: '' } as any)

    await $.turn.start({ text: 'work', turnId: 't1' })
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await clock.advance(1)
    expect(seen.forks).toBe(0)

    await ui.press({ key: 'check' })
    expect(seen.forks).toBe(1)
    expect(await ui.find({ text: '1. The header is not used elsewhere' })).toBeDefined()
    expect(await ui.find({ text: '2. Tests run with pnpm' })).toBeDefined()
  })
})

describe('/side', () => {
  test('opens the pane, then closes it', async ($, on) => {
    const { seen } = seat(on)
    const closed: string[] = []
    on('ui.close', ($, e) => {
      closed.push(e.id)

      return { value: undefined } as any
    })
    await $.session.start({ cwd: '/x' } as any)

    const first = await $.command.run({ command: 'side' } as any)
    expect(seen.opened).toEqual(['side'])
    expect(JSON.stringify(first)).toContain('opened')

    seen.shown = true
    const second = await $.command.run({ command: 'side' } as any)
    expect(closed).toEqual(['side'])
    expect(JSON.stringify(second)).toContain('closed')
  })
})
