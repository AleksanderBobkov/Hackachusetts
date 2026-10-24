// REST helpers. Errors carry user-facing copy (design-system "Voice copy"), never codes.

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export const OFFLINE_MESSAGE = "Cannot connect right now. Try again.";

function detailMessage(body, fallback) {
  const detail = body && body.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail.length) {
    const msg = String(detail[0].msg || "").replace(/^Value error, /, "");
    if (msg) return msg;
  }
  return fallback;
}

export async function request(path, { method = "GET", json, body, headers = {}, fallback } = {}) {
  const init = { method, headers: { ...headers } };
  if (json !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(json);
  } else if (body !== undefined) {
    init.body = body;
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(OFFLINE_MESSAGE, 0);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (!res.ok) throw new ApiError(detailMessage(data, fallback || "Something went wrong. Try again."), res.status);
  return data;
}

/** Random key that works without a secure context (setup is usually opened over plain http). */
export function newKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
