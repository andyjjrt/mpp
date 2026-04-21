export interface VoiceSpeakingEvents {
  on(event: 'start', listener: (userId: string) => void): void;
  off(event: 'start', listener: (userId: string) => void): void;
}

export interface AudioReceiveStreamLike {
  destroyed: boolean;
  destroy(): void;
  on(event: 'data', listener: (chunk: Buffer) => void): this;
  once(event: 'close' | 'end', listener: () => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
}

export interface VoiceReceiverLike {
  subscribe(
    userId: string,
    options: {
      end: {
        behavior: number;
      };
    }
  ): AudioReceiveStreamLike;
  speaking: VoiceSpeakingEvents;
}

export interface VoiceConnectionLike {
  destroy(): void;
  receiver: VoiceReceiverLike;
}
