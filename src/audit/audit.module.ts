import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/**
 * Global so any feature module can record an action without importing this one.
 *
 * The alternative — every module that mutates something importing AuditModule —
 * puts an edge into the graph from a dozen places for a dependency that never
 * flows the other way, and makes "does this action leave a trail" a question
 * about wiring rather than about the call site.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
