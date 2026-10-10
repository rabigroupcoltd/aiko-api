/**
 * The debt lock, as a pure function of what the driver owes and the limit.
 *
 * Derived rather than stored, and deliberately separate from `isBlocked`:
 * `isBlocked` is an admin's manual decision, while this follows the numbers —
 * an admin raising the platform limit, or recording a payment, unlocks the
 * driver with nothing else to flip, and recording a payment can never lift a
 * block an admin put on for some other reason.
 */
export interface DriverDebtStatus {
  /** Platform commission owed from cash trips. */
  current: number;
  /** The limit in force: the driver's own override, else the platform setting. 0 = no limit. */
  limit: number;
  /** True when the limit is the driver's own rather than the platform default. */
  isOverride: boolean;
  /** At or over the limit — no new work until an admin records a payment. */
  locked: boolean;
  /** How much more can accrue before the lock, or null with no limit. */
  remaining: number | null;
}

export function driverDebtStatus(
  driver: { currentDebt: number; debtLimit: number | null },
  platformLimit: number,
): DriverDebtStatus {
  const isOverride = driver.debtLimit != null;
  const limit = driver.debtLimit ?? platformLimit;
  const current = driver.currentDebt;

  if (limit <= 0) return { current, limit: 0, isOverride, locked: false, remaining: null };

  return {
    current,
    limit,
    isOverride,
    locked: current >= limit,
    remaining: Math.max(0, limit - current),
  };
}
