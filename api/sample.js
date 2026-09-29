// POST /api/sample: the office page asks Claude for something.
//   { mode: "run", prompt, image? }  -> streams lines of JSON: {"d":"text"} ... then {"end":true,"truncated":false} or {"error":{...}}
//   { mode: "json", prompt }         -> { result } (used by Jarvis in the page)
import { userFromRequest, spendCall, runAgent, quickJson, toMessages, codeFor, errorResponse, json, OfficeError } from './_lib.js';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export async function POST(request) {
  let user, body;
  try {
    user = await userFromRequest(request);
    body = await request.json().catch(() => { throw new OfficeError('invalid_request', 'Bad request.'); });
    const messages = toMessages(body.prompt);
    if (body.image && (!IMAGE_TYPES.includes(body.image.media_type) || typeof body.image.data !== 'string'))
      throw new OfficeError('invalid_request', 'That screenshot type is not supported.');
    await spendCall(user.id);

    if (body.mode === 'json') {
      if (typeof body.prompt !== 'string') throw new OfficeError('invalid_request', 'Bad request.');
      const result = await quickJson(body.prompt, request.signal);
      return json({ result });
    }

    const enc = new TextEncoder();
    const ctl = new AbortController();
    request.signal?.addEventListener('abort', () => ctl.abort());
    const stream = new ReadableStream({
      async start(out) {
        const send = obj => { try { out.enqueue(enc.encode(JSON.stringify(obj) + '\n')); } catch {} };
        try {
          const res = await runAgent({ messages, image: body.image, signal: ctl.signal, onText: d => send({ d }) });
          send({ end: true, truncated: res.truncated });
        } catch (err) {
          send({ error: { code: codeFor(err), message: err instanceof OfficeError ? err.message : String(err?.message || err).slice(0, 300) } });
        }
        try { out.close(); } catch {}
      },
      cancel() { ctl.abort(); },
    });
    return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
  } catch (err) {
    if (!(err instanceof OfficeError)) return json({ code: codeFor(err), message: String(err?.message || err).slice(0, 300) }, 502);
    return errorResponse(err);
  }
}
