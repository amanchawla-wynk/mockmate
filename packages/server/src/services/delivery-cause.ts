export type DeliveryCause = 'failure' | 'cancelled';

export interface DeliveryCauseTracker {
  readonly cause: DeliveryCause | undefined;
  markFailure(): void;
  markCancelled(): void;
}

export function createDeliveryCauseTracker(): DeliveryCauseTracker {
  let cause: DeliveryCause | undefined;
  return {
    get cause() {
      return cause;
    },
    markFailure() {
      cause ??= 'failure';
    },
    markCancelled() {
      cause ??= 'cancelled';
    },
  };
}
