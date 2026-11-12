type XpSettings = { min_xp: number; max_xp: number; min_xp_values: string; max_xp_values: string };

export function xpRange(settings: XpSettings, index: number) {
  const values = (text: string, fallback: number) => text.trim()
    ? text.split(",").map(value => Math.max(0, Math.floor(Number(value)) || 0))
    : [Math.max(0, Math.floor(fallback))];
  const minimums = values(settings.min_xp_values || "", settings.min_xp);
  const maximums = values(settings.max_xp_values || "", settings.max_xp);
  const minimum = minimums[index] ?? (minimums.length === 1 ? minimums[0] : 0);
  const maximum = Math.max(minimum, maximums[index] ?? (maximums.length === 1 ? maximums[0] : 0));
  return { minimum, maximum };
}
