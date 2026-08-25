export type LabelCandidate = {
  id: number;
  x: number;
  y: number;
  rank: number;
};

/** Place labels and buoy marks share this occupancy radius. */
export const MIN_LABEL_PX = 56;

/** Keep higher-rank (lower number) labels; drop later ones that sit too close. */
export function visibleLabelIds(
  candidates: readonly LabelCandidate[],
  minDist: number,
): Set<number> {
  const visible = new Set<number>();
  const placed: LabelCandidate[] = [];
  const ordered = [...candidates].sort((a, b) => a.rank - b.rank || a.id - b.id);
  const minSq = minDist * minDist;
  for (const candidate of ordered) {
    const crowded = placed.some((other) => {
      const dx = other.x - candidate.x;
      const dy = other.y - candidate.y;
      return dx * dx + dy * dy < minSq;
    });
    if (crowded) {
      continue;
    }
    placed.push(candidate);
    visible.add(candidate.id);
  }
  return visible;
}
