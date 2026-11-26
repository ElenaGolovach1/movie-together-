// Сервер «Вдвоём»: раздаёт сайт и синхронизирует комнаты по WebSocket.
// Без внешних библиотек — ничего устанавливать не нужно, достаточно Node.js.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MAX_PEOPLE = 2;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
};

// shortcut: комнаты хранятся в памяти — при перезапуске сервера пропадают; для двоих этого достаточно
const rooms = new Map();
const clients = new Set();

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');

  if (pathname === '/config') {
    // TURN-сервер нужен, если голос не соединяется (мобильный интернет у обоих). Задаётся переменными TURN_URL/TURN_USER/TURN_PASS.
    const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    if (process.env.TURN_URL) {
      iceServers.push({ urls: process.env.TURN_URL.split(','), username: process.env.TURN_USER, credential: process.env.TURN_PASS });
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ iceServers }));
  }

  const file = pathname === '/' || pathname.startsWith('/r/') ? '/index.html' : pathname;
  const full = path.join(PUBLIC, path.normalize(file));
  if (!full.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Не найдено'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------- минимальный WebSocket (RFC 6455) ----------
function frame(op, data) {
  const p = Buffer.from(data), n = p.length;
  let h;
  if (n < 126) h = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, p]);
}
const send = (c, obj) => { if (c.socket.writable) c.socket.write(frame(1, JSON.stringify(obj))); };

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (new URL(req.url, 'http://x').pathname !== '/ws' || !key) return socket.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');

  const c = { socket, sid: crypto.randomBytes(6).toString('hex'), alive: true, room: null, cid: '', name: '', mic: false };
  clients.add(c);
  let buf = Buffer.alloc(0);
  let parts = [];

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 15, masked = buf[1] & 0x80;
      let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (!masked || len > 65536) return socket.destroy();
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op === 8) return socket.end();
      if (op === 9) { socket.write(frame(10, payload)); continue; }
      if (op === 10) { c.alive = true; continue; }
      parts.push(payload);
      if (parts.length > 16) return socket.destroy();
      if (fin) { const text = Buffer.concat(parts).toString(); parts = []; handle(c, text); }
    }
  });
  const gone = () => { clients.delete(c); leave(c); };
  socket.on('close', gone);
  socket.on('error', () => socket.destroy());
});

// ---------- логика комнат ----------
const snapshot = (room) => {
  const s = room.state;
  return { playing: s.playing, pos: s.playing ? s.time + (Date.now() - s.at) / 1000 : s.time };
};
const broadcast = (room, obj, except) => room.members.forEach((m) => { if (m !== except) send(m, obj); });
const broadcastPeers = (room) => broadcast(room, {
  type: 'peers', peers: [...room.members.values()].map((m) => ({ sid: m.sid, name: m.name, mic: m.mic })),
});

function leave(c) {
  const room = c.room;
  if (!room) return;
  c.room = null;
  room.members.delete(c.sid);
  if (room.members.size) broadcastPeers(room); else room.emptySince = Date.now();
}

function join(c, m) {
  if (c.room) return;
  const id = String(m.room || '');
  if (!/^[a-z0-9]{4,32}$/.test(id)) return send(c, { type: 'error', text: 'Некорректная ссылка комнаты' });
  let room = rooms.get(id);
  if (!room) {
    room = { members: new Map(), chat: [], emptySince: null, state: { url: null, playing: false, time: 0, at: Date.now() } };
    rooms.set(id, room);
  }
  const cid = String(m.cid || '').slice(0, 40);
  // то же устройство зашло снова (обновили страницу, пропал интернет) — старое «зависшее» соединение заменяем
  for (const old of [...room.members.values()]) {
    if (old.cid === cid) { room.members.delete(old.sid); old.room = null; old.socket.end(); }
  }
  if (room.members.size >= MAX_PEOPLE) { send(c, { type: 'full' }); return c.socket.end(); }
  Object.assign(c, { room, cid, name: String(m.name || 'Гость').trim().slice(0, 24) || 'Гость', mic: false });
  room.members.set(c.sid, c);
  room.emptySince = null;
  send(c, { type: 'joined', sid: c.sid, video: room.state.url, ...snapshot(room), chat: room.chat });
  broadcastPeers(room);
}

function handle(c, text) {
  let m;
  try { m = JSON.parse(text); } catch { return; }
  if (m.type === 'join') return join(c, m);
  const room = c.room;
  if (!room) return;
  const s = room.state;

  switch (m.type) {
    case 'play': case 'pause': case 'seek': {
      const t = Number(m.time);
      if (!Number.isFinite(t) || t < 0) return;
      s.time = t; s.at = Date.now();
      if (m.type !== 'seek') s.playing = m.type === 'play';
      broadcast(room, { type: 'state', ...snapshot(room) }, c);
      break;
    }
    case 'video': {
      const url = String(m.url || '').slice(0, 2000);
      if (!/^https?:\/\/\S+$/i.test(url)) return;
      Object.assign(s, { url, playing: false, time: 0, at: Date.now() });
      broadcast(room, { type: 'video', url });
      break;
    }
    case 'sync':
      send(c, { type: 'state', sync: true, ...snapshot(room) });
      break;
    case 'chat': {
      const text = String(m.text || '').trim().slice(0, 500);
      if (!text) return;
      const msg = { id: crypto.randomBytes(4).toString('hex'), cid: c.cid, name: c.name, text, ts: Date.now() };
      room.chat.push(msg);
      if (room.chat.length > 50) room.chat.shift();
      broadcast(room, { type: 'chat', msg });
      break;
    }
    case 'mic':
      c.mic = !!m.on;
      broadcastPeers(room);
      break;
    case 'signal': { // пересылка служебных сообщений WebRTC второму участнику
      const to = room.members.get(String(m.to));
      if (to) send(to, { type: 'signal', from: c.sid, data: m.data });
      break;
    }
  }
}

// Раз в 20 секунд проверяем, что соединения живы (и не даём хостингу их закрыть), и чистим старые пустые комнаты.
setInterval(() => {
  for (const c of clients) {
    if (!c.alive) { c.socket.destroy(); continue; }
    c.alive = false;
    if (c.socket.writable) c.socket.write(frame(9, ''));
  }
  for (const [id, r] of rooms) if (r.emptySince && Date.now() - r.emptySince > 3600e3) rooms.delete(id);
}, 20000).unref();

server.listen(PORT, () => console.log('Вдвоём запущен: http://localhost:' + PORT));
