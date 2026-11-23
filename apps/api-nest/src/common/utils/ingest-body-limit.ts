import express from 'express';

// Explicit request-body cap for the two usage-record doors, instead
// of inheriting body-parser's 100kb default. Sized for the worst legitimate
// batch: 100 records each carrying metadata near the 16 KB field cap (~1.7 MB).
// Vercel rejects bodies over ~4.5 MB before they reach us, so this is the
// binding, documented limit.
export const INGEST_BODY_LIMIT = '2mb';

// Envelope nesting cap for the whole request body — the deepest legitimate
// shape is ~8 containers, and 16 doubles that. Exists because JSON.parse
// survives 1,000,000 levels but class-transformer's recursive walk in the
// ValidationPipe stack-overflows near 2,000 (a 500, not a 400), so depth must
// be rejected before the pipe ever sees the body.
export const INGEST_BODY_MAX_DEPTH = 16;

// Global prefix 'v1' is hardcoded here the same way the Stripe webhook raw-body
// mount in main.ts hardcodes its path.
export const INGEST_PATHS = ['/v1/usage/record', '/v1/sdk/usage/record'];

/**
 * Depth of the deepest object/array container, root = 1. Iterative walk so a
 * pathologically nested payload can't blow the call stack before we reject it.
 */
export function maxContainerDepth(root: object): number {
  let deepest = 0;
  const stack: Array<{ value: object; depth: number }> = [{ value: root, depth: 1 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (depth > deepest) deepest = depth;
    const children = Array.isArray(value) ? value : Object.values(value);
    for (const child of children) {
      if (child !== null && typeof child === 'object') {
        stack.push({ value: child, depth: depth + 1 });
      }
    }
  }
  return deepest;
}

export function ingestBodyParsers(): [
  express.RequestHandler,
  express.RequestHandler,
  express.ErrorRequestHandler,
] {
  const jsonWithCap = express.json({ limit: INGEST_BODY_LIMIT });

  // FOOT-GUN: express.json() returns a function literally named "jsonParser",
  // and ExpressAdapter skips Nest's app-wide json parser when ANY stack layer
  // carries that name — silently killing JSON parsing for every other route.
  // This wrapper exists only to present a different function name (pinned in
  // ingest-caps.http.spec.ts).
  const parseJsonWithCap: express.RequestHandler = function ingestJsonWithCap(req, res, next) {
    jsonWithCap(req, res, next);
  };

  const rejectAbsurdNesting: express.RequestHandler = (req, res, next) => {
    if (
      req.body !== null &&
      typeof req.body === 'object' &&
      maxContainerDepth(req.body) > INGEST_BODY_MAX_DEPTH
    ) {
      res.status(400).json({
        statusCode: 400,
        error: 'Bad Request',
        message:
          `Request JSON is nested more than ${INGEST_BODY_MAX_DEPTH} levels deep. ` +
          `Usage-record payloads never need nesting like this — flatten the request ` +
          `(record metadata may nest at most 5 levels).`,
      });
      return;
    }
    next();
  };

  const answerParserErrorsInPlainEnglish: express.ErrorRequestHandler = (err, _req, res, next) => {
    if (err?.type === 'entity.too.large') {
      res.status(413).json({
        statusCode: 413,
        error: 'Payload Too Large',
        message:
          `Request body exceeds the ${INGEST_BODY_LIMIT} usage-ingest limit. ` +
          `This usually means too many records in one batch or oversized per-record ` +
          `metadata. Send at most 100 records per request and keep each record's ` +
          `metadata under 16 KB.`,
      });
      return;
    }
    if (err?.type === 'entity.parse.failed') {
      // Without this branch the SyntaxError rides Nest's generic mapping
      // (routes-resolver mapExternalException), whose message is V8's raw
      // JSON.parse error — on modern Node that echoes a window of the payload
      // back to the caller. Ingest payloads are customer data; never echo.
      res.status(400).json({
        statusCode: 400,
        error: 'Bad Request',
        message:
          `Request body is not valid JSON. The usual causes are a truncated payload, ` +
          `a trailing comma, or an unquoted key or value. Fix the JSON and resend.`,
      });
      return;
    }
    next(err);
  };

  return [parseJsonWithCap, rejectAbsurdNesting, answerParserErrorsInPlainEnglish];
}
