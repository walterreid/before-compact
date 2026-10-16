// What the mod keeps in $.state, so a reload of hooks/register.js (every save while
// developing, and /reload-plugins) does not empty the pane. Declared here because
// `claude plugin validate` checks every atom in register.js against this file; the
// manifest's "types" field points at it.

/** One compaction the mod watched, as a row in the pane. null = not known (yet). */
export type Compaction = {
  id: string
  /** ISO time the compaction started (the session.compact hook saw it, or the script's record). */
  startedAt: string
  trigger: 'manual' | 'auto' | 'plugin' | null
  /** Set for a subagent's own compaction; null for the main conversation. */
  agentId: string | null
  /** The text typed after /compact, or a plugin's; null when the default summary prompt alone ran. */
  instructions: string | null
  /** How long next(e) took in the session.compact hook: the summary's wall time. */
  durationMs: number | null
  /** From the session.compact result (tokensBefore / tokensAfter) and the event's message lists. */
  beforeTokens: number | null
  afterTokens: number | null
  beforeMessages: number | null
  afterMessages: number | null
  /** From the script's PreCompact status record. */
  preAt: string | null
  saved: boolean | null
  savedTurns: number | null
  savedTokens: number | null
  bundle: string | null
  /** From the script's SessionStart(compact) status record. */
  postAt: string | null
  injected: boolean | null
  injectedTokens: number | null
  origin: string | null
  /** Phase 2: how many user turns the mod itself appended after the summary (inject_in_mod). */
  modAppended: number | null
  modChars: number | null
  /**
   * The summary the engine installed: the text of the first message in the
   * session.compact result, capped at 9,500 chars for the pane's Summary tab.
   */
  summary: string | null
  /** The arc file the script wrote beside the bundle (path, turns, size), from its PreCompact record. */
  arc: string | null
  arcTurns: number | null
  arcChars: number | null
}

/** The compaction in flight: opened by classic.PreCompact, completed by session.compact. */
export type Pending = Partial<Compaction> & { startedAt: string }

declare module 'claude-code' {
  interface PluginState {
    'before-compact': {
      compactions: Compaction[]
      pending: Pending | null
    }
  }
}
