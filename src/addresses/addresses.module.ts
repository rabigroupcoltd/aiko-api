import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AddressesController } from './addresses.controller';
import { AddressesService } from './addresses.service';
import { PlacesService } from './places.service';

@Module({
  imports: [AuthModule],
  controllers: [AddressesController],
  providers: [AddressesService, PlacesService],
  exports: [AddressesService],
})
export class AddressesModule {}
