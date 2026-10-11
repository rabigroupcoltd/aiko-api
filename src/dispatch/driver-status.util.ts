import { KycStatus } from '@prisma/client';
import { MAX_RESERVED_ORDERS_PER_DRIVER } from './dispatch.constants';

export type DispatchStatus = 'OFFLINE' | 'AVAILABLE' | 'BUSY';

export interface DispatchStatusInput {
  isAvailable: boolean;
  isBlocked: boolean;
  debtLocked?: boolean;
  kycStatus: KycStatus;
  heldCount: number;
  legacyCount: number;
}

export function deriveDispatchStatus(input: DispatchStatusInput): DispatchStatus {
  if (!input.isAvailable || input.isBlocked || input.kycStatus !== KycStatus.APPROVED) {
    return 'OFFLINE';
  }

  if (input.debtLocked) {
    return input.heldCount + input.legacyCount > 0 ? 'BUSY' : 'OFFLINE';
  }

  if (input.heldCount >= MAX_RESERVED_ORDERS_PER_DRIVER) return 'BUSY';

  return input.legacyCount > 0 ? 'BUSY' : 'AVAILABLE';
}
