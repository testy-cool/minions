// Where the portrait is drawn: the band's site, for swapping frames in place.
export const site = {
  band: undefined as string | undefined,
  file: null as string | null,
}

// The portrait is ROWS cells high and twice as many columns wide, since a
// cell is about twice as tall as it is wide. A minion can ask for a bigger
// face with `avatarRows` in its own pi-emote config.json; every other
// minion keeps ROWS.
export const ROWS = 4

// One cell is about 21 pixels tall in Vlad's terminal font (measured from a
// screenshot), so frames are made at the size they are shown: square, as
// many cells high as the face, the frame drawn into the picture so its edges
// meet the cell edges of the text beside it (a box border is drawn mid-cell
// and cannot). Drawn at another size the terminal rescales them and the
// lines soften.
const CELL_PX = 21

/** How big one minion's portrait is drawn, in cells and in pixels. */
export type Size = { rows: number; columns: number; px: number }

export function faceSize(rows?: unknown): Size {
  const r = typeof rows === 'number' && Number.isInteger(rows) && rows >= 2 && rows <= 12 ? rows : ROWS
  return { rows: r, columns: r * 2, px: r * CELL_PX }
}

/**
 * How many rows of space sit above one minion's portrait, from `avatarMarginTop`
 * in its pi-emote config.json: a whole number from 0 to 4, else none.
 */
export function marginTopOf(rows?: unknown): number {
  return typeof rows === 'number' && Number.isInteger(rows) && rows >= 0 && rows <= 4 ? rows : 0
}
