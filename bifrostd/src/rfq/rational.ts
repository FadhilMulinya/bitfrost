/**
 * Exact rational arithmetic for rates (PROTOCOL §4.2). All money math is
 * bigint — floats never touch a money path (CLAUDE.md invariant).
 */

export interface Rational {
  num: bigint;
  den: bigint;
}

export function rational(num: bigint, den: bigint): Rational {
  if (den === 0n) throw new RangeError("rational: zero denominator");
  if (num < 0n || den < 0n) throw new RangeError("rational: rates must be positive");
  return { num, den };
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export function normalize(r: Rational): Rational {
  if (r.num === 0n) return { num: 0n, den: 1n };
  const g = gcd(r.num, r.den);
  return { num: r.num / g, den: r.den / g };
}

/** floor(value × num / den) — rounds against the receiver. */
export function mulDivFloor(value: bigint, num: bigint, den: bigint): bigint {
  return (value * num) / den;
}

/** ceil(value × num / den) — rounds against the payer. */
export function mulDivCeil(value: bigint, num: bigint, den: bigint): bigint {
  const p = value * num;
  return p % den === 0n ? p / den : p / den + 1n;
}

/** r × (1e6 + deltaPpm) / 1e6, exact. deltaPpm may be negative (clamped > −1e6). */
export function applyPpm(r: Rational, deltaPpm: bigint): Rational {
  const factor = 1_000_000n + deltaPpm;
  if (factor <= 0n) throw new RangeError(`applyPpm: factor ${factor} would zero/negate the rate`);
  return normalize({ num: r.num * factor, den: r.den * 1_000_000n });
}
