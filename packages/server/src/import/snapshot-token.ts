import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { HttpError } from '../services/api-errors';
import type { ImportSourceType } from './contracts';
import { canonicalJson } from './security';

export interface ImportSnapshotTokenPayload {
  version: 1;
  projectId: string;
  sourceType: ImportSourceType;
  canonicalDigest: string;
  planDigest: string;
}

export interface ImportSnapshotTokenCodec {
  issue(input: Omit<ImportSnapshotTokenPayload, 'version'>): string;
  verify(token: string): ImportSnapshotTokenPayload;
}

function stalePreview(): HttpError {
  return new HttpError(
    409,
    'IMPORT_PREVIEW_STALE',
    'Import preview is stale; refresh the preview',
  );
}

function isSignedPayload(value: unknown): value is ImportSnapshotTokenPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).length === 5
    && candidate.version === 1
    && typeof candidate.projectId === 'string'
    && (candidate.sourceType === 'curl' || candidate.sourceType === 'postman')
    && typeof candidate.canonicalDigest === 'string'
    && typeof candidate.planDigest === 'string';
}

export function createImportSnapshotTokenCodec(
  sourceKey: Buffer = randomBytes(32),
): ImportSnapshotTokenCodec {
  const key = Buffer.from(sourceKey);
  const signature = (payload: string): Buffer => createHmac('sha256', key)
    .update(payload)
    .digest();

  return {
    issue(input) {
      const payload: ImportSnapshotTokenPayload = {
        version: 1,
        projectId: input.projectId,
        sourceType: input.sourceType,
        canonicalDigest: input.canonicalDigest,
        planDigest: input.planDigest,
      };
      const encodedPayload = Buffer.from(canonicalJson(payload)).toString('base64url');
      return `${encodedPayload}.${signature(encodedPayload).toString('base64url')}`;
    },

    verify(token) {
      try {
        const segments = token.split('.');
        if (segments.length !== 2 || segments.some(segment => segment.length === 0)) {
          throw stalePreview();
        }
        const [encodedPayload, encodedSignature] = segments;
        const suppliedSignature = Buffer.from(encodedSignature, 'base64url');
        const expectedSignature = signature(encodedPayload);
        if (
          suppliedSignature.toString('base64url') !== encodedSignature
          || suppliedSignature.length !== expectedSignature.length
          || !timingSafeEqual(suppliedSignature, expectedSignature)
        ) {
          throw stalePreview();
        }

        const payloadBytes = Buffer.from(encodedPayload, 'base64url');
        if (payloadBytes.toString('base64url') !== encodedPayload) throw stalePreview();
        const payload: unknown = JSON.parse(payloadBytes.toString('utf8'));
        if (!isSignedPayload(payload)) throw stalePreview();
        return {
          version: 1,
          projectId: payload.projectId,
          sourceType: payload.sourceType,
          canonicalDigest: payload.canonicalDigest,
          planDigest: payload.planDigest,
        };
      } catch (error) {
        if (error instanceof HttpError && error.code === 'IMPORT_PREVIEW_STALE') throw error;
        throw stalePreview();
      }
    },
  };
}
