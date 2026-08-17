import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearSessionViewerDeliveries,
  consumeSessionViewerDelivery,
  hasConsumedSessionViewerDelivery,
  markSessionViewerDeliveryConsumed,
  queueSessionViewerDelivery,
} from './sessionViewerDelivery';

const delivery = (id: string, sessionId = 'session-a') => ({
  deliveryId: id,
  sessionId,
  path: `/workspace/${id}.md`,
  focus: true,
});

describe('session-aware Viewer delivery', () => {
  beforeEach(clearSessionViewerDeliveries);

  it('keeps inactive-session delivery pending until that session returns', () => {
    queueSessionViewerDelivery(delivery('d1'));
    expect(consumeSessionViewerDelivery('session-b')).toBeNull();
    expect(consumeSessionViewerDelivery('session-a')).toEqual(delivery('d1'));
  });

  it('delivers only the newest pending artifact per session', () => {
    queueSessionViewerDelivery(delivery('d1'));
    queueSessionViewerDelivery(delivery('d2'));
    expect(consumeSessionViewerDelivery('session-a')).toEqual(delivery('d2'));
  });

  it('consumes each delivery once so transcript replay cannot reopen it', () => {
    queueSessionViewerDelivery(delivery('d1'));
    expect(consumeSessionViewerDelivery('session-a')).not.toBeNull();
    expect(consumeSessionViewerDelivery('session-a')).toBeNull();
    queueSessionViewerDelivery(delivery('d1'));
    expect(consumeSessionViewerDelivery('session-a')).toBeNull();
  });

  it('marks active-session live delivery consumed immediately', () => {
    markSessionViewerDeliveryConsumed('d-live');
    expect(hasConsumedSessionViewerDelivery('d-live')).toBe(true);
  });
});
