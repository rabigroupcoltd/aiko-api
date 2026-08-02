import { Injectable } from '@nestjs/common';
import { CONTACT_USER_SELECT } from '../common/prisma.selects';
import { ResponsesService } from '../common/responses/responses.service';
import { ServiceResult, badRequest, notFound, ok } from '../common/responses/response.types';
import { PrismaService } from '../prisma/prisma.service';

const MIN_WITHDRAWAL = Number(process.env.MIN_WITHDRAWAL || 500);

/** Thrown inside the withdrawal transaction to force a rollback. */
class InsufficientBalanceError extends Error {}

@Injectable()
export class WalletService {
  constructor(
    private prisma: PrismaService,
    private response: ResponsesService,
  ) {}

  async getWallet(driverId: string): Promise<ServiceResult> {
    try {
      const wallet = await this.prisma.driverWallet.findUnique({ where: { driverId } });
      if (wallet) return ok(wallet);

      // A driver registered before wallets existed still needs one.
      const driver = await this.prisma.driver.findUnique({ where: { id: driverId } });
      if (!driver) return notFound('Driver not found');

      return ok(await this.prisma.driverWallet.create({ data: { driverId } }));
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  async getTransactions(driverId: string, limit = 50, offset = 0): Promise<ServiceResult> {
    try {
      const [totalItems, result] = await this.prisma.$transaction([
        this.prisma.ledgerTransaction.count({ where: { driverId } }),
        this.prisma.ledgerTransaction.findMany({
          where: { driverId },
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
        }),
      ]);

      return ok(
        this.response.pagingData({ totalItems, result }, Math.floor(offset / limit) + 1, limit),
      );
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }

  /**
   * Debits the wallet and writes the ledger entry in one transaction, with the
   * balance guard inside the update so two concurrent withdrawals cannot both
   * pass the check.
   */
  async withdraw(driverId: string, amount: number): Promise<ServiceResult> {
    try {
      if (amount < MIN_WITHDRAWAL) return badRequest(`Minimum withdrawal is ${MIN_WITHDRAWAL}`);

      const driver = await this.prisma.driver.findUnique({ where: { id: driverId } });
      if (!driver) return notFound('Driver not found');
      if (driver.currentDebt > 0) {
        return badRequest('Clear your outstanding debt before withdrawing');
      }

      const wallet = await this.prisma.$transaction(async (tx) => {
        const debited = await tx.driverWallet.updateMany({
          where: { driverId, availableBalance: { gte: amount } },
          data: {
            availableBalance: { decrement: amount },
            totalWithdrawals: { increment: amount },
          },
        });

        if (debited.count === 0) throw new InsufficientBalanceError();

        const updated = await tx.driverWallet.findUniqueOrThrow({ where: { driverId } });

        await tx.ledgerTransaction.create({
          data: {
            driverId,
            type: 'WITHDRAWAL',
            amount: -amount,
            balanceAfter: updated.availableBalance,
            reference: `WD-${driverId}-${Date.now()}`,
            description: `Withdrawal of ${amount}`,
          },
        });

        return updated;
      });

      return ok(wallet);
    } catch (e) {
      if (e instanceof InsufficientBalanceError) return badRequest('Insufficient balance');
      return this.response.errorHandler(e);
    }
  }

  async getAllWallets(): Promise<ServiceResult> {
    try {
      const wallets = await this.prisma.driverWallet.findMany({
        include: {
          driver: { include: { user: { select: CONTACT_USER_SELECT } } },
        },
        orderBy: { availableBalance: 'desc' },
      });
      return ok(wallets);
    } catch (e) {
      return this.response.errorHandler(e);
    }
  }
}
