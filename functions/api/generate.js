// POST /api/generate
// Body: { frames: [{ index, t, dataUrl }], transcript: [{ start, text }], context?: string }
// Calls Claude (vision) to produce the video-derived parts of the Operations SOP template:
// Title, Purpose, Scope, Definitions, and the step-by-step Procedure (with screenshot frames).
// Administrative fields (SOP number, dates, roles, etc.) are handled/edited in the browser.
//
// Requires Cloudflare secret: ANTHROPIC_API_KEY
// Model configurable via MODEL env var; defaults to the latest Sonnet.

const DEFAULT_MODEL = 'claude-sonnet-4-6';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Structured shape matching the Atlas Carts Operations SOP template.
const SOP_TOOL = {
  name: 'emit_sop',
  description: 'Return the video-derived sections of the Operations SOP as structured data.',
  input_schema: {
    type: 'object',
    required: ['title', 'purpose', 'scope', 'procedure'],
    properties: {
      title: {
        type: 'string',
        description: 'SOP Title — the name of the feature/function the recording demonstrates, e.g. "Confirming a Sales Order".',
      },
      purpose: {
        type: 'string',
        description: 'Section 4. One or two sentences: what this procedure accomplishes and why.',
      },
      scope: {
        type: 'string',
        description: 'Section 5. Who/what this applies to (e.g. "All Sales users creating quotations in Odoo").',
      },
      definitions: {
        type: 'array',
        description: 'Section 6. ONLY new/non-obvious terms that appear in this specific recording (not generic ones). May be empty.',
        items: {
          type: 'object',
          required: ['term', 'definition'],
          properties: {
            term: { type: 'string' },
            definition: { type: 'string' },
          },
        },
      },
      procedure: {
        type: 'array',
        description: 'Section 10. Ordered steps reconstructing exactly what the presenter does. One discrete action per step.',
        items: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string', description: 'The instruction. Name the exact app, menu, button, or field shown.' },
            substeps: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional lettered sub-points (a, b, c) for a step with multiple parts.',
            },
            note: { type: 'string', description: 'Optional NOTE / tip / warning for this step.' },
            screenshotFrame: {
              type: 'integer',
              description: 'Index of the single most illustrative provided frame for this step, or omit if none fits.',
            },
          },
        },
      },
    },
  },
};

function systemPrompt(context) {
  return [
    'You are a senior Odoo functional consultant writing a client-ready Standard Operating Procedure (SOP).',
    'The input is a Loom screen-recording in which the consultant demonstrates a NEW feature or function they built in Odoo.',
    'You are given sequential frames from that recording and, when available, its transcript.',
    'Your job: reconstruct exactly what is done on screen and write the SOP sections a brand-new user could follow alone.',
    '',
    'Produce only these sections (the rest of the template is filled in separately):',
    '- title: the feature/function being demonstrated.',
    '- purpose: what the procedure accomplishes and why it matters.',
    '- scope: who it applies to / when it is used.',
    '- definitions: ONLY terms specific to this recording that a user might not know. Skip generic ones. Often empty.',
    '- procedure: the detailed step-by-step.',
    '',
    'Procedure rules:',
    '- Each step is ONE discrete action. Be concrete: name the exact Odoo app, breadcrumb, menu, button, smart button, or field shown on screen.',
    '- Use correct Odoo terminology (apps, list/form/kanban views, Settings > Technical, filters, stages, etc.).',
    '- Where a step has several parts, use substeps (rendered a, b, c).',
    '- For each step, set screenshotFrame to the index of the single frame that best shows that action. Do not invent frames not provided.',
    '- Write durable instructions ("Click Confirm"), not narration ("the cursor moves to Confirm").',
    '- Be thorough — capture every meaningful action needed to reproduce the function, in order.',
    context ? `\nExtra context from the user (use it, it is authoritative):\n${context}` : '',
    '',
    'Call emit_sop with the result. Do not write any prose outside the tool call.',
  ].join('\n');
}

export async function onRequestPost({ request, env }) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json({ error: 'Server is missing ANTHROPIC_API_KEY. Add it as a Cloudflare Pages secret.' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const frames = Array.isArray(body.frames) ? body.frames : [];
  const transcript = Array.isArray(body.transcript) ? body.transcript : [];
  if (!frames.length) return json({ error: 'No frames provided' }, 400);

  const content = [];
  content.push({
    type: 'text',
    text:
      `Here are ${frames.length} frames from the recording, in order. ` +
      `Each is labeled "Frame N (mm:ss)". Use the integer N when setting screenshotFrame.`,
  });
  for (const f of frames) {
    const mm = String(Math.floor((f.t || 0) / 60)).padStart(2, '0');
    const ss = String(Math.floor((f.t || 0) % 60)).padStart(2, '0');
    content.push({ type: 'text', text: `Frame ${f.index} (${mm}:${ss}):` });
    const m = /^data:(image\/\w+);base64,(.+)$/.exec(f.dataUrl || '');
    if (m) {
      content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
    }
  }
  if (transcript.length) {
    const tx = transcript
      .map((s) => {
        const mm = String(Math.floor((s.start || 0) / 60)).padStart(2, '0');
        const ss = String(Math.floor((s.start || 0) % 60)).padStart(2, '0');
        return `[${mm}:${ss}] ${s.text}`;
      })
      .join('\n');
    content.push({ type: 'text', text: `Transcript:\n${tx}` });
  }

  const payload = {
    model: env.MODEL || DEFAULT_MODEL,
    max_tokens: 4096,
    system: systemPrompt(body.context),
    tools: [SOP_TOOL],
    tool_choice: { type: 'tool', name: 'emit_sop' },
    messages: [{ role: 'user', content }],
  };

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const detail = await res.text();
      return json({ error: `Claude API error ${res.status}`, detail }, 502);
    }

    const data = await res.json();
    const toolUse = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'emit_sop');
    if (!toolUse) return json({ error: 'Model did not return a structured SOP', detail: data }, 502);
    return json({ sop: toolUse.input, usage: data.usage || null });
  } catch (e) {
    return json({ error: 'Request to Claude failed', detail: String(e.message || e) }, 502);
  }
}
