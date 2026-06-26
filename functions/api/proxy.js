// GET /api/proxy?url=<encoded cdn mp4 url>
// Same-origin streaming proxy for the Loom CDN mp4 so the browser <video> element
// can load it and we can read frames onto a <canvas> (no CORS taint).
//
// Honors Range requests so the video element can seek without downloading the whole file.

// Only allow proxying Loom's own CDN — prevents this from being an open proxy.
function allowed(target) {
  try {
    const h = new URL(target).hostname;
    return /(^|\.)loom\.com$/.test(h) || /(^|\.)cdn\.loom\.com$/.test(h) || h.endsWith('.cloudfront.net');
  } catch {
    return false;
  }
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const target = url.searchParams.get('url');
  if (!target || !allowed(target)) {
    return new Response('Bad or disallowed url', { status: 400 });
  }

  // Forward Range so seeking works.
  const fwd = new Headers();
  const range = request.headers.get('Range');
  if (range) fwd.set('Range', range);

  const upstream = await fetch(target, { headers: fwd });

  // Pass through status (200 or 206) and the bytes, stamping permissive CORS + caching.
  const headers = new Headers();
  for (const k of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
    const v = upstream.headers.get(k);
    if (v) headers.set(k, v);
  }
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'video/mp4');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Cache-Control', 'private, max-age=3600');

  return new Response(upstream.body, { status: upstream.status, headers });
}
