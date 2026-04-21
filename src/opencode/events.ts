import type {
  Event as OpencodeEvent,
  EventMessageUpdated,
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
  type: Type
): event is Extract<OpenCodeEvent, { type: Type }> {
  return event.type === type;
}

export function isMessagePartUpdatedEvent(event: OpenCodeEvent): event is EventMessagePartUpdated {
  return isOpenCodeEventType(event, 'message.part.updated');
}

export function isMessageUpdatedEvent(event: OpenCodeEvent): event is EventMessageUpdated {
  return isOpenCodeEventType(event, 'message.updated');
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

export function getOpenCodeEventSessionId(event: OpenCodeEvent): string | undefined {
  if (isMessagePartUpdatedEvent(event)) {
    return event.properties.part.sessionID;
  }

  if (isMessageUpdatedEvent(event)) {
    return event.properties.info.sessionID;
  }

  if (event.type.startsWith('session.')) {
    const sessionId = (event.properties as { sessionID?: string }).sessionID;

    if (typeof sessionId === 'string') {
      return sessionId;
    }
  }

  return undefined;
}

export function isOpenCodeEventForSession(event: OpenCodeEvent, sessionId: string): boolean {
  return getOpenCodeEventSessionId(event) === sessionId;
}

export interface OpenCodeEventSubscription {
  stream: AsyncGenerator<OpenCodeEvent>;
  close(): void | Promise<void>;
}

type SdkOpenCodeEventSubscription = {
  stream: AsyncGenerator<OpenCodeEvent>;
  close?: () => void | Promise<void>;
};

export async function subscribeToOpencodeEvents(
  context: OpencodeSdkContext
): Promise<OpenCodeEventSubscription> {
  const subscription = (await context.client.event.subscribe({
    throwOnError: true,
  })) as SdkOpenCodeEventSubscription;

  return {
    stream: subscription.stream,
    async close(): Promise<void> {
      if (typeof subscription.close === 'function') {
        await subscription.close();
        return;
      }

      if (typeof subscription.stream.return === 'function') {
        await subscription.stream.return(undefined);
      }
    },
  };
}
