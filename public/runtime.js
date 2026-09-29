// The AI Office website runtime.
// Signs the person in (Supabase), then gives the office page the same small toolkit it had inside Claude:
//   window.claude.use('sample' | 'db' | 'downloads' | 'assets')   and   window.officeBlob(id)
(() => {
  const PALETTE = ['#3fa37a', '#e06fa6', '#5a8de0', '#e0b43f', '#e0705a', '#8a6bd1', '#2fa7b8', '#b0793f'];
  const STARTERS = [
    ['Juno', 'Frontend engineer', 'Prefer plain HTML and CSS. Keep it accessible.'],
    ['Ren', 'Product designer', 'Bold, clean layouts. Always offer options.'],
    ['Bill', 'Educator', 'You are a patient, upbeat tutor with the energy of a TV science-show host. Explain homework and quiz problems in short, easy steps, say why each step works, and double-check the final answer. Never give just the answer without the steps.'],
  ];
  const BILL = 2;
  const TUTOR_ROLE = /educat|tutor|teach/i;
  const fail = (code, message, text) => Object.assign(new Error(message || code), { code, text });
  let sb = null, user = null, cfg = null, me = null;
  let signedIn; const ready = new Promise(r => (signedIn = r));

  // ---------- sign-in screen ----------
  const css = document.createElement('style');
  css.textContent = `
  .gate { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; background: var(--bg); padding: 16px; }
  .gate-card { width: min(420px, 100%); background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 28px; display: grid; gap: 14px; }
  .gate-card h1 { font-family: var(--font-display); font-size: 28px; margin: 0; }
  .gate-card p { margin: 0; color: var(--muted); }
  .gate-card input { font: inherit; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); width: 100%; }
  .gate-card .err { color: var(--danger); }
  .acct { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; background: rgb(0 0 0 / .35); padding: 16px; }
  .acct-card { width: min(560px, 100%); max-height: calc(100% - 32px); overflow: auto; background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 12px; padding: 22px; display: grid; gap: 12px; }
  .acct-card h2 { margin: 0; font-family: var(--font-display); }
  .acct-card h3 { margin: 6px 0 0; font-size: 15px; }
  .acct-card p, .acct-card li { color: var(--muted); margin: 0; }
  .acct-card ol { margin: 0; padding-left: 20px; display: grid; gap: 6px; }
  .acct-card code, .acct-card .key { font-family: var(--font-mono); font-size: 12px; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 2px 6px; word-break: break-all; }
  .acct-card .key { display: block; padding: 8px 10px; }
  .acct-card .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .acct-card b { color: var(--ink); }
  .acct-card input { font: inherit; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); }
  .acct-card .err { color: var(--danger); }`;
  document.head.append(css);

  function gate(html) {
    let g = document.getElementById('gate');
    if (!g) { g = document.createElement('div'); g.id = 'gate'; g.className = 'gate'; document.body.append(g); }
    g.innerHTML = `<div class="gate-card">${html}</div>`;
    return g;
  }
  function showSignIn(msg) {
    const g = gate(`<h1>The AI Office</h1>
      <p>Your own office of AI agents. Sign in with your email and we'll send you a link. No password needed.</p>
      <form id="gate-form" class="row" style="display:grid;gap:10px">
        <input type="email" id="gate-email" required autocomplete="email" placeholder="you@example.com" aria-label="Email address">
        <button type="submit" class="primary">Email me a sign-in link</button>
      </form>
      <p class="err" id="gate-err">${msg ? escapeHtml(msg) : ''}</p>`);
    g.querySelector('#gate-form').onsubmit = async ev => {
      ev.preventDefault();
      const email = g.querySelector('#gate-email').value.trim();
      const btn = g.querySelector('button'); btn.disabled = true; btn.textContent = 'Sending…';
      const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) {
        btn.disabled = false; btn.textContent = 'Email me a sign-in link';
        g.querySelector('#gate-err').textContent = /rate/i.test(error.message) ? 'Too many sign-in emails right now. Try again in a little while.' : error.message;
        return;
      }
      gate(`<h1>Check your email</h1><p>We sent a sign-in link to <b>${escapeHtml(email)}</b>. Open it on this device and your office will load.</p>
        <button type="button" id="gate-back">Use a different email</button>`).querySelector('#gate-back').onclick = () => showSignIn();
    };
  }
  function showProblem(title, text) { gate(`<h1>${escapeHtml(title)}</h1><p>${text}</p>`); }
  function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ---------- boot ----------
  async function boot() {
    try { cfg = await (await fetch('/api/config', { cache: 'no-store' })).json(); }
    catch { return showProblem("Can't reach the office", 'The server did not answer. Check your connection and reload.'); }
    if (cfg.dev) { user = { id: 'dev', email: 'dev@localhost' }; await loadMe(); signedIn(); return; }
    if (cfg.missing?.length) return showProblem('Almost set up', `The site still needs these settings in Vercel: <code>${cfg.missing.map(escapeHtml).join('</code>, <code>')}</code>. Add them under Settings, Environment Variables, then redeploy.`);
    try {
      await new Promise((res, rej) => { const el = document.createElement('script'); el.src = '/vendor/supabase.js'; el.onload = res; el.onerror = rej; document.head.append(el); });
    } catch { return showProblem("Can't reach the office", 'Part of the page failed to load. Check your connection and reload.'); }
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { flowType: 'implicit', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    const urlErr = new URLSearchParams(location.hash.slice(1)).get('error_description');
    const { data } = await sb.auth.getSession();
    if (data.session) return enter(data.session.user);
    showSignIn(urlErr ? 'That sign-in link has expired or was already used. Send a new one.' : '');
    sb.auth.onAuthStateChange((event, session) => { if (session && !user) enter(session.user); });
  }
  async function enter(u) {
    user = u;
    if (location.hash.includes('access_token')) history.replaceState(null, '', location.pathname);
    const { error } = await sb.from('docs').select('id', { head: true, count: 'exact' }).limit(1);
    if (error) return showProblem('Almost set up', 'The database tables are missing. In Supabase, open SQL Editor, paste the file <code>supabase/schema.sql</code> from the project, and press Run. Then reload this page.');
    const r = await loadMe();
    if (r === 'not_allowed') {
      gate(`<h1>Invite only</h1><p>This office is invite-only, and <b>${escapeHtml(u.email)}</b> isn't on the list yet. Ask the owner to add you, then reload this page.</p>
        <button type="button" id="gate-out">Sign out</button>`).querySelector('#gate-out').onclick = async () => { await sb.auth.signOut(); location.reload(); };
      return;
    }
    if (r === 'not_configured') return showProblem('Almost set up', 'The database needs an update. In Supabase, open SQL Editor, paste the latest <code>supabase/schema.sql</code> from the project, and press Run. Then reload this page.');
    if (!u.user_metadata?.office_seeded) {
      const { count } = await sb.from('docs').select('id', { head: true, count: 'exact' }).eq('collection', 'staff');
      if (!count) {
        const now = Date.now();
        await sb.from('docs').upsert(STARTERS.map(([name, role, instructions], i) => ({
          user_id: u.id, collection: 'staff', id: 'starter' + i, data: { name, role, instructions, color: PALETTE[i], hiredAt: now + i },
        })), { onConflict: 'user_id,collection,id' });
      }
      await sb.auth.updateUser({ data: { office_seeded: true, bill_joined: true } });
    } else if (!u.user_metadata?.bill_joined) {
      // Offices made before Bill existed get him once, if there's a free desk.
      const { data: staff } = await sb.from('docs').select('id,data').eq('collection', 'staff');
      const rows = staff || [];
      if (rows.length < 8 && !rows.some(r => TUTOR_ROLE.test(r.data?.role || ''))) {
        const used = new Set(rows.map(r => r.data?.color));
        const [name, role, instructions] = STARTERS[BILL];
        await sb.from('docs').upsert({ user_id: u.id, collection: 'staff', id: 'starter-bill', data: { name, role, instructions, color: PALETTE.find(c => !used.has(c)) || PALETTE[2], hiredAt: Date.now() } }, { onConflict: 'user_id,collection,id' });
      }
      await sb.auth.updateUser({ data: { bill_joined: true } });
    }
    document.getElementById('gate')?.remove();
    signedIn();
  }
  async function loadMe() {
    try {
      const r = await fetch('/api/me', { headers: await authHeaders(), cache: 'no-store' });
      const j = await r.json();
      if (!r.ok) return j.code || 'error';
      me = j; return 'ok';
    } catch { return 'error'; }
  }
  async function authHeaders() {
    const h = { 'content-type': 'application/json' };
    if (sb) { const { data } = await sb.auth.getSession(); if (data.session) h.authorization = 'Bearer ' + data.session.access_token; }
    return h;
  }

  // ---------- images: shrink big screenshots before sending ----------
  async function shrink(blob, max = 1600) {
    try {
      const bmp = await createImageBitmap(blob);
      const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
      if (k === 1 && blob.size < 1_500_000 && /^image\/(png|jpeg|webp|gif)$/.test(blob.type)) return blob;
      const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    } catch { return blob; }
  }
  const toB64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });

  // ---------- sample: ask Claude through the server ----------
  async function post(body, signal) {
    let res;
    try { res = await fetch('/api/sample', { method: 'POST', headers: await authHeaders(), body: JSON.stringify(body), signal }); }
    catch (e) { throw signal?.aborted ? fail('cancelled') : fail('network', "Couldn't reach the server."); }
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw fail(j.code || 'upstream_error', j.message); }
    return res;
  }
  async function sample(prompt, opts = {}) {
    const body = { mode: 'run', prompt };
    const img = Array.isArray(opts.images) ? opts.images[0] : opts.images;
    if (img) { const small = await shrink(img); body.image = { media_type: small.type || 'image/png', data: await toB64(small) }; }
    const res = await post(body, opts.signal);
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '', text = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const m = JSON.parse(line);
          if (m.d) { text += m.d; opts.onText?.({ text }); }
          else if (m.error) throw fail(m.error.code, m.error.message, text);
          else if (m.end) return { text, truncated: !!m.truncated };
        }
      }
    } catch (e) {
      if (opts.signal?.aborted) throw fail('cancelled');
      if (e.code) throw e;
      throw fail('network', 'The connection dropped mid-task.', text);
    }
    throw fail(opts.signal?.aborted ? 'cancelled' : 'network', 'The connection dropped mid-task.', text);
  }
  sample.json = async (prompt, opts = {}) => (await (await post({ mode: 'json', prompt }, opts.signal)).json()).result;
  sample.limits = async () => ({ images: true });

  // ---------- db: this person's office records, live ----------
  function makeDb() {
    const cache = {}, subs = {};
    const emit = coll => { const docs = [...(cache[coll] || new Map())].map(([id, d]) => ({ id, data: () => d })); (subs[coll] || new Set()).forEach(l => l.cb({ docs })); };
    const api = cfg.dev ? devBackend() : supaBackend();
    async function load(coll) {
      try { const rows = await api.list(coll); cache[coll] = new Map(rows.map(r => [r.id, r.data])); emit(coll); }
      catch (e) { (subs[coll] || new Set()).forEach(l => l.err?.(e)); }
    }
    const reloadAll = () => Object.keys(subs).forEach(load);
    api.watch((coll, id, data) => {
      if (!cache[coll]) return;
      if (data === null) cache[coll].delete(id); else cache[coll].set(id, data);
      emit(coll);
    }, reloadAll);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reloadAll(); });
    return {
      collection: coll => ({
        onSnapshot(cb, err) {
          const l = { cb, err }; (subs[coll] ||= new Set()).add(l);
          if (cache[coll]) emit(coll); else load(coll);
          return () => subs[coll].delete(l);
        },
      }),
      doc: path => {
        const [coll, id] = path.split('/');
        return {
          async set(data) { (cache[coll] ||= new Map()).set(id, data); await api.put(coll, id, data); },
          async delete() { cache[coll]?.delete(id); await api.remove(coll, id); },
        };
      },
    };
  }
  function supaBackend() {
    return {
      async list(coll) {
        const { data, error } = await sb.from('docs').select('id,data').eq('collection', coll).limit(2000);
        if (error) throw fail('read_failed', error.message); return data;
      },
      async put(coll, id, data) {
        const { error } = await sb.from('docs').upsert({ user_id: user.id, collection: coll, id, data, updated_at: new Date().toISOString() }, { onConflict: 'user_id,collection,id' });
        if (error) throw fail(/too large|payload/i.test(error.message) ? 'quota_exceeded' : 'write_failed', error.message);
      },
      async remove(coll, id) {
        const { error } = await sb.from('docs').delete().eq('collection', coll).eq('id', id);
        if (error) throw fail('write_failed', error.message);
      },
      watch(onChange, onReconnect) {
        let joined = false;
        sb.channel('office-' + user.id)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'docs', filter: 'user_id=eq.' + user.id }, p => {
            const row = p.eventType === 'DELETE' ? p.old : p.new;
            if (!row || !row.collection || (row.user_id && row.user_id !== user.id)) return;
            onChange(row.collection, row.id, p.eventType === 'DELETE' ? null : (row.data || {}));
          })
          .subscribe(status => {
            if (status === 'SUBSCRIBED') { if (joined) onReconnect(); joined = true; }
          });
      },
    };
  }
  function devBackend() {
    const call = (method, q, body) => fetch('/dev/db' + q, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then(r => r.json());
    return {
      list: coll => call('GET', '?coll=' + coll),
      put: (coll, id, data) => call('PUT', '', { coll, id, data }),
      remove: (coll, id) => call('DELETE', '?coll=' + coll + '&id=' + encodeURIComponent(id)),
      watch(_onChange, onReconnect) {
        let v = null;
        setInterval(async () => { const { version } = await call('GET', '?version=1'); if (v !== null && version !== v) onReconnect(); v = version; }, 1000);
      },
    };
  }

  // ---------- screenshots ----------
  const assets = {
    async upload(blob, { type } = {}) {
      const small = await shrink(blob);
      const ext = small.type === 'image/png' ? '.png' : '.jpg';
      const id = crypto.randomUUID() + ext;
      if (cfg.dev) { await fetch('/dev/blob/' + id, { method: 'PUT', headers: { 'content-type': small.type || type }, body: small }); return { id }; }
      const { error } = await sb.storage.from('office').upload(`${user.id}/${id}`, small, { contentType: small.type || type || 'image/png' });
      if (error) throw fail('upload_failed', error.message);
      return { id };
    },
  };
  window.officeBlob = async id => {
    await ready;
    if (cfg.dev) { const r = await fetch('/dev/blob/' + id); if (!r.ok) throw fail('missing'); return r.blob(); }
    const { data, error } = await sb.storage.from('office').download(`${user.id}/${id}`);
    if (error) throw fail('missing', error.message);
    return data;
  };

  // ---------- downloads ----------
  const TYPES = { html: 'text/html', md: 'text/markdown', txt: 'text/plain', json: 'application/json', csv: 'text/csv', svg: 'image/svg+xml' };
  const downloads = {
    async save({ filename, data }) {
      const ext = String(filename).split('.').pop().toLowerCase();
      const blob = data instanceof Blob ? data : new Blob([data], { type: (TYPES[ext] || 'application/octet-stream') + ';charset=utf-8' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      return { status: 'saved' };
    },
  };

  // ---------- account: Siri key, sign out ----------
  function randomKey() { const b = new Uint8Array(32); crypto.getRandomValues(b); return 'jv_' + Array.from(b, x => x.toString(16).padStart(2, '0')).join(''); }
  async function openAccount() {
    const wrap = document.createElement('div'); wrap.className = 'acct'; wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-label', 'Account');
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    wrap.onclick = e => { if (e.target === wrap) close(); };
    document.body.append(wrap);
    await loadMe();
    let key = null;
    if (!cfg.dev) { const { data } = await sb.from('jarvis_tokens').select('token').maybeSingle(); key = data?.token || null; }
    else key = 'dev-key';
    const endpoint = location.origin + '/api/jarvis';
    const render = () => {
      wrap.innerHTML = `<div class="acct-card">
        <div class="row"><h2 style="flex:1">Account</h2><button type="button" class="small" data-x>Close</button></div>
        <p>Signed in as <b>${escapeHtml(user.email)}</b>${me?.role === 'owner' ? ', the owner of this site' : ''}. Your office, agents and tickets are private to you.</p>
        ${me ? `<p>Tickets this month: <b>${me.used}${me.monthlyTickets == null ? '' : ' of ' + me.monthlyTickets}</b>${me.monthlyTickets == null ? ' (unlimited)' : ''}. Each time an agent works on a ticket or a revision counts as one.</p>` : ''}
        ${me?.role === 'owner' ? `<h3>People</h3><p>Only people on this list can use the site. Set how many tickets each person gets per month; leave it empty for unlimited.</p><div data-people><p>Loading…</p></div>
          <form class="row" data-add><input type="email" required placeholder="their@email.com" aria-label="Email to add" style="flex:2;min-width:180px"><input type="number" min="0" placeholder="Tickets / month" aria-label="Tickets per month" style="flex:1;min-width:110px"><button type="submit" class="primary small">Add person</button></form>` : ''}
        <h3>Talk to Jarvis with Siri</h3>
        ${key ? `<p>Your Jarvis key. Treat it like a password: anyone with it can give orders to your office.</p><span class="key">${escapeHtml(key)}</span>
          <div class="row"><button type="button" class="small primary" data-copy>Copy key</button><button type="button" class="small" data-new>Make a new key</button></div>`
        : `<p>Make a key first. Your iPhone shortcut uses it to reach your office.</p><div class="row"><button type="button" class="primary" data-new>Make my Jarvis key</button></div>`}
        <p>On your iPhone, open the <b>Shortcuts</b> app, tap <b>+</b>, and name the shortcut <b>Jarvis</b>. Add these actions in order:</p>
        <ol>
          <li><b>Dictate Text</b>.</li>
          <li><b>Get Contents of URL</b> with the URL <code>${escapeHtml(endpoint)}</code>. Tap the arrow to show more: set Method to <b>POST</b> and Request Body to <b>JSON</b>, then add two Text fields: <b>key</b> set to your key, and <b>text</b> set to <b>Dictated Text</b>.</li>
          <li><b>Speak Text</b> with <b>Contents of URL</b>.</li>
        </ol>
        <p>Now say <b>“Hey Siri, Jarvis”</b>, then your command, like “Bob, can you draft the launch email”.</p>
        <p>To send what's on your screen: make a second shortcut called <b>Jarvis screen</b> that starts with <b>Take Screenshot</b>, <b>Resize Image</b> to width 1200, <b>Convert Image</b> to JPEG and <b>Base64 Encode</b>, then the same three actions with a third JSON Text field named <b>image</b> set to <b>Base64 Encoded</b>.</p>
        <p>Agents Jarvis starts from your phone begin work as soon as this office is open on any device.</p>
        <h3>Leave</h3>
        <div class="row"><button type="button" data-out>Sign out</button></div>
      </div>`;
      wrap.querySelector('[data-x]').onclick = close;
      if (me?.role === 'owner') {
        loadPeople(wrap.querySelector('[data-people]'));
        wrap.querySelector('[data-add]').onsubmit = async ev => {
          ev.preventDefault();
          const [em, n] = ev.target.querySelectorAll('input');
          if (await savePerson(em.value, n.value)) { em.value = ''; n.value = ''; loadPeople(wrap.querySelector('[data-people]')); }
        };
      }
      wrap.querySelector('[data-copy]')?.addEventListener('click', async e => { try { await navigator.clipboard.writeText(key); e.target.textContent = 'Copied'; } catch { e.target.textContent = 'Select and copy it above'; } });
      wrap.querySelector('[data-new]').onclick = async () => {
        if (key && !confirm('Make a new key? Your current shortcut stops working until you paste the new key into it.')) return;
        const k = randomKey();
        if (!cfg.dev) {
          const { error } = await sb.from('jarvis_tokens').upsert({ user_id: user.id, token: k }, { onConflict: 'user_id' });
          if (error) { alert("Couldn't make a key: " + error.message); return; }
        }
        key = k; render();
      };
      wrap.querySelector('[data-out]').onclick = async () => { if (sb) await sb.auth.signOut(); location.reload(); };
    };
    render();
  }
  async function peopleApi(method, q = '', body) {
    const r = await fetch('/api/people' + q, { method, headers: await authHeaders(), body: body && JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw fail(j.code || 'error', j.message || 'Something went wrong.');
    return j;
  }
  async function savePerson(email, tickets) {
    try { await peopleApi('POST', '', { email, monthlyTickets: tickets === '' ? null : tickets }); return true; }
    catch (e) { alert(e.message); return false; }
  }
  async function loadPeople(box) {
    if (!box) return;
    let people;
    try { ({ people } = await peopleApi('GET')); } catch (e) { box.innerHTML = `<p class="err">${escapeHtml(e.message)}</p>`; return; }
    box.innerHTML = '';
    const list = document.createElement('div'); list.style.cssText = 'display:grid;gap:8px';
    people.forEach(p => {
      const row = document.createElement('div'); row.className = 'row';
      row.innerHTML = `<span style="flex:2;min-width:160px"><b style="word-break:break-all">${escapeHtml(p.email)}</b><br><span style="color:var(--muted);font-size:12px">${p.role === 'owner' ? 'Owner' : p.joined ? 'Joined' : 'Invited, not signed in yet'} · ${p.used} used this month</span></span>`;
      if (p.role === 'owner') { row.insertAdjacentHTML('beforeend', '<span style="color:var(--muted)">Unlimited</span>'); list.append(row); return; }
      const n = document.createElement('input'); n.type = 'number'; n.min = '0'; n.value = p.monthlyTickets ?? ''; n.placeholder = 'Unlimited';
      n.setAttribute('aria-label', 'Tickets per month for ' + p.email); n.style.cssText = 'width:110px';
      const save = document.createElement('button'); save.type = 'button'; save.className = 'small'; save.textContent = 'Save';
      save.onclick = async () => { if (await savePerson(p.email, n.value)) { save.textContent = 'Saved'; setTimeout(() => (save.textContent = 'Save'), 1500); } };
      const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'small danger'; rm.textContent = 'Remove';
      rm.onclick = async () => {
        if (!confirm(`Remove ${p.email}? They won't be able to use the site until you add them again.`)) return;
        try { await peopleApi('DELETE', '?email=' + encodeURIComponent(p.email)); loadPeople(box); } catch (e) { alert(e.message); }
      };
      row.append(n, save, rm); list.append(row);
    });
    box.append(list);
  }
  function addAccountButton() {
    const bar = document.querySelector('.top .actions');
    if (!bar || document.getElementById('btn-account')) return;
    const b = document.createElement('button'); b.type = 'button'; b.id = 'btn-account'; b.textContent = 'Account';
    b.onclick = openAccount; bar.append(b);
  }

  // ---------- what the office page sees ----------
  let db;
  window.claude = {
    async use(name) {
      await ready;
      if (name === 'sample') return sample;
      if (name === 'db') return (db ||= makeDb());
      if (name === 'assets') return assets;
      if (name === 'downloads') return downloads;
      return null;
    },
  };
  ready.then(() => { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addAccountButton); else addAccountButton(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
