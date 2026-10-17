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
  /** What the summarizer was told: the text typed after /compact (first) and the summary_instructions knob's text; null when neither. */
  instructions: string | null
  /** The text typed after /compact alone (or a plugin's), so the row can show it apart from the knob's; null when nothing was typed. */
  typed: string | null
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
  /**
   * The arc file the script wrote beside the bundle for this compaction's window
   * (path, turns, size, the file's own token figure), from its PreCompact record.
   */
  arc: string | null
  arcTurns: number | null
  arcChars: number | null
  arcTokens: number | null
  /** The digest experiment (digest_in_precompact): what the mod wrote before this compaction, or null. `error` set when nothing was written. */
  digest: { model: string; chars: number | null; turns: number | null; durationMs: number | null; error?: string } | null
  /** From the script's SessionStart(compact) record: how many chars of the digest it printed ahead of the turns (0: none was fresh). */
  digestInjected: number | null
  /**
   * The assistant side (the second hook of each event, --side assistant): its
   * PreCompact record (the bundle precompact-<session>-assistant.txt) and its
   * SessionStart(compact) record, the row's second SessionStart line. Null on a
   * row from before the assistant side existed, or when no record arrived.
   * `assistantInjected` false with an origin starting "stood down" or "off" is a
   * dash in the pane, not a failure.
   */
  assistantPreAt: string | null
  assistantSaved: boolean | null
  assistantSavedTurns: number | null
  assistantSavedTokens: number | null
  assistantBundle: string | null
  assistantPostAt: string | null
  assistantInjected: boolean | null
  assistantTokens: number | null
  assistantOrigin: string | null
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
