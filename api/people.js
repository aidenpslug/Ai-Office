// The owner's People page: who may use the office and how many tickets each person gets per month.
//   GET                                   -> { people: [{ email, role, monthlyTickets, note, used, joined }] }
//   POST { email, monthlyTickets, note }  -> add or update a person (monthlyTickets empty = unlimited)
//   DELETE ?email=                        -> remove a person's access (their office data stays)
import { config, adminDb, userFromRequest, ticketsUsed, errorResponse, json, OfficeError } from './_lib.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function owner(request) {
  const user = await userFromRequest(request);
  if (user.member.role !== 'owner') throw new OfficeError('owner_only', 'Only the office owner can manage people.', 403);
  return user;
}
const dev = () => globalThis.__officeDev.members;

async function userIdsByEmail() {
  if (config.dev) return { 'dev@localhost': '00000000-0000-4000-8000-000000000000' };
  const map = {};
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await adminDb().auth.admin.listUsers({ page, perPage: 1000 });
    if (error) break;
    data.users.forEach(u => { if (u.email) map[u.email.toLowerCase()] = u.id; });
    if (data.users.length < 1000) break;
  }
  return map;
}

export async function GET(request) {
  try {
    await owner(request);
    let rows;
    if (config.dev) rows = [...dev().values()];
    else {
      const { data, error } = await adminDb().from('members').select('email,role,monthly_tickets,note,created_at').order('created_at');
      if (error) throw new OfficeError('not_configured', 'The database needs updating. Run supabase/schema.sql again.', 503);
      rows = data;
    }
    const ids = await userIdsByEmail();
    const used = await ticketsUsed(rows.map(r => ids[r.email]).filter(Boolean));
    const people = rows.map(r => ({ email: r.email, role: r.role, monthlyTickets: r.monthly_tickets, note: r.note || '', joined: !!ids[r.email], used: used[ids[r.email]] || 0 }));
    people.sort((a, b) => (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : 0));
    return json({ people });
  } catch (err) { return errorResponse(err); }
}

export async function POST(request) {
  try {
    await owner(request);
    const body = await request.json().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    if (!EMAIL.test(email)) throw new OfficeError('bad_email', "That doesn't look like an email address.");
    const raw = body.monthlyTickets;
    const monthly = raw === null || raw === '' || raw === undefined ? null : Math.max(0, Math.min(100000, parseInt(raw, 10)));
    if (monthly !== null && Number.isNaN(monthly)) throw new OfficeError('bad_number', 'Tickets per month must be a number, or empty for unlimited.');
    const note = String(body.note || '').slice(0, 200);
    if (config.dev) {
      const cur = dev().get(email);
      if (cur?.role === 'owner') throw new OfficeError('owner', "The owner's access can't be changed here.");
      dev().set(email, { email, role: 'member', monthly_tickets: monthly, note });
      return json({ ok: true });
    }
    const { data: cur } = await adminDb().from('members').select('role').eq('email', email).maybeSingle();
    if (cur?.role === 'owner') throw new OfficeError('owner', "The owner's access can't be changed here.");
    const { error } = await adminDb().from('members').upsert({ email, role: 'member', monthly_tickets: monthly, note }, { onConflict: 'email' });
    if (error) throw new OfficeError('save_failed', "Couldn't save that person.", 500);
    return json({ ok: true });
  } catch (err) { return errorResponse(err); }
}

export async function DELETE(request) {
  try {
    await owner(request);
    const email = String(new URL(request.url).searchParams.get('email') || '').toLowerCase();
    if (config.dev) { if (dev().get(email)?.role !== 'owner') dev().delete(email); return json({ ok: true }); }
    const { error } = await adminDb().from('members').delete().eq('email', email).neq('role', 'owner');
    if (error) throw new OfficeError('save_failed', "Couldn't remove that person.", 500);
    return json({ ok: true });
  } catch (err) { return errorResponse(err); }
}
