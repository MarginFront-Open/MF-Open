import { BadRequestException, CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { INGEST_PATHS, maxContainerDepth } from '../utils/ingest-body-limit';

// Nesting cap for every non-ingest request body. Sits far above any legitimate
// payload (the deepest real shape we accept anywhere is ~16, the ingest
// envelope cap) and far below the ~2,000 levels where the ValidationPipe's
// recursive walks (stripProtoKeys, then class-transformer) stack-overflow.
export const GLOBAL_BODY_MAX_DEPTH = 64;

/**
 * Global pre-transform depth guard. JSON.parse survives payloads
 * nested a million levels deep, but the transform:true ValidationPipe then
 * recurses over the parsed body and stack-overflows — a 500 on any route with
 * a DTO body. Guards run before pipes, so this rejects absurd nesting with a
 * clean 400 through Nest's normal exception filter first.
 *
 * The two ingest doors are exempt: their pre-router middleware
 * (ingestBodyParsers) already rejects anything deeper than 16, so skipping
 * them here keeps the ingest hot path at zero added per-request work.
 */
@Injectable()
export class JsonBodyDepthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const body: unknown = request.body;
    if (
      body === null ||
      typeof body !== 'object' ||
      Buffer.isBuffer(body) ||
      INGEST_PATHS.includes(request.path)
    ) {
      return true;
    }
    if (maxContainerDepth(body) > GLOBAL_BODY_MAX_DEPTH) {
      throw new BadRequestException(
        `Request JSON is nested more than ${GLOBAL_BODY_MAX_DEPTH} levels deep. ` +
          `No API payload needs nesting like this — flatten the request body and resend.`,
      );
    }
    return true;
  }
}
