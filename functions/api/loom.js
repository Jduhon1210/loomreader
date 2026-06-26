// GET /api/loom?id=<loomVideoId>
// Resolves a public/unlisted Loom share link to a raw MP4 URL (+ transcript if available).
// Loom's web app uses these same endpoints; they work for share-link videos.
//
// We do this server-side so the browser never has to deal with Loom's CORS rules.

const LOOM_HEADERS = {
  'Content-Type': 'application/json',
  // A real-ish UA helps; Loom rejects obviously-empty clients.
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Origin: 'https://www.loom.com',
  Referer: 'https://www.loom.com/',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Accepts a bare id, or any loom.com URL that contains /share/<id> or /embed/<id>.
function parseLoomId(raw) {
  if (!raw) return null;
  const s = raw.trim();
  const m = s.match(/(?:share|embed)\/([0-9a-f]{20,})/i) || s.match(/^([0-9a-f]{20,})$/i);
  return m ? m[1] : null;
}

async function getMp4Url(id) {
  const res = await fetch(
    `https://www.loom.com/api/campaigns/sessions/${id}/transcoded-url`,
    { method: 'POST', headers: LOOM_HEADERS, body: JSON.stringify({}) }
  );
  if (!res.ok) throw new Error(`transcoded-url ${res.status}`);
  const data = await res.json();
  // Shape historically: { url: "https://cdn.loom.com/sessions/.../raw.mp4?..." }
  const url = data?.url || data?.transcoded_url || data?.raw_url;
  if (!url) throw new Error('no mp4 url in response');
  return url;
}

// Best-effort transcript. Loom exposes captions/transcript via this endpoint for many videos.
async function getTranscript(id) {
  try {
    const res = await fetch(
      `https://www.loom.com/api/campaigns/sessions/${id}/transcript`,
      { method: 'GET', headers: LOOM_HEADERS }
    );
    if (!res.ok) return null;
    const data = await res.json();
    // Normalize a few possible shapes into [{start, text}]
    const segs = data?.segments || data?.transcript || data?.captions;
    if (Array.isArray(segs)) {
      return segs
        .map((s) => ({
          start: Number(s.start ?? s.startTime ?? s.from ?? 0),
          text: String(s.text ?? s.content ?? '').trim(),
        }))
        .filter((s) => s.text);
    }
    if (typeof data?.text === 'string') return [{ start: 0, text: data.text }];
    return null;
  } catch {
    return null;
  }
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const id = parseLoomId(url.searchParams.get('id'));
  if (!id) return json({ error: 'Missing or invalid Loom id/url' }, 400);

  try {
    const [mp4Url, transcript] = await Promise.all([
      getMp4Url(id),
      getTranscript(id),
    ]);
    return json({ id, mp4Url, transcript: transcript || [] });
  } catch (e) {
    return json(
      {
        error:
          'Could not resolve this Loom video. It must be a public or unlisted share link (not workspace-restricted).',
        detail: String(e.message || e),
      },
      502
    );
  }
}
