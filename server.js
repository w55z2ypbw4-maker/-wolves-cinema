// غرفة مشاهدة مشتركة - بدون أي مكتبات خارجية، فقط Node.js
// التشغيل: node server.js  ثم افتح http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC = __dirname;
const ROOM_RE = /^[\w-]{1,32}$/;
const rooms = new Map();

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function getRoom(id) {
  if (!rooms.has(id)) {
    rooms.set(id, {
      state: { url: '', file: '', playing: false, time: 0, at: Date.now() },
      clients: new Map(),
      chat: [],
      timer: null,
    });
  }
  return rooms.get(id);
}

function snapshot(room) {
  const s = room.state;
  const time = s.playing ? s.time + (Date.now() - s.at) / 1000 : s.time;
  return { url: s.url, file: s.file, playing: s.playing, time };
}

const usersOf = (room) => [...room.clients.values()].map((c) => c.name);

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(room, event, data) {
  for (const c of room.clients.values()) send(c.res, event, data);
}

function pushChat(room, msg) {
  msg.at = Date.now();
  room.chat.push(msg);
  if (room.chat.length > 100) room.chat.shift();
  broadcast(room, 'chat', msg);
}

function stream(req, res, u) {
  const id = u.searchParams.get('room') || '';
  const cid = (u.searchParams.get('cid') || '').slice(0, 16);
  const name = (u.searchParams.get('name') || 'ضيف').slice(0, 24);
  if (!ROOM_RE.test(id) || !cid) {
    res.writeHead(400).end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const room = getRoom(id);
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
  const isNew = !room.clients.has(cid);
  room.clients.set(cid, { res, name });
  send(res, 'init', { state: snapshot(room), users: usersOf(room), chat: room.chat });
  broadcast(room, 'users', usersOf(room));
  if (isNew) pushChat(room, { sys: true, text: `${name} دخل الغرفة` });

  const hb = setInterval(() => res.write(': hb\n\n'), 20000);
  req.on('close', () => {
    clearInterval(hb);
    const cur = room.clients.get(cid);
    if (!cur || cur.res !== res) return; // المستخدم أعاد الاتصال
    room.clients.delete(cid);
    broadcast(room, 'users', usersOf(room));
    pushChat(room, { sys: true, text: `${name} طلع من الغرفة` });
    if (!room.clients.size) {
      room.timer = setTimeout(() => {
        if (!room.clients.size) rooms.delete(id);
      }, 10 * 60 * 1000);
    }
  });
}

function onEvent(req, res, u) {
  const id = u.searchParams.get('room') || '';
  const cid = (u.searchParams.get('cid') || '').slice(0, 16);
  const room = rooms.get(id);
  const me = room && room.clients.get(cid);
  if (!me) {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (d) => {
    body += d;
    if (body.length > 10000) req.destroy();
  });
  req.on('end', () => {
    let m;
    try {
      m = JSON.parse(body);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const s = room.state;
    const t = Number(m.time);
    const time = Number.isFinite(t) && t >= 0 ? t : 0;
    switch (m.type) {
      case 'play':
        Object.assign(s, { playing: true, time, at: Date.now() });
        break;
      case 'pause':
        Object.assign(s, { playing: false, time, at: Date.now() });
        break;
      case 'seek':
        Object.assign(s, { time, at: Date.now() });
        break;
      case 'load':
        if (m.file) {
          s.url = '';
          s.file = String(m.file).slice(0, 200);
        } else if (typeof m.url === 'string' && /^https?:\/\//i.test(m.url) && m.url.length < 2000) {
          s.url = m.url;
          s.file = '';
        } else {
          res.writeHead(400).end();
          return;
        }
        Object.assign(s, { playing: false, time: 0, at: Date.now() });
        break;
      case 'chat': {
        const text = String(m.text || '').trim().slice(0, 500);
        if (text) pushChat(room, { name: me.name, text });
        res.writeHead(204).end();
        return;
      }
      default:
        res.writeHead(400).end();
        return;
    }
    broadcast(room, 'state', { state: snapshot(room), by: cid, kind: m.type });
    res.writeHead(204).end();
  });
}

function serveStatic(req, res, pathname) {
  let p;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (p === '/') p = '/index.html';
  if (p !== '/index.html') {
    res.writeHead(404).end('Not found');
    return;
  }
  const file = path.join(PUBLIC, p);
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

http
  .createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/api/stream' && req.method === 'GET') return stream(req, res, u);
    if (u.pathname === '/api/event' && req.method === 'POST') return onEvent(req, res, u);
    if (req.method === 'GET') return serveStatic(req, res, u.pathname);
    res.writeHead(405).end();
  })
  .listen(PORT, () => console.log(`شغّال على http://localhost:${PORT}`));
