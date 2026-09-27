import { describe, expect, it } from 'vitest'
import { nearestRowByY, reorderIds } from './workspaceReorder'

describe('reorderIds (#42)', () => {
  it('moves the dragged id to the target index', () => {
    expect(reorderIds([1, 2, 3, 4], 1, 3)).toEqual([2, 3, 1, 4])
    expect(reorderIds([1, 2, 3, 4], 4, 1)).toEqual([4, 1, 2, 3])
  })

  it('is a no-op for same row or missing ids', () => {
    expect(reorderIds([1, 2, 3], 2, 2)).toEqual([1, 2, 3])
    expect(reorderIds([1, 2, 3], 9, 1)).toEqual([1, 2, 3])
    expect(reorderIds([1, 2, 3], 1, 9)).toEqual([1, 2, 3])
  })
})

describe('nearestRowByY (#42)', () => {
  it('returns the row whose midpoint is closest to the pointer', () => {
    const rects = new Map([
      [1, { top: 0, bottom: 20 }],
      [2, { top: 20, bottom: 40 }],
      [3, { top: 40, bottom: 60 }],
    ])
    expect(nearestRowByY(rects, 12)).toBe(1)
    expect(nearestRowByY(rects, 22)).toBe(2)
    expect(nearestRowByY(rects, 58)).toBe(3)
  })

  it('returns null with no rows', () => {
    expect(nearestRowByY(new Map(), 10)).toBeNull()
  })
})
