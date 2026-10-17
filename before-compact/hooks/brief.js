// The default for userConfig summary_instructions: this plugin's brief for the
// compaction summarizer. One paragraph of plain prose, appended after whatever was
// typed after /compact (hooks/register.js, the session.compact hook). The person
// can replace it or clear it in /config.
//
// It asks for what a summary flattens and this plugin exists to keep: the user's
// own words where they are short, decisions at their latest state with the reason
// for any change, verified apart from assumed, and the loose ends. The idea of a
// standing brief for the summarizer is Better Compact's (koenvdheide/prep-compact,
// MIT); the text is this plugin's own, and it keeps the exploratory record that
// that plugin's brief tells the summarizer to drop.
//
// plugin.json carries the same text as the knob's `default` (what /config shows and
// what seeds register(on, options)); test/run.sh fails if the two drift apart.
export const BRIEF = "In the summary, keep the user's stated constraints and corrections, quoted verbatim where they are short and otherwise close to their wording. Record each decision with its latest state; where a decision was reversed or changed, say so and give the reason, and prefer the latest state over any earlier one. Keep what was verified by running, reading or testing separate from what was assumed or inferred, and label each. List the open threads: questions not yet answered, work started but not finished, and anything the user said they would come back to."
