'use strict';
// Panel hosting Node.js - tanpa dependency (pakai modul bawaan Node 24)
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}
const PORT = +process.env.PORT || 3000;
const DOCKER = process.env.DOCKER === '1';            // DOCKER=1 -> isolasi + limit RAM/CPU asli
const MAX_USER_SERVERS = +process.env.MAX_USER_SERVERS || 3;
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data')), SRV = path.join(DATA, 'servers'), BK = path.join(DATA, 'backups');
fs.mkdirSync(SRV, { recursive: true }); fs.mkdirSync(BK, { recursive: true });

const db = new DatabaseSync(path.join(DATA, 'panel.db'));
db.exec(`
create table if not exists users(id integer primary key, username text unique, pass text, role text default 'user');
create table if not exists servers(id integer primary key, user_id integer, name text, ram integer, disk integer, startup text default 'node index.js', port integer);
`);

for (const [c, d] of [['image', "text default '24'"], ['env', "text default '{}'"], ['autorestart', 'integer default 0'], ['autostart', 'integer default 0']]) { try { db.exec(`alter table servers add column ${c} ${d}`); } catch {} }
db.exec('create table if not exists allocs(server_id integer, port integer unique)');

const hash = (p, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(p, salt, 64).toString('hex');
const verify = (p, h) => { const [s] = h.split(':'); const a = Buffer.from(hash(p, s)), b = Buffer.from(h); return a.length === b.length && crypto.timingSafeEqual(a, b); };

{
  const AU = process.env.ADMIN_USER, AP = process.env.ADMIN_PASS;
  if (AU && AP) {
    const ex = db.prepare('select id from users where username=?').get(AU);
    if (ex) { if (process.env.ADMIN_RESET === '1') db.prepare("update users set pass=?, role='admin' where id=?").run(hash(AP), ex.id); }
    else db.prepare('insert into users(username,pass,role) values(?,?,?)').run(AU, hash(AP), 'admin');
    console.log('Akun admin siap: ' + AU);
  } else if (!db.prepare("select 1 from users where role='admin'").get()) {
    if (process.env.GITHUB_ACTIONS) { console.error('ADMIN_USER / ADMIN_PASS belum di-set di GitHub Secrets. Berhenti.'); process.exit(1); }
    const p = crypto.randomBytes(6).toString('hex');
    db.prepare('insert into users(username,pass,role) values(?,?,?)').run('admin', hash(p), 'admin');
    console.log(`\n== ADMIN DIBUAT ==\nusername: admin\npassword: ${p}\n`);
  }
  delete process.env.ADMIN_PASS; // jangan bocor ke proses server user
}

const sessions = new Map();
const procs = new Map(); // serverId -> {p, log[], subs:Set, status}
const sdir = id => path.join(SRV, String(id));
const safe = (id, rel) => { const base = sdir(id), t = path.resolve(base, '.' + path.sep + (rel || '')); if (t !== base && !t.startsWith(base + path.sep)) throw new Error('path ilegal'); return t; };
const dirSize = d => { let n = 0; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); n += e.isDirectory() ? dirSize(f) : fs.statSync(f).size; } return n; };

const row = id => db.prepare('select * from servers where id=?').get(id);
const allocsOf = id => db.prepare('select port from allocs where server_id=? order by port').all(id).map(r => r.port);
const mdisk = new Map();
const usedOf = id => { const c = mdisk.get(id); if (c && Date.now() - c.t < 8000) return c.v; let v = 0; try { v = dirSize(sdir(id)); } catch {} mdisk.set(id, { t: Date.now(), v }); return v; };
const rssTree = pid => new Promise(ok => execFile('ps', ['-eo', 'pid=,ppid=,rss='], (er, out) => {
  if (er) return ok(0);
  const rows = String(out).trim().split('\n').map(l => l.trim().split(/\s+/).map(Number)), set = new Set([pid]);
  for (let ch = true; ch;) { ch = false; for (const [q, pp] of rows) if (!set.has(q) && set.has(pp)) { set.add(q); ch = true; } }
  ok(rows.filter(r => set.has(r[0])).reduce((t, r) => t + r[2], 0) * 1024);
}));
const dockerMem = id => new Promise(ok => execFile('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', 'panel-' + id], (er, o) => {
  const m = String(o).match(/([\d.]+)\s*(B|KiB|MiB|GiB)/); ok(m ? +m[1] * { B: 1, KiB: 1024, MiB: 1048576, GiB: 1073741824 }[m[2]] : 0);
}));

