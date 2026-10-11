import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AddressesModule } from './addresses/addresses.module';
import { AdminModule } from './admin/admin.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuditModule } from './audit/audit.module';
import { SupportModule } from './support/support.module';
import { AuthModule } from './auth/auth.module';
import { DispatchModule } from './dispatch/dispatch.module';
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
import { PlatformSettingsModule } from './settings/platform-settings.module';
import { StorageModule } from './storage/storage.module';
import { UsersModule } from './users/users.module';
import { WalletModule } from './wallet/wallet.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    ResponsesModule,
    PrismaModule,
    RedisModule,
    StorageModule,
    RideEventsModule,
    QueuesModule,
    FirebaseModule,
    PlatformSettingsModule,
    NotificationsModule,

    AuthModule,
    OnboardingModule,
    UsersModule,
    PricingModule,
    DriversModule,
    AddressesModule,
    DispatchModule,
    OrdersModule,
    RideModule,
    WalletModule,
    AnalyticsModule,
    AuditModule,
    SupportModule,
    AdminModule,

    WorkersModule,
  ],
})
export class AppModule {}
