// GET /api/proxy?url=<encoded loom cdn mp4 url>
// Same-origin streaming proxy for a downloadable Loom MP4 so the browser <video> element
// can load it and read frames onto a <canvas> (no CORS taint). Honors Range for seeking.
//
// HLS streams are NOT proxied — they load directly (luna.loom.com is CORS-open); this proxy
// is only used for the raw-MP4 path.

function allowed(target) {
  try {
    const h = new URL(target).hostname;
    return (
      /(^|\.)loom\.com$/.test(h) ||
      /(^|\.)cdn\.loom\.com$/.test(h) ||
      /(^|\.)luna\.loom\.com$/.test(h) ||
      h.endsWith('.cloudfront.net') ||
      h.endsWith('.amazonaws.com')
    );
  } catch {
    return false;
  }
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const target = url.searchParams.get('url');
  if (!target || !allowed(target)) return new Response('Bad or disallowed url', { status: 400 });

  const fwd = new Headers();
  const range = request.headers.get('Range');
  if (range) fwd.set('Range', range);

  const upstream = await fetch(target, { headers: fwd });

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
