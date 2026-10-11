import { Injectable, Logger } from '@nestjs/common';
import { MulticastMessage } from 'firebase-admin/messaging';
import { FirebaseService } from '../firebase/firebase.service';
import { PrismaService } from '../prisma/prisma.service';
import { MAX_TOKENS_PER_BATCH, PushType, RIDE_CHANNEL_ID } from './notifications.constants';

export interface PushMessage {
  title?: string;
  body?: string;
  type: PushType;
  data?: Record<string, string | number | boolean | null | undefined>;
  silent?: boolean;
  collapseKey?: string;
  ttlSeconds?: number;
  priority?: 'high' | 'normal';
}

export interface PushResult {
  sent: number;
  failed: number;
  pruned: number;
}

const EMPTY: PushResult = { sent: 0, failed: 0, pruned: 0 };

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    private prisma: PrismaService,
    private firebase: FirebaseService,
  ) {}

  async sendToUsers(userIds: (string | null | undefined)[], message: PushMessage): Promise<PushResult> {
    const recipients = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
    if (recipients.length === 0) return EMPTY;

    const messaging = this.firebase.messaging;
    if (!messaging) {
      this.logger.debug(`Firebase not configured — dropping ${message.type}`);
      return EMPTY;
    }

    const devices = await this.prisma.deviceToken.findMany({
      where: { userId: { in: recipients } },
      select: { token: true },
    });

    const tokens = devices.map((device) => device.token);
    if (tokens.length === 0) return EMPTY;

    const payload = this.buildMessage(message);
    const totals = { ...EMPTY };

    for (let index = 0; index < tokens.length; index += MAX_TOKENS_PER_BATCH) {
      const batch = tokens.slice(index, index + MAX_TOKENS_PER_BATCH);

      try {
        const response = await messaging.sendEachForMulticast({ ...payload, tokens: batch });
        const outcome = await this.reconcile(batch, response.responses);

        totals.sent += outcome.sent;
        totals.failed += outcome.failed;
        totals.pruned += outcome.pruned;
      } catch (e: any) {
        this.logger.error(`FCM send failed for ${message.type}: ${e?.message}`);
        totals.failed += batch.length;
      }
    }

    this.logger.debug(
      `${message.type} -> ${recipients.length} user(s): ${totals.sent} sent, ` +
        `${totals.failed} failed, ${totals.pruned} pruned`,
    );

    return totals;
  }

  async sendToDrivers(driverIds: (string | null | undefined)[], message: PushMessage): Promise<PushResult> {
    const ids = [...new Set(driverIds.filter((id): id is string => Boolean(id)))];
    if (ids.length === 0) return EMPTY;

    const drivers = await this.prisma.driver.findMany({
      where: { id: { in: ids } },
      select: { userId: true },
    });

    return this.sendToUsers(
      drivers.map((driver) => driver.userId),
      message,
    );
  }

  private buildMessage(message: PushMessage): Omit<MulticastMessage, 'tokens'> {
    const priority = message.priority ?? 'high';
    const data = stringifyData({ ...message.data, type: message.type });

    return {
      ...(message.silent ? {} : { notification: { title: message.title, body: message.body } }),
      data,
      android: {
        priority,
        ...(message.collapseKey ? { collapseKey: message.collapseKey } : {}),
        ...(message.ttlSeconds != null ? { ttl: message.ttlSeconds * 1000 } : {}),
        ...(message.silent
          ? {}
          : {
              notification: {
                sound: 'default',
                ...(RIDE_CHANNEL_ID ? { channelId: RIDE_CHANNEL_ID } : {}),
              },
            }),
      },
      apns: {
        headers: {
          'apns-priority': priority === 'high' ? '10' : '5',
          ...(message.collapseKey ? { 'apns-collapse-id': message.collapseKey } : {}),
        },
        payload: {
          aps: message.silent ? { contentAvailable: true } : { sound: 'default' },
        },
      },
    };
  }

  private async reconcile(
    tokens: string[],
    responses: { success: boolean; error?: { code?: string } }[],
  ): Promise<PushResult> {
    const delivered: string[] = [];
    const dead: string[] = [];
    const suspect: string[] = [];

    responses.forEach((response, index) => {
      const token = tokens[index];

      if (response.success) {
        delivered.push(token);
        return;
      }

      const code = response.error?.code ?? '';

      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token'
      ) {
        dead.push(token);
      } else if (code === 'messaging/invalid-argument') {
        suspect.push(token);
      } else {
        this.logger.warn(`FCM rejected a token: ${code || 'unknown error'}`);
      }
    });

    if (suspect.length > 0) {
      if (delivered.length > 0) {
        dead.push(...suspect);
      } else {
        this.logger.error(
          `FCM rejected all ${suspect.length} token(s) with invalid-argument — ` +
            'treating this as a bad payload and keeping the registrations',
        );
      }
    }

    if (dead.length > 0) {
      await this.prisma.deviceToken
        .deleteMany({ where: { token: { in: dead } } })
        .catch((e) => this.logger.warn(`Could not prune dead tokens: ${e?.message}`));
    }

    if (delivered.length > 0) {
      await this.prisma.deviceToken
        .updateMany({ where: { token: { in: delivered } }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined);
    }

    return {
      sent: delivered.length,
      failed: responses.length - delivered.length,
      pruned: dead.length,
    };
  }
}

function stringifyData(
  data: Record<string, string | number | boolean | null | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    out[key] = typeof value === 'string' ? value : String(value);
  }

  return out;
}
