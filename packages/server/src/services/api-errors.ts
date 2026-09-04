import { randomUUID } from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { z } from 'zod';
import type { ApiErrorResponse } from '../types';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly options: Omit<ApiErrorResponse, 'code' | 'message' | 'requestId'> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function parseApiInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new HttpError(422, 'VALIDATION_FAILED', 'Request validation failed', {
    details: parsed.error.issues.map(issue => ({
      path: issue.path.length === 0 ? '$' : `$.${issue.path.join('.')}`,
      message: issue.message,
    })),
  });
}

export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

function isMalformedJsonError(error: unknown): boolean {
  return error instanceof SyntaxError
    && typeof error === 'object'
    && error !== null
    && 'status' in error
    && error.status === 400
    && 'type' in error
    && error.type === 'entity.parse.failed';
}

function isPayloadTooLargeError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'status' in error
    && error.status === 413
    && 'type' in error
    && error.type === 'entity.too.large';
}

function isUnsupportedContentEncodingError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'status' in error
    && error.status === 415
    && 'type' in error
    && error.type === 'encoding.unsupported';
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.get('X-Request-Id') || randomUUID();
  res.locals.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}

export function serializeApiError(
  error: unknown,
  requestId: string,
): { status: number; body: ApiErrorResponse } {
  if (isMalformedJsonError(error)) {
    return {
      status: 400,
      body: { code: 'MALFORMED_JSON', message: 'Request body is not valid JSON', requestId },
    };
  }
  if (isPayloadTooLargeError(error)) {
    return {
      status: 413,
      body: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds the allowed size limit', requestId },
    };
  }
  if (isUnsupportedContentEncodingError(error)) {
    return {
      status: 415,
      body: {
        code: 'STATIC_CONTENT_ENCODING_UNSUPPORTED',
        message: 'Static uploads require an absent or identity Content-Encoding',
        requestId,
      },
    };
  }
  if (error instanceof HttpError) {
    if (error.code === 'ID_GENERATION_EXHAUSTED') {
      return {
        status: 409,
        body: {
          code: 'ID_COLLISION',
          message: 'A unique stable ID could not be allocated',
          requestId,
        },
      };
    }
    return {
      status: error.status,
      body: { code: error.code, message: error.message, ...error.options, requestId },
    };
  }
  return {
    status: 500,
    body: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId },
  };
}

export function apiErrorMiddleware(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const requestId = String(res.locals.requestId);
  const serialized = serializeApiError(error, requestId);
  if (serialized.status === 500) console.error(`[${requestId}]`, error);
  res.status(serialized.status).json(serialized.body);
}
