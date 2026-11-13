export type Brand<T, B extends string> = T & { readonly __brand: B };

export type SessionId = Brand<string, "SessionId">;
export type MessageId = Brand<string, "MessageId">;
export type InteractionId = Brand<string, "InteractionId">;
export type RevisionId = Brand<string, "RevisionId">;

export function newSessionId(): SessionId {
  return globalThis.crypto.randomUUID() as SessionId;
}

export function newMessageId(): MessageId {
  return globalThis.crypto.randomUUID() as MessageId;
}

export function newInteractionId(): InteractionId {
  return globalThis.crypto.randomUUID() as InteractionId;
}

export function newRevisionId(): RevisionId {
  return globalThis.crypto.randomUUID() as RevisionId;
}
