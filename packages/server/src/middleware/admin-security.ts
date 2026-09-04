import type { Request, RequestHandler } from 'express';
import { HttpError } from '../services/api-errors';

export interface AppOptions {
  dashboardOrigins?: string[];
  allowRemoteAdmin?: boolean;
  isAdminRequestLocal?: (req: Request) => boolean;
}

export function isLoopbackAddress(address?: string): boolean {
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1';
}

export function requireLocalAdmin(options: AppOptions = {}): RequestHandler {
  return (req, _res, next) => {
    const local = options.isAdminRequestLocal?.(req)
      ?? isLoopbackAddress(req.socket.remoteAddress);

    if (!options.allowRemoteAdmin && !local) {
      next(new HttpError(
        403,
        'ADMIN_LOCAL_ONLY',
        'Administration is available only from this machine',
      ));
      return;
    }

    next();
  };
}
