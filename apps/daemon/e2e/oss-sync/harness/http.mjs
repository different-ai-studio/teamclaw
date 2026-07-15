export class HttpCallError extends Error {
  constructor(method, url, status, body) {
    super(`${method} ${url} -> ${status}: ${body}`);
    this.name = "HttpCallError";
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, url, { body, bearer, query, retries = 5 } = {}) {
  const u = new URL(url);
  if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  // Retry on FC rate-limiting (429) / transient unavailability (503) with
  // exponential backoff. cloud.ucar.cc rate-limits bursty callers.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(u, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : {};
    if ((res.status === 429 || res.status === 503) && attempt < retries) {
      await sleep(Math.min(2000 * 2 ** attempt, 20000));
      continue;
    }
    throw new HttpCallError(method, u.toString(), res.status, text);
  }
}

export const postJson = (url, body, bearer) => call("POST", url, { body, bearer });
export const getJson = (url, query, bearer) => call("GET", url, { query, bearer });
export const deleteJson = (url, bearer) => call("DELETE", url, { bearer });
