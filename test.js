// Автотест сервера: запускает его и проверяет вход, синхронизацию, чат, переподключение. Запуск: node test.js
const { spawn } = require('child_process');
const assert = require('assert');
const PORT = 3100 + Math.floor(Math.random() * 500);
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT }, cwd: __dirname, stdio: 'ignore' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function client(cid, name = cid, room = 'testroom1') {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const inbox = [], waiters = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const i = waiters.findIndex((w) => w.type === m.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else inbox.push(m);
  };
  const c = {
    ws, closed: new Promise((r) => (ws.onclose = r)),
    send: (o) => ws.send(JSON.stringify(o)),
    next: (type) => new Promise((resolve, reject) => {
      const i = inbox.findIndex((m) => m.type === type);
      if (i >= 0) return resolve(inbox.splice(i, 1)[0]);
      const t = setTimeout(() => reject(new Error('не дождались ' + type)), 3000);
      waiters.push({ type, resolve: (m) => { clearTimeout(t); resolve(m); } });
    }),
    opened: new Promise((r) => (ws.onopen = () => { c.send({ type: 'join', room, name, cid }); r(); })),
  };
  return c;
}
const near = (a, b, d = 1) => assert(Math.abs(a - b) < d, `${a} ≈ ${b}`);
let step = 0;
const ok = (t) => console.log(`✓ ${++step}. ${t}`);

(async () => {
  await wait(400);

  // статика
  const base = `http://localhost:${PORT}`;
  assert.strictEqual((await fetch(base + '/')).status, 200);
  assert.strictEqual((await fetch(base + '/r/abcd1234')).status, 200);
  assert.strictEqual((await fetch(base + '/app.js')).status, 200);
  assert((await fetch(base + '/..%2fserver.js')).status !== 200);
  assert((await fetch(base + '/config').then((r) => r.json())).iceServers.length >= 1);
  ok('сайт, ссылка комнаты и /config отдаются; чужие файлы закрыты');

  const A = client('devA', 'Аня'); const B = client('devB', 'Борис');
  const jA = await A.next('joined');
  assert.strictEqual(jA.video, null);
  const jB = await B.next('joined');
  const pA = await A.next('peers'); // первый peers (1 человек) или второй — берём последний
  let peers = pA; while (peers.peers.length < 2) peers = await A.next('peers');
  assert.strictEqual(peers.peers.length, 2);
  ok('двое вошли в комнату, оба видят присутствие друг друга');

  const C = client('devC');
  assert.strictEqual((await C.next('full')).type, 'full');
  ok('третьего в комнату не пускают');

  const url = 'https://example.com/film.mp4';
  A.send({ type: 'video', url });
  assert.strictEqual((await A.next('video')).url, url);
  assert.strictEqual((await B.next('video')).url, url);
  ok('ссылка на фильм приходит обоим');

  A.send({ type: 'play', time: 10 });
  let s = await B.next('state');
  assert.strictEqual(s.playing, true); near(s.pos, 10);
  ok('Play у одного → у второго играет с той же позиции');

  A.send({ type: 'seek', time: 50 });
  s = await B.next('state');
  assert.strictEqual(s.playing, true); near(s.pos, 50);
  ok('перемотка передаётся, воспроизведение продолжается');

  B.send({ type: 'pause', time: 60 });
  s = await A.next('state');
  assert.strictEqual(s.playing, false); near(s.pos, 60, 0.01);
  ok('Pause у второго → у первого пауза');

  A.send({ type: 'play', time: 100 });
  await B.next('state'); await wait(1200);
  B.send({ type: 'sync' });
  s = await B.next('state');
  assert(s.sync); near(s.pos, 101.2, 0.5);
  ok('запрос синхронизации возвращает «живую» позицию');

  A.send({ type: 'chat', text: 'Привет!' });
  assert.strictEqual((await B.next('chat')).msg.text, 'Привет!');
  assert.strictEqual((await A.next('chat')).msg.name, 'Аня');
  ok('текстовый чат работает');

  const sidB = jB.sid;
  A.send({ type: 'signal', to: sidB, data: { hello: 1 } });
  const sig = await B.next('signal');
  assert.strictEqual(sig.from, jA.sid); assert.strictEqual(sig.data.hello, 1);
  ok('служебные сообщения голоса (WebRTC) пересылаются');

  B.send({ type: 'mic', on: true });
  let pp = await A.next('peers');
  while (!pp.peers.find((p) => p.name === 'Борис').mic) pp = await A.next('peers');
  ok('статус микрофона виден второму');

  // обрыв и возвращение
  B.ws.close(); await B.closed;
  pp = await A.next('peers'); while (pp.peers.length > 1) pp = await A.next('peers');
  ok('когда второй вышел, первый это видит');

  A.send({ type: 'pause', time: 200 });
  const B2 = client('devB', 'Борис');
  const j2 = await B2.next('joined');
  assert.strictEqual(j2.video, url); assert.strictEqual(j2.playing, false); near(j2.pos, 200, 0.01);
  assert(j2.chat.some((m) => m.text === 'Привет!'));
  ok('после переподключения получает видео, позицию, паузу и историю чата');

  // «зависшее» старое соединение того же устройства заменяется новым
  const B3 = client('devB', 'Борис');
  await B3.next('joined'); await B2.closed;
  ok('перезаход с того же устройства не упирается в «комната заполнена»');

  console.log('\nВсе проверки пройдены');
  srv.kill(); process.exit(0);
})().catch((e) => { console.error('\n✗ ОШИБКА:', e.message); srv.kill(); process.exit(1); });
