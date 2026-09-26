/** Canonical inline skill-token grammar (#105 follow-up).
 *
 * One representation everywhere: the composer text carries `$skillname`
 * tokens — typed by hand, completed by the `$` menu, or written by a `/`
 * menu pick (which rewrites the leading `/query` into the same `$name`).
 * Chips are a *view* of these tokens, never separate state.
 */

/** A `$name` token anywhere in text. */
export const SKILL_TOKEN_RE = /\$([A-Za-z0-9_-]+)/g

/** A raw leading `/name` that is the ENTIRE message — Enter on it
 *  auto-invokes a matching skill (unpicked menu row); anything else with a
 *  leading slash stays literal text. */
export const LEADING_SLASH_RE = /^\/([A-Za-z0-9_-]+)$/

export interface TokenSpan {
  name: string
  start: number
  end: number
}

/** Valid tokens in `text`: every `$name` whose name is a known skill,
 *  plus a whole-message leading `/name` that is known. Unknown tokens are
 *  literal text — they invoke nothing and render no chip. */
export function extractValidTokens(text: string, known: Set<string>): TokenSpan[] {
  const out: TokenSpan[] = []
  for (const m of text.matchAll(SKILL_TOKEN_RE)) {
    if (!known.has(m[1])) continue
    out.push({ name: m[1], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length })
  }
  const slash = LEADING_SLASH_RE.exec(text)
  if (slash && known.has(slash[1])) {
    out.push({ name: slash[1], start: 0, end: slash[0].length })
  }
  return out
}

/** Skills to invoke for this message: deduped names of all valid tokens.
 *  Two tokens for the same skill still invoke it once. */
export function deriveInvokedSkills(text: string, known: Set<string>): string[] {
  const names: string[] = []
  for (const t of extractValidTokens(text, known)) {
    if (!names.includes(t.name)) names.push(t.name)
  }
  return names
}

/** What the skill menu is currently completing: a trailing `$query` at the
 *  very end of the input ($ trigger), or the input starting with `/`
 *  (slash trigger — start-of-input only). Returns null when no menu. */
export function menuQuery(
  input: string,
): { trigger: '$' | '/'; query: string; tokenStart: number } | null {
  if (input.startsWith('/')) {
    return { trigger: '/', query: input.slice(1), tokenStart: 0 }
  }
  const m = /\$([A-Za-z0-9_-]*)$/.exec(input)
  if (m) return { trigger: '$', query: m[1], tokenStart: m.index }
  return null
}

/** Replace the partial token the menu is completing with the canonical
 *  completed form: `$name ` (trailing space, cursor naturally lands after
 *  it). Works for both triggers — the slash form is just "the whole
 *  input is the token". The replaced range is tokenStart through the end
 *  of the typed partial (query + the trigger char). */
export function completeToken(
  input: string,
  mq: { trigger: '$' | '/'; query: string; tokenStart: number },
  name: string,
): string {
  const completed = `$${name} `
  if (mq.trigger === '/') return completed
  return input.slice(0, mq.tokenStart) + completed + input.slice(mq.tokenStart + mq.query.length + 1)
}
