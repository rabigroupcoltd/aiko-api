import { Global, Module } from '@nestjs/common';
import { RideEventsService } from './ride-events.service';

@Global()
@Module({
  providers: [RideEventsService],
  exports: [RideEventsService],
})
export class RideEventsModule {}
