// Shared server helpers. Files in /api that start with "_" are not web endpoints on Vercel.
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const e = process.env;
export const config = {
  supabaseUrl: e.SUPABASE_URL || e.NEXT_PUBLIC_SUPABASE_URL || '',
  supabaseAnonKey: e.SUPABASE_ANON_KEY || e.NEXT_PUBLIC_SUPABASE_ANON_KEY || e.SUPABASE_PUBLISHABLE_KEY || e.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '',
  supabaseServiceKey: e.SUPABASE_SERVICE_ROLE_KEY || e.SUPABASE_SECRET_KEY || '',
  anthropicKey: e.ANTHROPIC_API_KEY || '',
  // Optional: only these emails can use the office (comma separated). Empty means anyone who signs in.
  allowedEmails: (e.ALLOWED_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  // Claude calls each person can make per day (agent runs plus Jarvis commands).
  dailyLimit: Math.max(1, parseInt(e.DAILY_CLAUDE_CALLS || '60', 10) || 60),
  // Local testing only: no Supabase, fake Claude.
  dev: e.OFFICE_DEV === '1',
};

export const MODEL = 'claude-opus-5-5';
export const QUICK_MODEL = 'claude-haiku-4-5-20251001';

export function missingSettings() {
  if (config.dev) return [];
  const miss = [];
  if (!config.supabaseUrl) miss.push('SUPABASE_URL');
  if (!config.supabaseAnonKey) miss.push('SUPABASE_ANON_KEY');
  if (!config.supabaseServiceKey) miss.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!config.anthropicKey) miss.push('ANTHROPIC_API_KEY');
  return miss;
}

export class OfficeError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
export function errorResponse(err) {
  if (err instanceof OfficeError) return json({ code: err.code, message: err.message }, err.status);
  console.error(err);
  return json({ code: 'server_error', message: 'Something went wrong on the server.' }, 500);
}

let admin;
export function adminDb() {
  if (!admin) admin = createClient(config.supabaseUrl, config.supabaseServiceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return admin;
}

// Who is calling: a signed-in person's session token from the office page.
export async function userFromRequest(request) {
  if (config.dev) return { id: '00000000-0000-4000-8000-000000000000', email: 'dev@localhost' };
  const miss = missingSettings();
  if (miss.length) throw new OfficeError('not_configured', 'The site is missing settings: ' + miss.join(', '), 503);
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) throw new OfficeError('session_expired', 'Sign in again.', 401);
  const { data, error } = await adminDb().auth.getUser(token);
  if (error || !data?.user) throw new OfficeError('session_expired', 'Sign in again.', 401);
  checkAllowed(data.user.email);
  return data.user;
}

export function checkAllowed(email) {
  if (config.allowedEmails.length && !config.allowedEmails.includes(String(email || '').toLowerCase()))
    throw new OfficeError('not_allowed', "This office isn't open to your account. Ask the owner to add your email.", 403);
}

// Counts one Claude call against the person's daily allowance.
export async function spendCall(userId) {
  if (config.dev) return;
  const { data, error } = await adminDb().rpc('bump_usage', { p_user: userId, p_limit: config.dailyLimit });
  if (error) throw new OfficeError('not_configured', 'The database is not set up yet. Run supabase/schema.sql in Supabase.', 503);
  if (data === -1) throw new OfficeError('daily_limit', `You've used today's ${config.dailyLimit} Claude calls. They reset at midnight (UTC).`, 429);
}

let anthropic;
function claudeClient() {
  if (!anthropic) anthropic = new Anthropic({ apiKey: config.anthropicKey });
  return anthropic;
}

// Turns API failures into the short codes the office page understands.
export function codeFor(err) {
  if (err instanceof OfficeError) return err.code;
  if (err instanceof Anthropic.APIUserAbortError) return 'cancelled';
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return 'bad_api_key';
  if (err instanceof Anthropic.RateLimitError) return 'rate_limited';
  if (err instanceof Anthropic.BadRequestError) return 'invalid_request';
  if (err instanceof Anthropic.APIError) return 'upstream_error';
  return 'upstream_error';
}

// Adds an optional screenshot to the first user turn.
function withImage(messages, image) {
  if (!image) return messages;
  const [first, ...rest] = messages;
  const text = typeof first.content === 'string' ? [{ type: 'text', text: first.content }] : first.content;
  return [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: image.media_type, data: image.data } }, ...text] }, ...rest];
}

