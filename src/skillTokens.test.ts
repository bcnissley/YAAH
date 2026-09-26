import { describe, expect, it } from 'vitest'
import {
  extractValidTokens,
  deriveInvokedSkills,
  menuQuery,
  completeToken,
} from './skillTokens'

const KNOWN = new Set(['grill-me', 'handoff', 'impeccable'])

describe('extractValidTokens', () => {
  it('finds valid $tokens with spans', () => {
    expect(extractValidTokens('if i wanted to $handoff something', KNOWN)).toEqual([
      { name: 'handoff', start: 15, end: 23 },
    ])
  })

  it('ignores unknown tokens', () => {
    expect(extractValidTokens('costs $100 and $grill-mex', KNOWN)).toEqual([])
  })

  it('finds multiple tokens in order', () => {
    const t = extractValidTokens('$impeccable then $grill-me', KNOWN)
    expect(t.map((x) => x.name)).toEqual(['impeccable', 'grill-me'])
    expect(t[0].start).toBe(0)
  })

  it('treats a whole-message leading /name as a token when known', () => {
    expect(extractValidTokens('/grill-me', KNOWN)).toEqual([{ name: 'grill-me', start: 0, end: 9 }])
  })

  it('a leading /name that is unknown is nothing', () => {
    expect(extractValidTokens('/gril-me', KNOWN)).toEqual([])
  })

  it('a leading /name with trailing text is literal (Q15: / is start-gesture, menu only)', () => {
    expect(extractValidTokens('/grill-me please', KNOWN)).toEqual([])
  })
})

describe('deriveInvokedSkills', () => {
  it('dedupes repeated tokens (Q11)', () => {
    expect(deriveInvokedSkills('$grill-me and again $grill-me', KNOWN)).toEqual(['grill-me'])
  })

  it('unknown names invoke nothing (Q13)', () => {
    expect(deriveInvokedSkills('$nope', KNOWN)).toEqual([])
  })

  it('merges $ tokens and leading /name', () => {
    expect(deriveInvokedSkills('/handoff', KNOWN)).toEqual(['handoff'])
  })
})

describe('menuQuery', () => {
  it('$ trigger: trailing partial token', () => {
    expect(menuQuery('type $gril')).toEqual({ trigger: '$', query: 'gril', tokenStart: 5 })
    expect(menuQuery('type $')).toEqual({ trigger: '$', query: '', tokenStart: 5 })
  })

  it('no menu mid-text slash or lone dollar', () => {
    expect(menuQuery('a / b')).toBeNull()
    expect(menuQuery('money $5 later')).toBeNull()
  })

  it('/ trigger only at start of input', () => {
    expect(menuQuery('/gril')).toEqual({ trigger: '/', query: 'gril', tokenStart: 0 })
    expect(menuQuery('/')).toEqual({ trigger: '/', query: '', tokenStart: 0 })
    expect(menuQuery('hey /gril')).toBeNull()
  })
})

describe('completeToken', () => {
  it('$ pick replaces the partial with $name plus a trailing space (Q8)', () => {
    expect(completeToken('if i wanted to $gril something', { trigger: '$', query: 'gril', tokenStart: 15 }, 'grill-me')).toBe(
      'if i wanted to $grill-me  something',
    )
  })

  it('/ pick rewrites the whole leading token to canonical $name form', () => {
    expect(completeToken('/gril', { trigger: '/', query: 'gril', tokenStart: 0 }, 'grill-me')).toBe('$grill-me ')
  })
})
