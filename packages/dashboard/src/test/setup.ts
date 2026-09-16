import * as matchers from '@testing-library/jest-dom/matchers';
import { expect } from 'vitest';

expect.extend(matchers);

if (Range.prototype.getClientRects === undefined) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
}

if (Range.prototype.getBoundingClientRect === undefined) {
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}
