export type Assumption = { id: string; text: string }

/** A reminder the person wrote; never sent to the agent. */
export type SideNote = { id: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    side: {
      assumptions: Assumption[]
      notes: SideNote[]
      isChecking: boolean
      inputRound: number
      isOpen: boolean
    }
  }
}
