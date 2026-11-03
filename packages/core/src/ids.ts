export type Brand<T, B extends string> = T & { readonly __brand: B };

export type SessionId = Brand<string, "SessionId">;
export type MessageId = Brand<string, "MessageId">;

export function newSessionId(): SessionId {
  return globalThis.crypto.randomUUID() as SessionId;
}

export function newMessageId(): MessageId {
  return globalThis.crypto.randomUUID() as MessageId;
}
