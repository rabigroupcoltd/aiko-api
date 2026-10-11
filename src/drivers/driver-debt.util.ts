export interface DriverDebtStatus {
  current: number;
  limit: number;
  isOverride: boolean;
  locked: boolean;
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
