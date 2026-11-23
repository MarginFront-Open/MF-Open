import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@marginfront/db';
import { getCurrentTransaction } from '../interceptors/transaction.context';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        {
          emit: 'event',
          level: 'query',
        },
        {
          emit: 'event',
          level: 'error',
        },
        {
          emit: 'event',
          level: 'info',
        },
        {
          emit: 'event',
          level: 'warn',
        },
      ],
      errorFormat: 'colorless',
    });

    // Log queries only when LOG_LEVEL=debug (opt-in to reduce terminal noise)
    if (process.env.LOG_LEVEL === 'debug') {
      this.$on('query' as never, (e: any) => {
        this.logger.debug(`Query: ${e.query}`);
        this.logger.debug(`Params: ${e.params}`);
        this.logger.debug(`Duration: ${e.duration}ms`);
      });
    }

    this.$on('error' as never, (e: any) => {
      this.logger.error(e);
    });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('✅ Database connected successfully');
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Database disconnected');
  }

  async cleanDatabase() {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Cannot clean database in production!');
    }

    const models = Reflect.ownKeys(this).filter((key) => key[0] !== '_' && key[0] !== '$');

    return Promise.all(
      models.map((modelKey) => {
        const model = this[modelKey as keyof this];
        if (model && typeof model === 'object' && 'deleteMany' in model) {
          return (model as any).deleteMany();
        }
      }),
    );
  }

  /**
   * Get the current Prisma client
   * Returns transaction client if available in AsyncLocalStorage, otherwise base client
   *
   * Usage in services:
   * const client = this.prisma.getClient();
   * await client.user.findMany();
   *
   * This automatically uses the transaction if one is active.
   */
  getClient(): PrismaClient {
    const transactionClient = getCurrentTransaction();

    if (transactionClient) {
      return transactionClient;
    }

    return this;
  }
}