export function toMessages(prompt) {
  if (typeof prompt === 'string') return [{ role: 'user', content: prompt }];
  if (Array.isArray(prompt) && prompt.length && prompt.every(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'))
    return prompt.map(m => ({ role: m.role, content: m.content }));
  throw new OfficeError('invalid_request', 'The prompt is not in a shape the office understands.');
}

// An agent doing a ticket: streams text as it writes. Resolves to { text, truncated }.
export async function runAgent({ messages, image, signal, onText }) {
  if (config.dev) return fakeRun(messages, signal, onText);
  const body = {
    model: MODEL,
    max_tokens: 32000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    messages: withImage(messages, image),
  };
  const attempt = async useFallbacks => {
    const stream = useFallbacks
      ? claudeClient().beta.messages.stream({ ...body, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal })
      : claudeClient().messages.stream(body, { signal });
    let text = '';
    stream.on('text', delta => { text += delta; onText(delta); });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') throw new OfficeError('refused', 'Claude declined this ticket.');
    if (!text.trim()) throw new OfficeError('empty_completion', 'The agent came back empty.');
    return { text, truncated: msg.stop_reason === 'max_tokens' };
  };
  try {
    return await attempt(true);
  } catch (err) {
    // If this account can't use automatic fallbacks, run once without them rather than failing every ticket.
    if (err instanceof Anthropic.BadRequestError && !signal?.aborted) {
      console.warn('Retrying without fallbacks:', err.message);
      return attempt(false);
    }
    throw err;
  }
}

// A quick answer for Jarvis, parsed as JSON.
export async function quickJson(prompt, signal) {
  if (config.dev) return fakeJarvis(prompt);
  const msg = await claudeClient().messages.create({
    model: QUICK_MODEL,
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  }, { signal });
  if (msg.stop_reason === 'refusal') throw new OfficeError('refused', 'Claude declined that.');
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return parseJson(text);
}

export function parseJson(text) {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new OfficeError('bad_json', "Jarvis's answer wasn't readable.");
  try { return JSON.parse(text.slice(start, end + 1)); }
  catch { throw new OfficeError('bad_json', "Jarvis's answer wasn't readable."); }
}

// ---- local testing stand-ins (OFFICE_DEV=1) ----
async function fakeRun(messages, signal, onText) {
  const ask = messages.map(m => m.content).join('\n');
  const html = /ONE complete, self-contained HTML/.test(ask);
  const out = html
    ? '<!doctype html><html><body style="font-family:sans-serif;padding:40px"><h1>Test design</h1><p>This is a stand-in result from local testing.</p></body></html>'
    : '## Test result\n\nThis is a stand-in result from local testing. ' + 'The agent is writing more words here. '.repeat(12);
  let text = '';
  for (const word of out.split(/(?<= )/)) {
    if (signal?.aborted) throw new Anthropic.APIUserAbortError();
    await new Promise(r => setTimeout(r, 15));
    text += word; onText(word);
  }
  return { text, truncated: false };
}
function fakeJarvis(prompt) {
  const cmd = (prompt.match(/CEO's command: "([\s\S]*)"\s*$/) || [])[1] || '';
  const m = cmd.match(/^(\w+),?\s+(?:can you\s+)?(.+)/i);
  if (/call (\w+)/i.test(cmd)) return { reply: 'On it.', actions: [{ type: 'call_to_office', agent: cmd.match(/call (\w+)/i)[1] }] };
  if (m) return { reply: `I've asked ${m[1]} to do that.`, actions: [{ type: 'create_ticket', agent: m[1], title: m[2].slice(0, 60), details: m[2], kind: 'writing', start: true, attach_screenshot: /screenshot|this/i.test(cmd) }] };
  return { reply: 'Could you say that another way?', actions: [] };
}

// ---- one person's office records, read and written by the server (Siri / Jarvis) ----
export function officeStore(userId) {
  if (config.dev) {
    const mem = globalThis.__officeDev ||= { docs: new Map(), blobs: new Map(), version: 0 };
    return {
      async list(coll) { return [...mem.docs.values()].filter(r => r.collection === coll).map(r => ({ id: r.id, ...r.data })); },
      async put(coll, id, data) { mem.docs.set(coll + '/' + id, { collection: coll, id, data }); mem.version++; },
      async uploadImage(bytes, type) { const id = crypto.randomUUID(); mem.blobs.set(id, { bytes, type }); return id; },
    };
  }
  const db = adminDb();
  return {
    async list(coll) {
      const { data, error } = await db.from('docs').select('id,data').eq('user_id', userId).eq('collection', coll);
      if (error) throw new OfficeError('not_configured', 'The database is not set up yet.', 503);
      return data.map(r => ({ ...r.data, id: r.id }));
    },
    async put(coll, id, data) {
      const { error } = await db.from('docs').upsert({ user_id: userId, collection: coll, id, data, updated_at: new Date().toISOString() }, { onConflict: 'user_id,collection,id' });
      if (error) throw new OfficeError('save_failed', "Couldn't save to your office.", 500);
    },
    async uploadImage(bytes, type) {
      const id = crypto.randomUUID() + (type === 'image/png' ? '.png' : '.jpg');
      const { error } = await db.storage.from('office').upload(`${userId}/${id}`, bytes, { contentType: type });
      if (error) throw new OfficeError('save_failed', "Couldn't save the screenshot.", 500);
      return id;
    },
  };
}
