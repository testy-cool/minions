import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Assumption } from '../types'

const PANE = 'side'

const assumptions = atom({ plugin: 'side', key: 'assumptions' } as const, [])
const notes = atom({ plugin: 'side', key: 'notes' } as const, [])
const isChecking = atom({ plugin: 'side', key: 'isChecking' } as const, false)
const inputRound = atom({ plugin: 'side', key: 'inputRound' } as const, 0)
const isOpen = atom({ plugin: 'side', key: 'isOpen' } as const, false)

// Vlad's own /nice:doubts question, with the answer shape the panel needs.
export const ASK_ASSUMPTIONS = [
  'Pause the work for a moment. Do not use tools.',
  "Do you have concerns? What aren't you sure will work 100% perfectly?",
  'Reply with one concern per line, at most 5, the most important first.',
  'Each under 25 words, in plain everyday words a high school student',
  'would understand. No numbering, no preamble.',
  'If you have none, reply with the single word NONE.',
].join('\n')

const MAX_ASSUMPTIONS = 5

/** Splits the fork's reply into assumption lines, bullets and numbers stripped. */
export function parseAssumptions(reply: string): string[] {
  const lines = reply
    .split('\n')
    .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(line => line.length > 0)
  if (lines.length === 1 && /^none\.?$/i.test(lines[0] ?? '')) return []

  return lines.slice(0, MAX_ASSUMPTIONS)
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10)
}

// Reminders for the person alone: they never reach the agent.
async function submitNote($: EngineInterface, text: string) {
  const clean = text.trim()
  if (clean !== '') await update($, notes, list => [...list, { id: newId(), text: clean }])
  await update($, inputRound, n => n + 1)
}

async function removeNote($: EngineInterface, id: string) {
  await update($, notes, list => list.filter(note => note.id !== id))
}

async function checkAssumptions($: EngineInterface) {
  await update($, isChecking, () => true)
  try {
    const reply = await $.model.fork({ prompt: ASK_ASSUMPTIONS })
    if (!reply.isAnswered) return
    const judged = new Set((await read($, notes)).map(note => note.text))
    const fresh = parseAssumptions(reply.text)
      .filter(text => !judged.has(text))
      .map(text => ({ id: newId(), text }))
    await update($, assumptions, () => fresh)
  } finally {
    await update($, isChecking, () => false)
  }
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: 'Side' })
  await update($, isOpen, () => true)
}

/** Asks the engine, not the module, whether the pane is up: a reload or a missed close cannot fool it. */
async function isPaneOpen($: EngineInterface): Promise<boolean> {
  const panes = await $.ui.panes()

  // Open at all counts: a pane can be open while another tab is the one shown.
  return panes.some(pane => pane.id === PANE)
}

async function togglePane($: EngineInterface) {
  if (!(await isPaneOpen($))) return openPane($)
  await $.ui.close({ id: PANE })
  await update($, isOpen, () => false)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'side',
      description: "Open or close the side panel: the agent's unchecked guesses and your notes",
      immediate: true,
    })
    const shown = await isPaneOpen($)
    await update($, isOpen, () => shown)

    return next(e)
  })

  on('command.run', { command: 'side' }, async $ => {
    await togglePane($)

    return { text: (await read($, isOpen)) ? 'Side panel opened.' : 'Side panel closed.' }
  })

  on('ui.close', async ($, e, next) => {
    const done = await next(e)
    if (e.id === PANE) await update($, isOpen, () => false)

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    // Mobile draws no text field; notes are typed from the other surfaces.
    const Input = e.surface === 'mobile' ? undefined : $.ui.resolve(e).Input
    const found = await read($, assumptions)
    const pinned = await read($, notes)
    const checking = await read($, isChecking)
    const round = await read($, inputRound)

    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        <Box flexDirection="row" gap={1}>
          <Text bold>What the agent is unsure about</Text>
          {!checking && <Button key="check" label="ask now" onPress={() => void checkAssumptions($)} />}
        </Box>
        {checking && <Text dimColor>Asking the agent…</Text>}
        {!checking && found.length === 0 && <Text dimColor>None yet. Press ask now to ask the agent.</Text>}
        {found.map((item, i) => (
          <Text key={`a-${item.id}`} wrap="wrap">{`${i + 1}. ${item.text}`}</Text>
        ))}

        <Box marginTop={1}>
          <Text bold>Your notes (only you see these)</Text>
        </Box>
        {pinned.length === 0 && <Text dimColor>No notes yet.</Text>}
        {pinned.map(note => (
          <Box key={`n-${note.id}`} flexDirection="row" gap={1}>
            <Button key={`remove-${note.id}`} plain onPress={() => void removeNote($, note.id)}>
              x
            </Button>
            <Text wrap="wrap">{note.text}</Text>
          </Box>
        ))}

        {Input && (
          <Box marginTop={1}>
            <Input
              key={`note-${round}`}
              placeholder="A note to yourself"
              submitLabel="save"
              onSubmit={(value: string) => void submitNote($, value)}
            />
          </Box>
        )}
      </Box>
    )
  })
}
