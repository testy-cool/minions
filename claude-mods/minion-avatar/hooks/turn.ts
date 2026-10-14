import type { ActivityEntry } from '../types'

/**
 * The newest turn in the history: its prompt, how it ended, and the steps
 * after it that are worth a row. Thoughts, and a turn that simply ended well,
 * have none; a turn that was interrupted, failed or declined keeps its row.
 */
export function latestTurn(entries: readonly ActivityEntry[]): {
  turn: ActivityEntry | undefined
  end: ActivityEntry | undefined
  steps: ActivityEntry[]
} {
  let at = entries.length - 1

  while (at >= 0 && entries[at]?.kind !== 'turn') {
    at -= 1
  }

  const turn = entries[at]
  const after = entries.slice(at + 1)

  return {
    turn,
    end: after.find(entry => entry.kind === 'end'),
    steps: after.filter(entry => entry.kind !== 'thought' && (entry.kind !== 'end' || entry.outcome !== 'ok')),
  }
}
