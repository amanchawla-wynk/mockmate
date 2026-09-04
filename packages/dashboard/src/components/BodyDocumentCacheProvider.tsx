import type { ReactNode } from 'react';
import type { BodyDocumentCache } from '../state/bodyDocumentCache';
import { BodyDocumentCacheContext } from '../state/bodyDocumentCacheContext';

export function BodyDocumentCacheProvider({
  cache,
  children,
}: {
  cache: BodyDocumentCache;
  children: ReactNode;
}) {
  return (
    <BodyDocumentCacheContext.Provider value={cache}>
      {children}
    </BodyDocumentCacheContext.Provider>
  );
}