function entry(id) { if (!procs.has(id)) procs.set(id, { p: null, log: [], subs: new Set(), status: 'offline', startedAt: 0, stopping: false, crashes: [] }); return procs.get(id); }
function emit(e, line) { e.log.push(line); if (e.log.length > 500) e.log.shift(); for (const r of e.subs) r.write('data: ' + JSON.stringify(line) + '\n\n'); }

function launch(s, cmdline, main = false) {
  const e = entry(s.id);
  if (e.p) return false;
  fs.mkdirSync(sdir(s.id), { recursive: true });
  const parts = cmdline.trim().split(/\s+/);
  if (main && parts[0] === 'node' && parts[1] && !parts[1].startsWith('-') && !fs.existsSync(path.join(sdir(s.id), parts[1]))) {
    emit(e, `[panel] File "${parts[1]}" tidak ditemukan. Upload dulu di tab Files, atau ubah Startup command di tab Startup.`);
    return false;
  }
  let userEnv = {}; try { userEnv = JSON.parse(s.env || '{}'); } catch {}
  const extra = allocsOf(s.id);
  const base = { PORT: String(s.port), SERVER_PORT: String(s.port), ALLOC_PORTS: extra.join(','), NODE_ENV: 'production' };
  if (s.ram > 0) base.NODE_OPTIONS = `--max-old-space-size=${Math.max(64, Math.floor(s.ram * 0.9))}`;
  // env minimal: JANGAN teruskan env panel (rahasia admin) ke proses user
  const env = { PATH: process.env.PATH, HOME: sdir(s.id), LANG: 'C.UTF-8', ...userEnv, ...base };
  let cmd = parts[0], args = parts.slice(1), opt = { cwd: sdir(s.id), env };
  if (DOCKER) {
    const a = ['run', '--rm', '-i', '--init', '--name', 'panel-' + s.id, '--cpus', '1', '-v', sdir(s.id) + ':/home/container', '-w', '/home/container'];
    if (process.getuid) a.push('-u', `${process.getuid()}:${process.getgid()}`);
    a.push('-e', 'HOME=/home/container', '-e', 'npm_config_cache=/home/container/.npm');
    for (const pt of [s.port, ...extra]) a.push('-p', `${pt}:${pt}`);
    for (const [k, v] of Object.entries({ ...userEnv, ...base })) a.push('-e', `${k}=${v}`);
    if (s.ram > 0) a.push('-m', s.ram + 'm');
    a.push(`node:${s.image || '24'}-alpine`, ...parts);
    cmd = 'docker'; args = a; opt = {};
  }
  e.status = 'starting'; e.startedAt = Date.now(); e.stopping = false;
  emit(e, `[panel] menjalankan: ${cmdline}`);
  const p = spawn(cmd, args, { ...opt, stdio: ['pipe', 'pipe', 'pipe'] });
  e.p = p; e.status = 'running';
  p.stdin.on('error', () => {});
  const out = b => b.toString().split(/\r?\n/).filter(Boolean).forEach(l => emit(e, l));
  p.stdout.on('data', out); p.stderr.on('data', out);
  p.on('error', err => { emit(e, '[panel] error: ' + err.message); if (e.p === p) { e.p = null; e.status = 'offline'; } });
  p.on('close', c => {
    if (e.p !== p) return;
    emit(e, `[panel] proses berhenti (kode ${c})`); e.p = null; e.status = 'offline';
    const manual = e.stopping; e.stopping = false;
    const fresh = row(s.id);
    if (main && !manual && fresh && fresh.autorestart && c !== 0) {
      const now = Date.now(); e.crashes = e.crashes.filter(t => now - t < 60000); e.crashes.push(now);
      if (e.crashes.length > 5) return emit(e, '[panel] crash terus-menerus, auto-restart dihentikan');
      emit(e, '[panel] crash terdeteksi, auto-restart 3 detik lagi...');
      setTimeout(() => { const f = row(s.id); if (f && !e.p) launch(f, f.startup, true); }, 3000);
    }
  });
  return true;
}
function stop(s, force) {
  const e = entry(s.id); if (!e.p) return;
  e.stopping = true;
  if (DOCKER) execFile('docker', [force ? 'kill' : 'stop', '-t', '10', 'panel-' + s.id], () => {});
  else e.p.kill(force ? 'SIGKILL' : 'SIGTERM');
}

