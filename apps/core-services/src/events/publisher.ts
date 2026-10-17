// Event publishing seam (spec section 7.1). The server uses RabbitEventPublisher from
// @antre/messaging (publisher confirms, in-memory buffer while the broker is down, no outbox: see
// spec section 9.5); tests use the in-memory publisher.
import type { EventEnvelope } from '@antre/event-contracts';

export interface EventPublisher {
  publish(event: EventEnvelope): Promise<void>;
}

export class NoopEventPublisher implements EventPublisher {
  async publish(): Promise<void> {}
}

/** Keeps published events in memory; used by tests. */
export class InMemoryEventPublisher implements EventPublisher {
  readonly events: EventEnvelope[] = [];

  async publish(event: EventEnvelope): Promise<void> {
    this.events.push(event);
  }

  clear(): void {
    this.events.length = 0;
  }
}

interface ErrorLogger {
  error(object: object, message: string): void;
}

/**
 * Publishes events in order after the transaction committed. A failing publish is logged and
 * never fails the request: the state change is already committed.
 */
export async function publishAll(
  publisher: EventPublisher,
  events: EventEnvelope[],
  log: ErrorLogger,
): Promise<void> {
  for (const event of events) {
    try {
      await publisher.publish(event);
    } catch (error) {
      log.error(
        { err: error, event_id: event.event_id, event_type: event.event_type },
        'event publish failed',
      );
    }
  }
}
