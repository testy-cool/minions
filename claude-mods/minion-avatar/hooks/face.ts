// Where the portrait is drawn: the band's site, for swapping frames in place.
export const site = {
  band: undefined as string | undefined,
  file: null as string | null,
}

export const COLUMNS = 8
export const ROWS = 4

// One cell is about 21 pixels tall in Vlad's terminal font (measured from a
// screenshot), so frames are made at the size they are shown: square, ROWS
// cells high, the frame drawn into the picture so its edges meet the cell
// edges of the text beside it (a box border is drawn mid-cell and cannot).
// Drawn at another size the terminal rescales them and the lines soften.
export const FRAME_PX = ROWS * 21
