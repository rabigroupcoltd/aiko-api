import { KycStatus } from '@prisma/client';
import { MAX_RESERVED_ORDERS_PER_DRIVER } from './dispatch.constants';

/** OFFLINE / AVAILABLE / BUSY — §26, derived rather than stored. */
export type DispatchStatus = 'OFFLINE' | 'AVAILABLE' | 'BUSY';

export interface DispatchStatusInput {
  isAvailable: boolean;
  isBlocked: boolean;
  /** Owes at least their debt limit — finishes held work, takes nothing new. */
  debtLocked?: boolean;
  kycStatus: KycStatus;
  /** Marketplace orders held: RESERVED through IN_TRANSIT. */
  heldCount: number;
  /** Legacy bid-lane trips in flight: ACCEPTED through IN_PROGRESS. */
  legacyCount: number;
}

/**
 * The status rule, as a pure function of counts.
 *
 * Extracted from MarketplaceService because two callers need the same answer
 * from opposite sides of the module graph: the marketplace derives it while
 * building a driver's grid, and DriversService needs it for `GET
 * /api/drivers/state` — and DriversService cannot import MarketplaceService,
 * which already depends on it.
 *
 * Taking counts rather than a Prisma client is what keeps it shared: each
 * caller queries in whatever way suits the work it is already doing, and the
 * rule itself lives in one place.
 */
export function deriveDispatchStatus(input: DispatchStatusInput): DispatchStatus {
  if (!input.isAvailable || input.isBlocked || input.kycStatus !== KycStatus.APPROVED) {
    return 'OFFLINE';
  }

  // Never AVAILABLE, but still BUSY while delivering what they already hold.
  if (input.debtLocked) {
    return input.heldCount + input.legacyCount > 0 ? 'BUSY' : 'OFFLINE';
  }

  if (input.heldCount >= MAX_RESERVED_ORDERS_PER_DRIVER) return 'BUSY';

  // A driver mid-way through a legacy bid-flow trip is not free either.
  return input.legacyCount > 0 ? 'BUSY' : 'AVAILABLE';
}
