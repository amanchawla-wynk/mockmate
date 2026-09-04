import type { Request, Response } from 'express';

const rawRequestBodies = new WeakMap<Request, Buffer>();

export function captureRawRequestBody(req: Request, _res: Response, body: Buffer): void {
  rawRequestBodies.set(req, body);
}

export function getRawRequestBody(req: Request): Buffer | undefined {
  return rawRequestBodies.get(req);
}
