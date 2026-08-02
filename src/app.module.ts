import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AddressesModule } from './addresses/addresses.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuthModule } from './auth/auth.module';
import { DriversModule } from './drivers/drivers.module';
import { ResponsesModule } from './common/responses/responses.module';
import { RideEventsModule } from './events/ride-events.module';
import { FirebaseModule } from './firebase/firebase.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { OrdersModule } from './orders/orders.module';
import { PricingModule } from './pricing/pricing.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueuesModule } from './queues/queues.module';
import { WorkersModule } from './queues/workers.module';
import { RedisModule } from './redis/redis.module';
import { RideModule } from './ride/ride.module';
import { StorageModule } from './storage/storage.module';
import { UsersModule } from './users/users.module';
import { WalletModule } from './wallet/wallet.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    // Global infrastructure — available to every feature module without re-import.
    ResponsesModule,
    PrismaModule,
    RedisModule,
    StorageModule,
    RideEventsModule,
    QueuesModule,
    FirebaseModule,
    // After FirebaseModule — it sends through the same credentials.
    NotificationsModule,

    AuthModule,
    OnboardingModule,
    UsersModule,
    PricingModule,
    DriversModule,
    AddressesModule,
    OrdersModule,
    RideModule,
    WalletModule,
    AnalyticsModule,

    // Drop this import to run an API-only instance with workers hosted elsewhere.
    WorkersModule,
  ],
})
export class AppModule {}
