import * as http from 'node:http';

import { serializeApiError } from './api-errors';
import { createDeliveryCauseTracker, type DeliveryCause } from './delivery-cause';
import { ObservedResponseTarget } from './observed-response-target';
import type { HeaderTuple } from './upstream-transport';

export interface CanonicalErrorDelivery {
  status: number;
  code: string;
  message: string;
  headers: HeaderTuple[];
  responseBytes: number;
  bodyComplete: boolean;
  deliveryCause: DeliveryCause | undefined;
}

export async function writeCanonicalErrorResponse(
  response: http.ServerResponse,
  error: unknown,
  requestId: string,
  options: {
    contentType?: string;
    closeConnection?: boolean;
    requestIdFirst?: boolean;
    onHead?(status: number, headers: HeaderTuple[]): void;
    onChunk?(chunk: Buffer): void;
  } = {},
): Promise<CanonicalErrorDelivery> {
  const serialized = serializeApiError(error, requestId);
  const body = Buffer.from(JSON.stringify(serialized.body));
  const entityHeaders: HeaderTuple[] = [
    ['Content-Type', options.contentType ?? 'application/json'],
    ['Content-Length', String(body.length)],
  ];
  const requestHeader: HeaderTuple = ['X-Request-Id', requestId];
  const headers: HeaderTuple[] = [
    ...(options.requestIdFirst ? [requestHeader, ...entityHeaders] : [...entityHeaders, requestHeader]),
    ...(options.closeConnection ? [['Connection', 'close'] as HeaderTuple] : []),
  ];
  const deliveryCause = createDeliveryCauseTracker();

  if (response.headersSent) {
    deliveryCause.markFailure();
    if (!response.destroyed) response.destroy(error instanceof Error ? error : undefined);
    return {
      status: response.statusCode,
      code: serialized.body.code,
      message: serialized.body.message,
      headers: [],
      responseBytes: 0,
      bodyComplete: false,
      deliveryCause: deliveryCause.cause,
    };
  }

  for (const name of response.getHeaderNames()) response.removeHeader(name);
  const target = new ObservedResponseTarget(response, deliveryCause, {
    forceClose: options.closeConnection,
    onHead: status => options.onHead?.(status, headers),
    onChunk: options.onChunk,
  });
  target.status(serialized.status);
  for (const [name, value] of headers) target.setHeader(name, value);

  let finished = false;
  await new Promise<void>(resolve => {
    let settled = false;
    const cleanup = () => {
      target.off('finish', completed);
      target.off('error', failed);
      target.off('close', closed);
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const completed = () => {
      finished = true;
      settle();
    };
    const failed = () => settle();
    const closed = () => settle();
    target.once('finish', completed);
    target.once('error', failed);
    target.once('close', closed);
    try {
      target.end(body);
    } catch {
      deliveryCause.markFailure();
      settle();
    }
  });

  return {
    status: serialized.status,
    code: serialized.body.code,
    message: serialized.body.message,
    headers,
    responseBytes: target.responseBytes,
    bodyComplete: finished && target.responseBytes === body.length,
    deliveryCause: deliveryCause.cause,
  };
}
