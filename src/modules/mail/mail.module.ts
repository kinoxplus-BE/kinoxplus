import { Global, Module } from '@nestjs/common';
import { JobsModule } from '../../jobs/jobs.module';
import { MailProcessor } from './mail.processor';
import { MailQueue } from './mail.queue';
import { MailService } from './mail.service';

@Global()
@Module({
  imports: [JobsModule],
  providers: [MailService, MailQueue, MailProcessor],
  exports: [MailService, MailQueue],
})
export class MailModule {}
