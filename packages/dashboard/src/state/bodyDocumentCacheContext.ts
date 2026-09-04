import { createContext, useContext, useState } from 'react';
import { createBodyDocumentCache, type BodyDocumentCache } from './bodyDocumentCache';

export const BodyDocumentCacheContext = createContext<BodyDocumentCache | undefined>(undefined);

export function useBodyDocumentCache(): BodyDocumentCache {
  const provided = useContext(BodyDocumentCacheContext);
  const [fallback] = useState(createBodyDocumentCache);
  return provided ?? fallback;
}
