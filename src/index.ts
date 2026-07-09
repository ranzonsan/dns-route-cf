interface Env {
  UPSTREAM_DOH: string;
  UPSTREAM_DOH_BACKUP: string;
  FALLBACK_TIMEOUT_MS: string;
  AUTH_TOKEN: string;
}

const DNS_PATH = '/dns-query';
const HEALTH_PATH = '/health';
const DNS_MIME = 'application/dns-message';

function base64urlDecode(s: string): Uint8Array {
  let base64 = s.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) base64 += '=';
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  return bytes;
}

async function fetchUpstream(dnsBody: Uint8Array, url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': DNS_MIME,
        'Accept': DNS_MIME,
      },
      body: dnsBody,
      signal: controller.signal,
    });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

async function proxyToUpstream(dnsBody: Uint8Array, env: Env): Promise<Response> {
  const timeout = parseInt(env.FALLBACK_TIMEOUT_MS, 10) || 3000;

  const primary = env.UPSTREAM_DOH;
  const backup = env.UPSTREAM_DOH_BACKUP;

  for (const url of [primary, backup]) {
    if (!url) continue;
    try {
      const resp = await fetchUpstream(dnsBody, url, timeout);
      if (resp.ok) return resp;
      if (url === backup) return resp;
    } catch {
      if (url === backup) break;
    }
  }

  return new Response('Upstream DNS servers unavailable', { status: 502 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    if (url.pathname === HEALTH_PATH && method === 'GET') {
      return new Response('ok');
    }

    if (url.pathname !== DNS_PATH) {
      return new Response('Not Found', { status: 404 });
    }

    if (method !== 'GET' && method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const token = url.searchParams.get('token');
    if (env.AUTH_TOKEN !== '' && token !== env.AUTH_TOKEN) {
      return new Response('Unauthorized', { status: 401 });
    }

    let dnsBody: Uint8Array;

    if (method === 'POST') {
      const contentType = request.headers.get('Content-Type') || '';
      if (!contentType.includes(DNS_MIME)) {
        return new Response('Unsupported Media Type', { status: 415 });
      }
      dnsBody = new Uint8Array(await request.arrayBuffer());
    } else {
      const dnsParam = url.searchParams.get('dns');
      if (!dnsParam) {
        return new Response('Missing dns query parameter', { status: 400 });
      }
      try {
        dnsBody = base64urlDecode(dnsParam);
      } catch {
        return new Response('Invalid base64url encoding', { status: 400 });
      }
    }

    const upstreamResp = await proxyToUpstream(dnsBody, env);
    const responseHeaders = new Headers();
    responseHeaders.set('Content-Type', upstreamResp.headers.get('Content-Type') || DNS_MIME);
    const cacheControl = upstreamResp.headers.get('Cache-Control');
    if (cacheControl) responseHeaders.set('Cache-Control', cacheControl);

    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: responseHeaders,
    });
  },
};
