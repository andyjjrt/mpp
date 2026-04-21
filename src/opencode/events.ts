import type {
  Event as OpencodeEvent,
  EventMessagePartUpdated,
  EventSessionError,
  EventSessionIdle,
  EventSessionStatus,
} from '@opencode-ai/sdk';

import type { OpencodeSdkContext } from './sdk.js';

export type OpenCodeEvent = OpencodeEvent;
export type OpenCodeEventType = OpenCodeEvent['type'];

export function isOpenCodeEventType<Type extends OpenCodeEventType>(
  event: OpenCodeEvent,
  type: Type,
): event is Extract<OpenCodeEvent, { type: Type }> {
  return event.type === type;
}

export function isMessagePartUpdatedEvent(event: OpenCodeEvent): event is EventMessagePartUpdated {
  return isOpenCodeEventType(event, 'message.part.updated');
}

export function isSessionStatusEvent(event: OpenCodeEvent): event is EventSessionStatus {
  return isOpenCodeEventType(event, 'session.status');
}

export function isSessionIdleEvent(event: OpenCodeEvent): event is EventSessionIdle {
  return isOpenCodeEventType(event, 'session.idle');
}

export function isSessionErrorEvent(event: OpenCodeEvent): event is EventSessionError {
  return isOpenCodeEventType(event, 'session.error');
}

export async function subscribeToOpencodeEvents(context: OpencodeSdkContext): Promise<AsyncGenerator<OpenCodeEvent>> {
  const subscription = await context.client.event.subscribe({
    throwOnError: true,
  });

  return subscription.stream;
}
