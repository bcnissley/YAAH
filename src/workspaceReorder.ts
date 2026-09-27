/** #42: pure helpers for the sidebar's drag-to-reorder. */

/**
 * Move `dragId` so it sits where `targetId` currently is. Idempotent when
 * either id is absent or both are the same row.
 */
export function reorderIds(ids: readonly number[], dragId: number, targetId: number): number[] {
  const from = ids.indexOf(dragId)
  const to = ids.indexOf(targetId)
  if (from === -1 || to === -1 || from === to) return [...ids]
  const next = [...ids]
  next.splice(from, 1)
  next.splice(to, 0, dragId)
  return next
}

/** The workspace header row whose vertical midpoint is nearest `y`, given
 * each row's bounding rect. Pointer-events hit-testing can't be used while
 * the dragged row sits under the cursor, so the drop target is computed
 * geometrically instead of from event targets. */
export function nearestRowByY(
  rects: ReadonlyMap<number, { top: number; bottom: number }>,
  y: number,
): number | null {
  let best: number | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const [id, r] of rects) {
    const mid = (r.top + r.bottom) / 2
    const d = Math.abs(mid - y)
    if (d < bestDist) {
      best = id
      bestDist = d
    }
  }
  return best
}
