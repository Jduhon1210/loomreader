// GET /api/loom?id=<loomVideoId or share url>
// Resolves a public/unlisted Loom video to a playable source (raw MP4 if downloadable,
// otherwise the HLS stream) via Loom's GraphQL endpoint — the same call the Loom player uses.
//
// (The old /api/campaigns/sessions/<id>/transcoded-url endpoint was retired by Loom in 2026;
//  it now returns 204 No Content, which is what produced the "Unexpected end of JSON input" error.)

const LOOM_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Origin: 'https://www.loom.com',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function parseLoomId(raw) {
  if (!raw) return null;
  const s = raw.trim();
  const m = s.match(/(?:share|embed)\/([0-9a-f]{20,})/i) || s.match(/^([0-9a-f]{20,})$/i);
  return m ? m[1] : null;
}

// One GraphQL call asks for both a downloadable MP4 and the HLS stream; we prefer MP4.
async function resolveVideo(id) {
  const query =
    'query FetchVideoSSR($videoId: ID!, $password: String) {' +
    ' getVideo(id: $videoId, password: $password) { __typename' +
    ' ... on RegularUserVideo { id' +
    ' mp4: nullableRawCdnUrl(acceptableMimes: [MP4]) { url }' +
    ' hls: nullableRawCdnUrl(acceptableMimes: [M3U8]) { url } } } }';

  const res = await fetch('https://www.loom.com/graphql', {
    method: 'POST',
    headers: { ...LOOM_HEADERS, Referer: `https://www.loom.com/share/${id}` },
    body: JSON.stringify({
      operationName: 'FetchVideoSSR',
      variables: { videoId: id, password: null },
      query,
    }),
  });
  if (!res.ok) throw new Error(`graphql ${res.status}`);
  const data = await res.json();
  const v = data?.data?.getVideo;
  if (!v) throw new Error('video not found');
  // Password-protected / SSO-gated videos come back as a different __typename with no url.
  const mp4 = v.mp4?.url || null;
  const hls = v.hls?.url || null;
  if (mp4) return { type: 'mp4', url: mp4 };
  if (hls) return { type: 'hls', url: hls };
  throw new Error('no playable source (video may be private, password-protected, or SSO-restricted)');
}

// Best-effort transcript. Optional — the SOP is built from frames, so an empty transcript is fine.
async function getTranscript(id) {
  try {
    const res = await fetch(
      `https://www.loom.com/api/campaigns/sessions/${id}/transcript`,
      { method: 'GET', headers: LOOM_HEADERS }
    );
    if (!res.ok) return [];
    const text = await res.text();
    if (!text) return [];
    const data = JSON.parse(text);
    const segs = data?.segments || data?.transcript || data?.captions;
    if (Array.isArray(segs)) {
      return segs
        .map((s) => ({
          start: Number(s.start ?? s.startTime ?? s.from ?? 0),
          text: String(s.text ?? s.content ?? '').trim(),
        }))
        .filter((s) => s.text);
    }
    return [];
  } catch {
    return [];
  }
}

export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const id = parseLoomId(url.searchParams.get('id'));
  if (!id) return json({ error: 'Missing or invalid Loom id/url' }, 400);

  try {
    const [source, transcript] = await Promise.all([resolveVideo(id), getTranscript(id)]);
    return json({ id, type: source.type, url: source.url, transcript });
  } catch (e) {
    return json(
      {
        error:
          'Could not resolve this Loom video. It must be a public or unlisted share link (not private, password-protected, or workspace/SSO-restricted).',
        detail: String(e.message || e),
      },
      502
    );
  }
}
