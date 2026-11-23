import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
  HttpException,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { PrismaService } from '../prisma/prisma.service';
import { runInTransactionContext } from './transaction.context';

/**
 * Wraps each request it is applied to in a Prisma transaction, passed
 * implicitly through AsyncLocalStorage. Commits on a 2xx/3xx response and
 * rolls back on a 4xx/5xx status, an error-shaped body or a thrown exception.
 * Not registered anywhere in the app.
 */
@Injectable()
export class TransactionInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TransactionInterceptor.name);

  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    const txId = this.generateTxId();
    const method = request.method;
    const url = request.originalUrl || request.url;

    this.logger.debug(`[Transaction ${txId}] Started for ${method} ${url}`);

    return new Observable((subscriber) => {
      this.prisma
        .$transaction(
          async (tx) => {
            return new Promise((resolve, reject) => {
              runInTransactionContext(tx as any, () => {
                next
                  .handle()
                  .pipe(
                    tap((data) => {
                      const statusCode = response.statusCode || 200;

                      if (statusCode >= 400) {
                        this.logger.warn(
                          `[Transaction ${txId}] Rolling back due to status code: ${statusCode}`,
                        );
                        reject(new HttpException(data || 'Request failed', statusCode));
                      } else {
                        if (this.hasErrorIndicators(data)) {
                          this.logger.warn(
                            `[Transaction ${txId}] Rolling back due to error in response body`,
                          );
                          reject(
                            new HttpException(
                              data?.message || 'Error detected in response',
                              data?.statusCode || 400,
                            ),
                          );
                        } else {
                          this.logger.debug(
                            `[Transaction ${txId}] Committing - Status: ${statusCode}`,
                          );
                          resolve(data);
                        }
                      }
                    }),
                    catchError((error) => {
                      this.logger.error(
                        `[Transaction ${txId}] Rolling back due to exception: ${error.message}`,
                        error.stack,
                      );
                      reject(error);
                      return throwError(() => error);
                    }),
                  )
                  .subscribe({
                    next: (data) => subscriber.next(data),
                    error: (error) => subscriber.error(error),
                    complete: () => subscriber.complete(),
                  });
              });
            });
          },
          {
            maxWait: 5000,
            timeout: 30000,
            isolationLevel: 'ReadCommitted',
          },
        )
        .then((data) => {
          this.logger.debug(`[Transaction ${txId}] Successfully committed`);
          subscriber.next(data);
          subscriber.complete();
        })
        .catch((error) => {
          this.logger.error(`[Transaction ${txId}] Transaction failed: ${error.message}`);
          subscriber.error(error);
        });
    });
  }

  private hasErrorIndicators(data: any): boolean {
    if (!data || typeof data !== 'object') {
      return false;
    }

    return data.error !== undefined || data.errors !== undefined || data.success === false;
  }

  private generateTxId(): string {
    return Math.random().toString(36).substring(2, 10);
  }
}
