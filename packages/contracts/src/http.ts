export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export function okResponse<T>(data: T): ApiResponse<T> {
  return { ok: true, data };
}

export function errResponse(code: string, message: string): ApiResponse<never> {
  return { ok: false, error: { code, message } };
}
