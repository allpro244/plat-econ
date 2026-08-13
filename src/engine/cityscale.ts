// HOW BIG THE TOWN IS, as a number the economy can read.
//
// The generator scales geography by `SIZES[id].k` (cities.mjs). Lot count and
// standing stock go roughly as k². Banks already size books off stock. Rival
// equity and permanent hold caps used to ignore k entirely — Hamlet and Great
// City opened with the same $2.5–10M wallets and the same $6M/$25M desk holds —
// so the big map felt empty of competition and the small one felt crowded with
// giants. One table, one scale, no new RNG draws.

export const SIZE_K: Record<string, number> = {
  hamlet: 0.55,
  town: 0.78,
  city: 1.0,
  metro: 1.45,
  giant: 2.0,
};

/** Linear size factor from the start-menu choice (default City = 1). */
export function sizeKOf(s: { citySize?: string } | null | undefined): number {
  return SIZE_K[s?.citySize ?? "city"] ?? 1;
}

/**
 * Area / market scale — lot count and stock go as k². Clamped so a Hamlet is
 * still a market (~⅓) and a Great City is four times City, not infinite.
 */
export function sizeAreaScale(s: { citySize?: string } | null | undefined): number {
  const k = sizeKOf(s);
  return Math.max(0.35, Math.min(4, k * k));
}
