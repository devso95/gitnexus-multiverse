/** API client with basic auth */

const getAuth = () => sessionStorage.getItem('mv_auth') || '';

type JsonMap = Record<string, any>;

export async function api<T = JsonMap>(path: string, opts: RequestInit = {}): Promise<T> {
  const auth = getAuth();
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Basic ${auth}` } : {}),
      ...opts.headers,
    },
  });
  if (res.status === 401) {
    sessionStorage.removeItem('mv_auth');
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const get = <T = JsonMap>(path: string, signal?: AbortSignal) =>
  api<T>(path, signal ? { signal } : {});

export const post = <T = JsonMap>(path: string, body?: unknown, signal?: AbortSignal) =>
  api<T>(path, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
    ...(signal ? { signal } : {}),
  });

export const put = <T = JsonMap>(path: string, body?: unknown, signal?: AbortSignal) =>
  api<T>(path, {
    method: 'PUT',
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

export const del = <T = JsonMap>(path: string, signal?: AbortSignal) =>
  api<T>(path, signal ? { signal } : { method: 'DELETE' });
