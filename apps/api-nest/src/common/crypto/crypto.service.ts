import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  encrypt as encryptCore,
  decrypt as decryptCore,
  isEncryptedEnvelope,
  loadKey,
} from './crypto-core';

/**
 * Thin NestJS wrapper over crypto-core. Loads the AES-256 key once on module init and
 * exposes encrypt/decrypt to the rest of the app. The work is in crypto-core; this is just
 * the DI surface.
 *
 * Treats a missing/invalid `ENCRYPTION_KEY` as fatal at startup — better to fail to boot
 * than to silently run with a key that won't decrypt anything.
 */
@Injectable()
export class CryptoService implements OnModuleInit {
  private readonly logger = new Logger(CryptoService.name);
  private key!: Buffer;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const keyB64 = this.configService.get<string>('ENCRYPTION_KEY');
    this.key = loadKey(keyB64);
    this.logger.log('CryptoService ready — AES-256-GCM, v1 envelope');
  }

  encrypt(plaintext: string): string {
    return encryptCore(this.key, plaintext);
  }

  decrypt(envelope: string): string {
    return decryptCore(this.key, envelope);
  }

  isEncrypted(value: string | null | undefined): boolean {
    return isEncryptedEnvelope(value);
  }
}
