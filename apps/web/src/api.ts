import type { Project, User } from "./types";

interface ErrorBody {
  code?: string;
  message?: string;
  requestId?: string;
  details?: unknown;
}

interface LoginResponse {
  accessToken: string;
  expiresIn: number;
  user: User;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly requestId: string | null,
    readonly details: unknown,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let accessToken = sessionStorage.getItem("fi.access-token");

function saveAccessToken(token: string | null): void {
  accessToken = token;
  if (token) sessionStorage.setItem("fi.access-token", token);
  else sessionStorage.removeItem("fi.access-token");
}

async function parseBody<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

async function refreshAccessToken(): Promise<LoginResponse | null> {
  const response = await fetch("/api/auth/refresh", {
    method: "POST",
    credentials: "include",
  });
  if (!response.ok) {
    saveAccessToken(null);
    window.dispatchEvent(new CustomEvent("fi:auth-expired"));
    return null;
  }
  const body = await parseBody<LoginResponse>(response);
  saveAccessToken(body.accessToken);
  window.dispatchEvent(new CustomEvent("fi:auth-refreshed", { detail: body.user }));
  return body;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  allowRefresh = true,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "include",
  });
  if (response.status === 401 && allowRefresh && !path.startsWith("/api/auth/")) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return request<T>(path, init, false);
  }
  if (!response.ok) {
    const body: ErrorBody = await parseBody<ErrorBody>(response).catch(() => ({}));
    throw new ApiError(
      response.status,
      body.code ?? `HTTP_${response.status}`,
      body.requestId ?? response.headers.get("x-request-id"),
      body.details,
      body.message ?? "请求失败",
    );
  }
  return parseBody<T>(response);
}

export const api = {
  request,
  async login(email: string, password: string): Promise<LoginResponse> {
    const body = await request<LoginResponse>(
      "/api/auth/login",
      {
        method: "POST",
        body: JSON.stringify({ email, password }),
      },
      false,
    );
    saveAccessToken(body.accessToken);
    return body;
  },
  async restore(): Promise<LoginResponse | null> {
    if (accessToken) {
      const saved = sessionStorage.getItem("fi.user");
      if (saved) {
        return {
          accessToken,
          expiresIn: 0,
          user: JSON.parse(saved) as User,
        };
      }
    }
    return refreshAccessToken();
  },
  async logout(): Promise<void> {
    await request<void>("/api/auth/logout", { method: "POST" }, false).catch(
      () => undefined,
    );
    saveAccessToken(null);
  },
  listProjects(): Promise<Project[]> {
    return request<Project[]>("/api/projects");
  },
};
