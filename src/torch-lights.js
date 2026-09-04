const coords = (torch) => torch.position || torch;

/** Выбрать не больше limit ближайших факелов, устойчиво разрешая равенство. */
export function selectLitTorches(torches, origin, limit) {
  const n = Math.max(0, Math.floor(limit));
  return torches.map((torch, index) => {
    const p = coords(torch);
    const dx = p.x - origin.x;
    const dy = (p.y || 0) - (origin.y || 0);
    const dz = p.z - origin.z;
    return { torch, index, distance2: dx * dx + dy * dy + dz * dz };
  }).sort((a, b) => a.distance2 - b.distance2 || a.index - b.index)
    .slice(0, n)
    .map((entry) => entry.torch);
}
