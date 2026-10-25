import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { DeleteAccountPageController } from './delete-account-page.controller';

@Module({
  imports: [AuthModule],
  controllers: [AccountController, DeleteAccountPageController],
  providers: [AccountService],
})
export class AccountModule {}
