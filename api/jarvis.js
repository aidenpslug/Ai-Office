// POST /api/jarvis: Jarvis from outside the office page, e.g. the "Jarvis" Siri shortcut on an iPhone.
// Headers: Authorization: Bearer <your Jarvis key>   (the office page shows it under Account > Siri)
// Body (JSON): { "text": "Bob, can you tidy up this page", "image": "<optional base64 screenshot>" }
// Answers with plain text for Siri to speak (or JSON when the body has "format": "json").
import { config, adminDb, memberFor, spendCall, quickJson, officeStore, codeFor, OfficeError } from './_lib.js';

const PALETTE = ['#3fa37a', '#e06fa6', '#5a8de0', '#e0b43f', '#e0705a', '#8a6bd1', '#2fa7b8', '#b0793f'];
const STATUS = { todo: 'to do', working: 'in progress', review: 'PR waiting for review', changes: 'changes requested', merged: 'done' };
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

async function ownerOf(request, body) {
  const token = ((request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || body.key || '').trim();
  if (!token) throw new OfficeError('no_key', 'Your shortcut is missing its Jarvis key.', 401);
  if (config.dev) { if (token !== 'dev-key') throw new OfficeError('bad_key', "That Jarvis key isn't recognised.", 401); return '00000000-0000-4000-8000-000000000000'; }
  const db = adminDb();
  const { data, error } = await db.from('jarvis_tokens').select('user_id').eq('token', token).maybeSingle();
  if (error) throw new OfficeError('not_configured', 'The database is not set up yet.', 503);
  if (!data) throw new OfficeError('bad_key', "That Jarvis key isn't recognised. Make a new one in your office under Account.", 401);
  const { data: u } = await db.auth.admin.getUserById(data.user_id);
  await memberFor(u?.user?.email);
  return data.user_id;
}

function decodeImage(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const bytes = Buffer.from(raw.replace(/^data:[^,]*,/, '').replace(/\s+/g, ''), 'base64');
  if (bytes.length < 16) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return { bytes, type: 'image/png' };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { bytes, type: 'image/jpeg' };
  throw new OfficeError('bad_image', 'Send the screenshot as a PNG or JPEG.');
}

function findAgent(staff, name) {
  if (!name) return null;
  const n = String(name).trim().toLowerCase();
  return staff.find(s => s.name.toLowerCase() === n) || staff.find(s => s.name.toLowerCase().startsWith(n) || n.startsWith(s.name.toLowerCase())) ||
    staff.find(s => (s.role || '').toLowerCase().includes(n)) || null;
}

function buildPrompt(command, staff, tickets, hasImg) {
  const byId = Object.fromEntries(staff.map(s => [s.id, s]));
  const team = staff.map(s => {
    const t = tickets.find(x => x.assignee === s.id && x.status === 'working');
    return `- ${s.name}, ${s.role}${t ? ` (working on #${t.num} "${t.title}")` : ' (free)'}`;
  }).join('\n') || '(nobody hired yet)';
  const open = tickets.filter(t => t.status !== 'merged').sort((a, b) => a.num - b.num).slice(0, 25)
    .map(t => `- #${t.num} "${t.title}" · ${STATUS[t.status] || t.status} · ${byId[t.assignee]?.name || 'unassigned'}`).join('\n') || '(none)';
  return `You are Jarvis, the assistant of the CEO of "The AI Office", an office staffed by AI agents. The CEO is talking to you through Siri on their phone, so expect speech-to-text typos, missing punctuation and misheard names. Turn the command into actions.

Team:
${team}

Open tickets and PRs:
${open}

Screenshot attached to this command: ${hasImg ? 'YES' : 'no'}

Actions you can use:
{"type":"create_ticket","agent":"<agent name>","title":"<short title>","details":"<the full request in clear sentences, including anything the CEO said about the screenshot>","kind":"design|code|writing|steps|video","start":true,"attach_screenshot":${hasImg}}
{"type":"call_to_office","agent":"<agent name>"}
{"type":"note","agent":"<agent name>","text":"<note for an agent who is working right now>"}
{"type":"start","ticket":<number>}
{"type":"hire","name":"<name>","role":"<role>","instructions":"<short standing instructions>"}

Rules:
- "X, can you do Y" or "have X do Y" means create_ticket for X with start true.
- Match agent names loosely to the team list (misheard names are common). If nobody fits, don't invent one: say so in reply and suggest hiring them.
- kind: design for anything visual (pages, layouts, mockups), code for programs and scripts, steps for homework, quiz or school problems (video instead when they ask for a video or an explainer), writing for everything else (research, copy, plans).
- Homework and school problems go to the educator on the team unless the CEO names someone else.
- Use note only when the agent is currently working; otherwise create a ticket.
- Set attach_screenshot true when a screenshot is attached and the command is about it ("this", "the screenshot", "what's on my screen").
- If the command is unclear, return no actions and ask one short question in reply.
- The reply is spoken aloud by Siri: one or two short, natural sentences, no lists or symbols.

Reply with only JSON: {"reply":"<what Siri says back>","actions":[...]}

CEO's command: "${command.replace(/"/g, "'")}"`;
}

async function runActions(store, actions, staff, tickets, image) {
  const done = [];
  let queued = false;
  const now = Date.now();
  const nextNum = () => tickets.reduce((m, t) => Math.max(m, t.num || 0), 0) + 1;
  for (const a of (Array.isArray(actions) ? actions : []).slice(0, 6)) {
    const type = a && a.type;
    if (type === 'hire') {
      if (staff.length >= 8) { done.push('No free desk to hire'); continue; }
      const name = String(a.name || '').trim().slice(0, 16), role = String(a.role || '').trim().slice(0, 28);
      if (!name || !role) continue;
      const used = new Set(staff.map(x => x.color));
      const s = { id: uid('a'), name, role, instructions: String(a.instructions || '').slice(0, 1200), color: PALETTE.find(c => !used.has(c)) || PALETTE[staff.length % PALETTE.length], hiredAt: now + staff.length };
      const { id, ...data } = s;
      await store.put('staff', id, data); staff.push(s); done.push(`Hired ${name}`);
    } else if (type === 'create_ticket') {
      const s = findAgent(staff, a.agent);
      const t = { id: uid('t'), num: nextNum(), title: String(a.title || 'New task').slice(0, 70), detail: String(a.details || '').slice(0, 4000), kind: ['design', 'code', 'writing', 'steps', 'video'].includes(a.kind) ? a.kind : 'writing', assignee: s ? s.id : null, status: 'todo', createdAt: now, fromJarvis: true };
      let note = `Ticket #${t.num} for ${s ? s.name : 'nobody yet'}`;
      if (image) { t.imageId = await store.uploadImage(image.bytes, image.type); image = null; note += ' with your screenshot'; }
      if (a.start !== false && s) { t.autoStart = true; queued = true; }
      const { id, ...data } = t;
      await store.put('tickets', id, data); tickets.push(t); done.push(note);
    } else if (type === 'call_to_office') {
      const s = findAgent(staff, a.agent); if (!s) continue;
      const { id, ...data } = s;
      await store.put('staff', id, { ...data, calledAt: now }); done.push(`Called ${s.name} in`);
    } else if (type === 'note') {
      const s = findAgent(staff, a.agent); if (!s) continue;
      const t = tickets.find(x => x.assignee === s.id && x.status === 'working') ||
        tickets.filter(x => x.assignee === s.id && ['todo', 'changes'].includes(x.status)).sort((x, y) => x.num - y.num)[0];
      if (!t) { done.push(`${s.name} has nothing to add a note to`); continue; }
      const { id, ...data } = t;
      await store.put('tickets', id, { ...data, notes: [...(t.notes || []), String(a.text || '').slice(0, 300)], updatedAt: now });
      done.push(`Note sent to ${s.name}`);
    } else if (type === 'start') {
      const t = tickets.find(x => x.num === Number(a.ticket));
      if (!t || !['todo', 'changes'].includes(t.status) || !t.assignee) continue;
      const { id, ...data } = t;
      await store.put('tickets', id, { ...data, autoStart: true }); queued = true; done.push(`#${t.num} queued to start`);
    }
  }
  return { done, queued };
}

export async function POST(request) {
  let body = {};
  const wantsJson = () => body.format === 'json' || (request.headers.get('accept') || '').includes('application/json');
  const answer = (reply, extra = {}, status = 200) => wantsJson()
    ? new Response(JSON.stringify({ reply, ...extra }), { status, headers: { 'content-type': 'application/json' } })
    : new Response(reply, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  try {
    body = await request.json().catch(() => ({}));
    const userId = await ownerOf(request, body);
    const text = String(body.text || '').trim().slice(0, 600);
    if (!text) return answer('Yes? Tell me what you need.');
    const image = decodeImage(body.image);
    await spendCall(userId);
    const store = officeStore(userId);
    const staff = (await store.list('staff')).sort((a, b) => (a.hiredAt || 0) - (b.hiredAt || 0));
    const tickets = await store.list('tickets');
    const out = await quickJson(buildPrompt(text, staff, tickets, !!image));
    const { done, queued } = await runActions(store, out.actions, staff, tickets, image);
    let reply = String(out.reply || 'Done.').slice(0, 400);
    if (queued) reply += ' They will start as soon as your office is open on any device.';
    return answer(reply, { done });
  } catch (err) {
    const code = codeFor(err);
    const msg = err instanceof OfficeError ? err.message : code === 'rate_limited' ? 'Claude is busy right now. Try again in a minute.' : "Sorry, something went wrong reaching your office.";
    if (!(err instanceof OfficeError)) console.error(err);
    return answer(msg, { code }, err instanceof OfficeError ? err.status : 502);
  }
}
