import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CryptoService } from './crypto.service';

/**
 * Global so any module can inject CryptoService without explicit imports. The service is
 * stateless after init (just holds the loaded key in memory) so a single shared instance
 * is safe and avoids re-reading + re-validating ENCRYPTION_KEY on every module boot.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [CryptoService],
  exports: [CryptoService],
})
export class CryptoModule {}