// ---- reverse proxy: /s/<id>/... atau s<id>.<PUBLIC_DOMAIN>
function matchProxy(req) {
  const host = (req.headers.host || '').split(':')[0], PD = process.env.PUBLIC_DOMAIN;
  let id, rest, mm;
  if (PD && host.endsWith('.' + PD) && (mm = host.slice(0, -PD.length - 1).match(/^s(\d+)$/))) { id = +mm[1]; rest = req.url; }
  else if ((mm = req.url.match(/^\/s\/(\d+)$/))) return { redirect: req.url + '/' };
  else if ((mm = req.url.match(/^\/s\/(\d+)(\/.*|\?.*)$/))) { id = +mm[1]; rest = mm[2][0] === '?' ? '/' + mm[2] : mm[2]; }
  if (id === undefined) return null;
  const s = row(id);
  return { id, rest, port: s ? s.port : 0 };
}
function rawHeaders(req, port) {
  const h = {};
  for (let i = 0; i < req.rawHeaders.length; i += 2) h[req.rawHeaders[i]] = req.rawHeaders[i + 1];
  for (const k of Object.keys(h)) if (k.toLowerCase() === 'host') h[k] = '127.0.0.1:' + port;
  h['X-Forwarded-For'] = req.socket.remoteAddress; h['X-Forwarded-Proto'] = req.headers['x-forwarded-proto'] || 'http';
  return h;
}
function doProxy(req, res, px) {
  if (px.redirect) { res.writeHead(301, { Location: px.redirect }); return res.end(); }
  if (!px.port) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Server tidak ada'); }
  if (!entry(px.id).p) { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Server sedang offline. Start dulu dari panel.'); }
  const pr = http.request({ host: '127.0.0.1', port: px.port, path: px.rest, method: req.method, headers: rawHeaders(req, px.port) }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  pr.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Aplikasi tidak merespons di port ' + px.port); });
  req.pipe(pr);
}

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((ok, no) => { let b = '', n = 0; req.on('data', c => { n += c.length; if (n > 6e6) { no(new Error('terlalu besar')); req.destroy(); } else b += c; }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { no(new Error('JSON salah')); } }); });
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split('=')).filter(x => x[0]));
const MAX_UPLOAD = (+process.env.MAX_UPLOAD_MB || 500) * 1048576;
const has = (c, a) => new Promise(ok => execFile(c, a, { timeout: 4000 }, er => ok(!er || er.code !== 'ENOENT')));
const run = (c, a) => new Promise((ok, no) => execFile(c, a, { timeout: 180000, maxBuffer: 1e7 }, (e, so, se) => e ? no(new Error(String(se || e.message).slice(0, 200))) : ok()));
const pub = s => ({ ...s, status: entry(s.id).status });

