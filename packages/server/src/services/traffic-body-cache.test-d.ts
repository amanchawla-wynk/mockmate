import { expectTypeOf, test } from 'vitest';

import type { FileSystem } from '../repository/file-system';
import type { TrafficBodyBudgetManager } from './traffic-body-budget';
import type {
  TrafficBodyCacheOptions,
  TrafficBodyDescriptorPublication,
} from './traffic-body-cache';

type PublisherWithoutErrorOwner = {
  rootDirectory: string;
  runtimeNamespace: string;
  budgets: TrafficBodyBudgetManager;
  fileSystem: FileSystem;
  publishDescriptor(publication: TrafficBodyDescriptorPublication): boolean;
};

test('requires an error owner whenever descriptor publication is configured', () => {
  expectTypeOf<PublisherWithoutErrorOwner>().not.toMatchTypeOf<TrafficBodyCacheOptions>();
});
