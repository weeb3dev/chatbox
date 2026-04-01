const TOKEN_KEY = "chatbridge_token";

function getToken(): string | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as string;
  } catch {
    return localStorage.getItem(TOKEN_KEY);
  }
}

function authHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("Content-Type", "application/json");
  const token = getToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
}

export async function apiFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: authHeaders(options?.headers),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, (body as Record<string, string>).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export async function apiStream(
  path: string,
  body: unknown,
): Promise<Response> {
  const res = await fetch(path, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok && res.headers.get("content-type")?.includes("application/json")) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, (data as Record<string, string>).error ?? res.statusText);
  }
  return res;
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}