const server = http.createServer(async (req, res) => {
  try {
    const px = matchProxy(req); if (px) return doProxy(req, res, px);
    const url = new URL(req.url, 'http://x'), m = req.method, p = url.pathname;
    if (m === 'GET' && (p === '/' || p === '/index.html')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html'))); }
    if (!p.startsWith('/api/')) return send(res, 404, { error: 'not found' });

    const sid = cookie(req).sid, uid = sessions.get(sid);
    const isUp = /\/upload$/.test(p);
    const body = (!isUp && (m === 'POST' || m === 'PUT')) ? await readBody(req) : {};

    if (p === '/api/login' && m === 'POST') {
      const u = db.prepare('select * from users where username=?').get(String(body.username || ''));
      if (!u || !verify(String(body.password || ''), u.pass)) return send(res, 401, { error: 'login salah' });
      const t = crypto.randomBytes(24).toString('hex'); sessions.set(t, u.id);
      res.setHeader('Set-Cookie', `sid=${t}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`);
      return send(res, 200, { ok: 1 });
    }
    if (p === '/api/register' && m === 'POST') {
      const un = String(body.username || '').trim(), pw = String(body.password || '');
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(un) || pw.length < 6) return send(res, 400, { error: 'username 3-20 huruf/angka, password min 6' });
      try { db.prepare('insert into users(username,pass) values(?,?)').run(un, hash(pw)); } catch { return send(res, 400, { error: 'username sudah ada' }); }
      return send(res, 200, { ok: 1 });
    }
    const me = uid && db.prepare('select id,username,role from users where id=?').get(uid);
    if (!me) return send(res, 401, { error: 'belum login' });
    const admin = me.role === 'admin';

    if (p === '/api/logout') { sessions.delete(sid); return send(res, 200, { ok: 1 }); }
    if (p === '/api/me') return send(res, 200, me);

    if (p === '/api/password' && m === 'POST') {
      const u = db.prepare('select * from users where id=?').get(me.id), np = String(body.new || '');
      if (!verify(String(body.old || ''), u.pass)) return send(res, 400, { error: 'password lama salah' });
      if (np.length < 6) return send(res, 400, { error: 'password baru min 6 karakter' });
      db.prepare('update users set pass=? where id=?').run(hash(np), me.id); return send(res, 200, { ok: 1 });
    }
    if (p === '/api/health') {
      if (!admin) return send(res, 403, { error: 'admin only' });
      const [tar, unzip, docker] = await Promise.all([has('tar', ['--version']), has('unzip', ['-v']), has('docker', ['--version'])]);
      let writable = true, err = ''; try { const t = path.join(SRV, '.w'); fs.writeFileSync(t, 'x'); fs.rmSync(t); } catch (e) { writable = false; err = e.message; }
      return send(res, 200, { node: process.version, platform: process.platform, arch: process.arch, docker: DOCKER, tools: { tar, unzip, docker }, cloudflared: fs.existsSync(process.env.CLOUDFLARED_BIN || path.join(__dirname, 'cloudflared')), tunnel: tunnelUrl, data: DATA, writable, err, memory: process.memoryUsage().rss, running: [...procs.values()].filter(x => x.p).length });
    }
    // ---- admin: user
    if (p === '/api/users') {
      if (!admin) return send(res, 403, { error: 'admin only' });
      if (m === 'GET') return send(res, 200, db.prepare('select id,username,role from users').all());
      if (m === 'POST') {
        const un = String(body.username || '').trim(), pw = String(body.password || '');
        if (!/^[a-zA-Z0-9_]{3,20}$/.test(un) || pw.length < 6) return send(res, 400, { error: 'data tidak valid' });
        try { db.prepare('insert into users(username,pass,role) values(?,?,?)').run(un, hash(pw), body.role === 'admin' ? 'admin' : 'user'); } catch { return send(res, 400, { error: 'username sudah ada' }); }
        return send(res, 200, { ok: 1 });
      }
    }
    let mm = p.match(/^\/api\/users\/(\d+)$/);
    if (mm && m === 'PUT') {
      if (!admin) return send(res, 403, { error: 'admin only' });
      const np = String(body.password || ''); if (np.length < 6) return send(res, 400, { error: 'password min 6 karakter' });
      db.prepare('update users set pass=? where id=?').run(hash(np), +mm[1]); return send(res, 200, { ok: 1 });
    }
    if (mm && m === 'DELETE') {
      if (!admin) return send(res, 403, { error: 'admin only' });
      const id = +mm[1]; if (id === me.id) return send(res, 400, { error: 'tidak bisa hapus diri sendiri' });
      for (const s of db.prepare('select * from servers where user_id=?').all(id)) { stop(s, true); fs.rmSync(sdir(s.id), { recursive: true, force: true }); fs.rmSync(path.join(BK, String(s.id)), { recursive: true, force: true }); }
      db.prepare('delete from allocs where server_id in (select id from servers where user_id=?)').run(id); db.prepare('delete from servers where user_id=?').run(id); db.prepare('delete from users where id=?').run(id);
      return send(res, 200, { ok: 1 });
    }

    // ---- server list / create
    if (p === '/api/servers') {
      if (m === 'GET') return send(res, 200, (admin ? db.prepare('select s.*,u.username owner from servers s left join users u on u.id=s.user_id').all() : db.prepare('select s.*,? owner from servers s where user_id=?').all(me.username, me.id)).map(pub));
      if (m === 'POST') {
        const name = String(body.name || '').trim().slice(0, 40), ram = Math.floor(+body.ram);
        if (!name) return send(res, 400, { error: 'nama kosong' });
        if (!(ram === 0 || (ram >= 1024 && ram <= 10240))) return send(res, 400, { error: 'RAM 1024-10240 MB atau 0 (unlimited)' });
        if (ram === 0 && !admin) return send(res, 403, { error: 'unlimited hanya admin' });
        let owner = me.id;
        if (admin && body.user_id) owner = +body.user_id;
        if (!admin && db.prepare('select count(*) c from servers where user_id=?').get(me.id).c >= MAX_USER_SERVERS) return send(res, 403, { error: `maks ${MAX_USER_SERVERS} server` });
        const r = db.prepare('insert into servers(user_id,name,ram,disk,port) values(?,?,?,?,0)').run(owner, name, ram, ram === 0 ? 0 : ram * 2);
        const id = Number(r.lastInsertRowid); db.prepare('update servers set port=? where id=?').run(25000 + id, id);
        const d = sdir(id); fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'index.js'), "const http=require('http');\nconst port=process.env.PORT||3000;\nhttp.createServer((q,r)=>r.end('Server Node.js jalan!')).listen(port,()=>console.log('Listening di port '+port));\n");
        fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', main: 'index.js', scripts: { start: 'node index.js' } }, null, 2));
        return send(res, 200, { id });
      }
    }

    // ---- per-server
    mm = p.match(/^\/api\/servers\/(\d+)(?:\/(\w+))?$/);
    if (mm) {
      const s = db.prepare('select * from servers where id=?').get(+mm[1]);
      if (!s || (!admin && s.user_id !== me.id)) return send(res, 404, { error: 'server tidak ditemukan' });
      const act = mm[2], e = entry(s.id);
      if (!act && m === 'DELETE') { stop(s, true); db.prepare('delete from servers where id=?').run(s.id); db.prepare('delete from allocs where server_id=?').run(s.id); fs.rmSync(path.join(BK, String(s.id)), { recursive: true, force: true }); setTimeout(() => fs.rmSync(sdir(s.id), { recursive: true, force: true }), 1500); return send(res, 200, { ok: 1 }); }
      if (!act && m === 'PUT') {
        const u = {};
        if ('startup' in body) { const st = String(body.startup).trim(); if (!st || st.length > 200 || /[\r\n]/.test(st)) return send(res, 400, { error: 'startup tidak valid' }); u.startup = st; }
        if ('name' in body) { const nm = String(body.name).trim().slice(0, 40); if (!nm) return send(res, 400, { error: 'nama kosong' }); u.name = nm; }
        if ('image' in body) { if (!['24', '22', '20', '18'].includes(String(body.image))) return send(res, 400, { error: 'versi node tidak valid' }); u.image = String(body.image); }
        if ('autorestart' in body) u.autorestart = body.autorestart ? 1 : 0;
        if ('env' in body) {
          const ent = Object.entries(body.env || {});
          if (ent.length > 30) return send(res, 400, { error: 'maks 30 variabel' });
          const o = {}; for (const [k, v] of ent) { if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(k) || /^(PORT|SERVER_PORT|ALLOC_PORTS|PATH|HOME|NODE_OPTIONS)$/i.test(k)) return send(res, 400, { error: 'nama variabel tidak valid: ' + k }); o[k] = String(v).slice(0, 500); }
          u.env = JSON.stringify(o);
        }
        if ('ram' in body) {
          if (!admin) return send(res, 403, { error: 'hanya admin yang bisa ubah RAM' });
          const r = Math.floor(+body.ram); if (!(r === 0 || (r >= 1024 && r <= 10240))) return send(res, 400, { error: 'RAM tidak valid' });
          u.ram = r; u.disk = r === 0 ? 0 : r * 2;
        }
        const ks = Object.keys(u); if (!ks.length) return send(res, 400, { error: 'tidak ada perubahan' });
        db.prepare(`update servers set ${ks.map(k => k + '=?').join(',')} where id=?`).run(...ks.map(k => u[k]), s.id);
        return send(res, 200, { ok: 1 });
      }
      if (!act && m === 'GET') {
        let mem = 0; if (e.p) mem = DOCKER ? await dockerMem(s.id) : await rssTree(e.p.pid);
        let env = {}; try { env = JSON.parse(s.env || '{}'); } catch {}
        return send(res, 200, { ...pub(s), env, autorestart: !!s.autorestart, image: s.image || '24', used: usedOf(s.id), mem, uptime: e.p ? Date.now() - e.startedAt : 0, allocs: allocsOf(s.id), docker: DOCKER });
      }
      if (act === 'alloc' && m === 'POST') {
        const a = body.action, port = Math.floor(+body.port);
        if (a === 'add') {
          if (!admin && allocsOf(s.id).length >= 4) return send(res, 403, { error: 'maks 5 port per server' });
          const used = new Set([...db.prepare('select port from servers').all(), ...db.prepare('select port from allocs').all()].map(r => r.port));
          let np = 25000; while (used.has(np) && np < 29999) np++;
          if (used.has(np)) return send(res, 400, { error: 'port habis' });
          db.prepare('insert into allocs(server_id,port) values(?,?)').run(s.id, np); return send(res, 200, { port: np });
        }
        if (a === 'del') { db.prepare('delete from allocs where server_id=? and port=?').run(s.id, port); return send(res, 200, { ok: 1 }); }
        if (a === 'primary') {
          if (e.p) return send(res, 400, { error: 'stop server dulu' });
          if (!db.prepare('select 1 from allocs where server_id=? and port=?').get(s.id, port)) return send(res, 400, { error: 'port tidak ada' });
          db.prepare('delete from allocs where server_id=? and port=?').run(s.id, port);
          db.prepare('insert into allocs(server_id,port) values(?,?)').run(s.id, s.port);
          db.prepare('update servers set port=? where id=?').run(port, s.id); return send(res, 200, { ok: 1 });
        }
        return send(res, 400, { error: 'aksi salah' });
      }
      if (act === 'power' && m === 'POST') {
        const a = body.action;
        if (a === 'start') { if (launch(s, s.startup, true)) db.prepare('update servers set autostart=1 where id=?').run(s.id); }
        else if (a === 'stop') { db.prepare('update servers set autostart=0 where id=?').run(s.id); stop(s, false); }
        else if (a === 'kill') { db.prepare('update servers set autostart=0 where id=?').run(s.id); stop(s, true); }
        else if (a === 'restart') { stop(s, false); const t0 = Date.now(), t = setInterval(() => { if (!e.p) { clearInterval(t); const f = row(s.id); if (f) launch(f, f.startup, true); } else if (Date.now() - t0 > 20000) { clearInterval(t); stop(s, true); } }, 300); }
        else if (a === 'install') launch(s, 'npm install');
        else return send(res, 400, { error: 'aksi salah' });
        return send(res, 200, { ok: 1 });
      }
      if (act === 'command' && m === 'POST') { if (e.p) e.p.stdin.write(String(body.command || '') + '\n'); return send(res, 200, { ok: 1 }); }
      if (act === 'console') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        for (const l of e.log) res.write('data: ' + JSON.stringify(l) + '\n\n');
        e.subs.add(res); req.on('close', () => e.subs.delete(res)); return;
      }
      const base = sdir(s.id);
      const diskFull = extra => s.disk > 0 && dirSize(base) + extra > s.disk * 1048576;
      if (act === 'files') {
        const d = safe(s.id, url.searchParams.get('path'));
        return send(res, 200, fs.readdirSync(d, { withFileTypes: true }).map(x => { const st = fs.statSync(path.join(d, x.name)); return { name: x.name, dir: x.isDirectory(), size: x.isDirectory() ? 0 : st.size, mtime: st.mtimeMs }; }));
      }
      if (act === 'mkdir' && m === 'POST') { const f = safe(s.id, body.path); if (f === base) return send(res, 400, { error: 'nama kosong' }); fs.mkdirSync(f, { recursive: true }); return send(res, 200, { ok: 1 }); }
      if (act === 'rename' && m === 'POST') {
        const a = safe(s.id, body.from), b = safe(s.id, body.to);
        if (a === base || b === base) return send(res, 400, { error: 'path ilegal' });
        if (fs.existsSync(b)) return send(res, 400, { error: 'nama sudah dipakai' });
        fs.mkdirSync(path.dirname(b), { recursive: true }); fs.renameSync(a, b); return send(res, 200, { ok: 1 });
      }
      if (act === 'delete' && m === 'POST') { for (const x of body.paths || []) { const f = safe(s.id, x); if (f !== base) fs.rmSync(f, { recursive: true, force: true }); } return send(res, 200, { ok: 1 }); }
      if (act === 'upload' && m === 'POST') {
        const f = safe(s.id, url.searchParams.get('path')), off = Math.max(0, Math.floor(+url.searchParams.get('offset') || 0));
        const bail = (c, msg) => { req.resume(); return send(res, c, { error: msg }); };
        if (f === base) return bail(400, 'nama file kosong');
        const len = +req.headers['content-length'] || 0;
        if (off + len > MAX_UPLOAD) return bail(413, 'file terlalu besar (maks ' + Math.floor(MAX_UPLOAD / 1048576) + ' MB)');
        if (diskFull(len)) return bail(400, 'disk server penuh');
        fs.mkdirSync(path.dirname(f), { recursive: true });
        if (off > 0) { // lanjutan chunk: file harus sudah ada; retry chunk yang sama aman (dipotong ke offset)
          const have = fs.existsSync(f) ? fs.statSync(f).size : -1;
          if (have < off) return bail(409, 'urutan chunk salah, ulangi upload dari awal');
          if (have > off) fs.truncateSync(f, off);
        }
        const ws = fs.createWriteStream(f, { flags: off === 0 ? 'w' : 'a' });
        let n = 0, dead = false;
        const fail = (c, msg) => { if (dead) return; dead = true; req.unpipe(ws); ws.destroy(); send(res, c, { error: msg }); req.resume(); };
        req.on('data', c => { n += c.length; if (off + n > MAX_UPLOAD) fail(413, 'file terlalu besar'); });
        ws.on('error', e => fail(500, e.message));
        ws.on('finish', () => { if (!dead) { mdisk.delete(s.id); send(res, 200, { ok: 1, size: off + n }); } });
        req.pipe(ws); return;
      }
      if (act === 'download' && m === 'GET') {
        const f = safe(s.id, url.searchParams.get('path')), st = fs.statSync(f), nm = encodeURIComponent(path.basename(f) || 'server');
        if (st.isDirectory()) {
          res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${nm}.tar.gz"` });
          const t = spawn('tar', ['-czf', '-', '-C', f, '.']); t.stdout.pipe(res); t.on('error', () => res.end()); return;
        }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Content-Disposition': `attachment; filename="${nm}"` });
        return fs.createReadStream(f).pipe(res);
      }
      const BKRE = /^backup-[\w.-]+\.tar\.gz$/, bkd = path.join(BK, String(s.id));
      if (act === 'backups' && m === 'GET') {
        fs.mkdirSync(bkd, { recursive: true });
        return send(res, 200, fs.readdirSync(bkd).filter(n => BKRE.test(n)).map(n => { const st = fs.statSync(path.join(bkd, n)); return { name: n, size: st.size, mtime: st.mtimeMs }; }).sort((x, y) => y.mtime - x.mtime));
      }
      if (act === 'backupdl' && m === 'GET') {
        const n = String(url.searchParams.get('name') || ''); if (!BKRE.test(n)) return send(res, 400, { error: 'nama salah' });
        const f = path.join(bkd, n), st = fs.statSync(f);
        res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': st.size, 'Content-Disposition': `attachment; filename="${n}"` });
        return fs.createReadStream(f).pipe(res);
      }
      if (act === 'backup' && m === 'POST') {
        fs.mkdirSync(bkd, { recursive: true });
        const a = body.action, n = String(body.name || '');
        if (a === 'create') {
          if (fs.readdirSync(bkd).length >= (admin ? 10 : 3)) return send(res, 400, { error: 'batas backup tercapai, hapus yang lama dulu' });
          const nm = 'backup-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.tar.gz';
          await run('tar', ['-czf', path.join(bkd, nm), '-C', base, '.']); return send(res, 200, { ok: 1, name: nm });
        }
        if (!BKRE.test(n)) return send(res, 400, { error: 'nama salah' });
        const f = path.join(bkd, n);
        if (a === 'delete') { fs.rmSync(f, { force: true }); return send(res, 200, { ok: 1 }); }
        if (a === 'restore') {
          if (e.p) return send(res, 400, { error: 'stop server dulu' });
          if (!fs.existsSync(f)) return send(res, 404, { error: 'backup tidak ada' });
          for (const x of fs.readdirSync(base)) fs.rmSync(path.join(base, x), { recursive: true, force: true });
          await run('tar', ['-xzf', f, '-C', base]); mdisk.delete(s.id); return send(res, 200, { ok: 1 });
        }
        return send(res, 400, { error: 'aksi salah' });
      }
      if (act === 'compress' && m === 'POST') {
        const dir = safe(s.id, body.dir), names = (body.names || []).map(n => path.basename(String(n))).filter(Boolean);
        if (!names.length) return send(res, 400, { error: 'pilih file dulu' });
        const out = 'archive-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.tar.gz';
        await run('tar', ['-czf', path.join(dir, out), '-C', dir, ...names]);
        return send(res, 200, { ok: 1, file: out });
      }
      if (act === 'decompress' && m === 'POST') {
        const f = safe(s.id, body.path), dir = path.dirname(f);
        if (/\.(tar\.gz|tgz)$/i.test(f)) await run('tar', ['-xzf', f, '-C', dir]);
        else if (/\.tar$/i.test(f)) await run('tar', ['-xf', f, '-C', dir]);
        else if (/\.zip$/i.test(f)) await run('unzip', ['-o', f, '-d', dir]);
        else return send(res, 400, { error: 'format tidak didukung (.zip .tar .tar.gz .tgz)' });
        if (s.disk > 0 && dirSize(base) > s.disk * 1048576) return send(res, 400, { error: 'hasil extract melebihi limit disk, hapus file' });
        return send(res, 200, { ok: 1 });
      }
      if (act === 'file') {
        if (m === 'GET') { const f = safe(s.id, url.searchParams.get('path')); if (fs.statSync(f).size > 2e6) return send(res, 400, { error: 'file > 2MB' }); return send(res, 200, { content: fs.readFileSync(f, 'utf8') }); }
        if (m === 'PUT') {
          const f = safe(s.id, body.path), c = String(body.content ?? '');
          if (s.disk > 0 && dirSize(sdir(s.id)) + Buffer.byteLength(c) > s.disk * 1048576) return send(res, 400, { error: 'disk penuh' });
          fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); return send(res, 200, { ok: 1 });
        }
        if (m === 'DELETE') { const f = safe(s.id, url.searchParams.get('path')); if (f === sdir(s.id)) return send(res, 400, { error: 'ilegal' }); fs.rmSync(f, { recursive: true, force: true }); return send(res, 200, { ok: 1 }); }
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (err) { send(res, 500, { error: err.message }); }
});
server.on('upgrade', (req, sock, head) => {
  const px = matchProxy(req);
  if (!px || px.redirect || !px.port || !entry(px.id).p) return sock.destroy();
  const c = require('node:net').connect(px.port, '127.0.0.1', () => {
    const h = rawHeaders(req, px.port);
    c.write(`${req.method} ${px.rest} HTTP/1.1\r\n` + Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
    if (head.length) c.write(head);
    sock.pipe(c).pipe(sock);
  });
  c.on('error', () => sock.destroy()); sock.on('error', () => c.destroy());
});
// ---- Cloudflare quick tunnel otomatis (URL trycloudflare dicetak di console)
let tunnelProc = null, tunnelUrl = '';
async function announce(url) {
  const sum = process.env.GITHUB_STEP_SUMMARY;
  if (sum) { try { fs.appendFileSync(sum, `## Panel online\n${url}\n`); } catch {} }
  const repo = process.env.GITHUB_REPOSITORY, tok = process.env.GH_TOKEN;
  if (!process.env.GITHUB_ACTIONS || !repo || !tok) return;
  const H = { Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json', 'User-Agent': 'node-panel', 'Content-Type': 'application/json' }, api = `https://api.github.com/repos/${repo}`;
  try {
    const list = await (await fetch(`${api}/issues?state=open&per_page=100`, { headers: H })).json();
    let num = Array.isArray(list) && (list.find(i => i.title === 'Panel URL' && !i.pull_request) || {}).number;
    if (!num) { const r = await (await fetch(`${api}/issues`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'Panel URL', body: 'Setiap panel (re)start, URL terbaru dikirim sebagai komentar di sini.' }) })).json(); num = r.number; }
    if (!num) throw new Error('issue gagal dibuat (cek permission issues: write)');
    await fetch(`${api}/issues/${num}/comments`, { method: 'POST', headers: H, body: JSON.stringify({ body: `Panel online: ${url}\n\nRun #${process.env.GITHUB_RUN_NUMBER || '?'}` }) });
    console.log('[tunnel] URL dikirim ke GitHub Issue #' + num);
  } catch (e) { console.log('[tunnel] gagal kirim URL ke GitHub: ' + e.message); }
}
async function startTunnel() {
  if (process.env.TUNNEL === '0') return;
  const bin = process.env.CLOUDFLARED_BIN || path.join(__dirname, 'cloudflared');
  if (!fs.existsSync(bin)) {
    const arch = { x64: 'amd64', arm64: 'arm64', arm: 'arm' }[process.arch];
    if (!arch || process.platform !== 'linux') return console.log('[tunnel] OS/arsitektur tidak didukung, pasang cloudflared manual lalu set CLOUDFLARED_BIN');
    console.log('[tunnel] mengunduh cloudflared (sekali saja, +-40MB)...');
    try {
      const r = await fetch(`https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 1e6) throw new Error('file unduhan tidak valid');
      fs.writeFileSync(bin, buf, { mode: 0o755 });
    } catch (e) { return console.log('[tunnel] GAGAL download cloudflared: ' + e.message + '\n[tunnel] kemungkinan hosting memblokir internet keluar / github. Upload file cloudflared manual ke folder panel.'); }
  }
  const run = () => {
    const c = tunnelProc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:' + PORT], { stdio: ['ignore', 'pipe', 'pipe'] });
    let shown = false;
    const on = b => { for (const l of b.toString().split('\n')) {
      const m = l.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !shown) { shown = true; tunnelUrl = m[0]; announce(m[0]); console.log('\n==============================================\n URL PANEL: ' + m[0] + '\n==============================================\n'); }
      else if (/\b(ERR|error|failed)\b/i.test(l)) console.log('[tunnel] ' + l.trim().slice(0, 200));
    } };
    c.stdout.on('data', on); c.stderr.on('data', on);
    c.on('error', e => console.log('[tunnel] ' + e.message));
    c.on('close', code => { tunnelUrl = ''; console.log('[tunnel] berhenti (kode ' + code + '), mulai ulang 5 detik... (URL baru akan muncul)'); setTimeout(run, 5000); });
  };
  run();
}
process.on('exit', () => { if (tunnelProc) tunnelProc.kill(); });
function shutdown() {
  console.log('[panel] shutdown, menghentikan server user...');
  for (const [id, e] of procs) if (e.p) { try { if (DOCKER) require('node:child_process').execFileSync('docker', ['stop', '-t', '5', 'panel-' + id], { timeout: 15000 }); else e.p.kill('SIGTERM'); } catch {} }
  process.exit(0);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
server.listen(PORT, () => {
  console.log('Panel jalan di port ' + PORT); startTunnel();
  let d = 1500; for (const sv of db.prepare('select * from servers where autostart=1').all()) { setTimeout(() => { const f = row(sv.id); if (f) launch(f, f.startup, true); }, d); d += 800; }
});
