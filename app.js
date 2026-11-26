// Вдвоём — клиент: комната, синхронное видео, чат, голос (WebRTC).
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const video = $('video'), remoteAudio = $('remoteAudio');
  const HLS_SRC = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';
  const DEMO_URL = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
  // Сервисы с защищённым плеером (DRM) или без прямых ссылок — честно говорим, что не поддерживаются
  const UNSUPPORTED = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|netflix\.com|disneyplus\.com|primevideo\.com|max\.com|hbomax\.com|hulu\.com|twitch\.tv|kinopoisk\.ru|ivi\.ru|okko\.tv|more\.tv|wink\.ru|start\.ru|premier\.one)$/i;

  const mem = {};
  const store = (area) => ({
    get: (k) => { try { return window[area].getItem(k); } catch { return mem[k] || null; } },
    set: (k, v) => { try { window[area].setItem(k, v); } catch { mem[k] = v; } },
  });
  const local = store('localStorage'), session = store('sessionStorage');

  // cid — «паспорт» этой вкладки: по нему сервер понимает, что вы вернулись, а не пришёл третий
  let cid = session.get('cid');
  if (!cid) { cid = Math.random().toString(36).slice(2) + Date.now().toString(36); session.set('cid', cid); }

  const roomId = (location.pathname.match(/^\/r\/([a-z0-9]{4,32})\/?$/) || [])[1];
  const show = (id) => ['home', 'join', 'room'].forEach((s) => ($(s).hidden = s !== id));
  let toastTimer;
  function toast(text) {
    const t = $('toast'); t.textContent = text; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
  }

  // ---------- вход ----------
  if (!roomId) {
    if (location.pathname !== '/') history.replaceState(null, '', '/');
    show('home');
  } else {
    show('join');
    $('nameInput').value = local.get('name') || '';
  }
  $('createBtn').onclick = () => {
    const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
    location.href = '/r/' + id;
  };

  let myName = 'Гость', iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  $('joinForm').onsubmit = async (e) => {
    e.preventDefault();
    myName = $('nameInput').value.trim().slice(0, 24) || 'Гость';
    local.set('name', myName);
    show('room');
    try { iceServers = (await (await fetch('/config')).json()).iceServers; } catch {}
    connect();
  };

  // ---------- соединение с сервером (с автопереподключением) ----------
  let ws = null, retry = 0, sid = null, lastMsg = 0, lastLocal = 0, fullRetry = false;
  const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const banner = (t) => { $('banner').hidden = !t; $('banner').textContent = t || ''; };

  function connect() {
    if (ws && ws.readyState <= 1) return;
    const mine = (ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'));
    mine.onopen = () => { retry = 0; lastMsg = Date.now(); send({ type: 'join', room: roomId, name: myName, cid }); };
    mine.onmessage = (e) => { lastMsg = Date.now(); onMsg(JSON.parse(e.data)); };
    mine.onclose = () => lost(mine);
  }
  function lost(mine) {
    if (ws !== mine) return;
    ws = null;
    banner(fullRetry ? 'В комнате уже двое. Если это вы — подождите несколько секунд…' : 'Соединение потеряно. Подключаемся…');
    fullRetry = false;
    clearPeers();
    setTimeout(connect, Math.min(1000 * 2 ** retry++, 5000));
  }
  // раз в 5 секунд: сверяем время с сервером и ловим «мёртвое» соединение (бывает на телефонах)
  setInterval(() => {
    if (!ws) return;
    if (Date.now() - lastMsg > 15000) { const dead = ws; lost(dead); try { dead.close(); } catch {} return; }
    send({ type: 'sync' });
  }, 5000);
  // телефон «проснулся» или вернулась сеть — не ждём, подключаемся сразу
  const wake = () => { if (!roomId || $('room').hidden) return; if (!ws) connect(); else send({ type: 'sync' }); };
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && wake());
  addEventListener('online', wake);

  function onMsg(m) {
    switch (m.type) {
      case 'joined':
        sid = m.sid; banner('');
        $('messages').innerHTML = ''; m.chat.forEach(addChat);
        state = { playing: m.playing, pos: m.pos, rcv: performance.now() };
        if (m.video) loadVideo(m.video, m.video !== curUrl); else applyState(state);
        break;
      case 'video': state = { playing: false, pos: 0, rcv: performance.now() }; loadVideo(m.url, true); break;
      case 'state':
        if (m.sync && Date.now() - lastLocal < 1500) break; // только что нажали сами — ответ может быть устаревшим
        applyState(m); break;
      case 'chat': addChat(m.msg); break;
      case 'peers': onPeers(m.peers); break;
      case 'signal': onSignal(m); break;
      case 'full': fullRetry = true; break; // сервер закроет соединение, lost() покажет сообщение и повторит попытку
      case 'error': banner(m.text); break;
    }
  }

  // ---------- видео и синхронизация ----------
  let state = null, curUrl = null, hls = null, remoteSeek = false;
  const expected = () => (state ? (state.playing ? state.pos + (performance.now() - state.rcv) / 1000 : state.pos) : 0);

  function applyState(s) {
    state = { playing: s.playing, pos: s.pos, rcv: performance.now() };
    if (!curUrl || video.readyState < 1) return; // применим, когда загрузятся метаданные
    if (Math.abs(video.currentTime - s.pos) > 0.8) {
      remoteSeek = true; setTimeout(() => (remoteSeek = false), 3000);
      video.currentTime = s.pos;
    }
    if (s.playing && video.paused) video.play().catch((err) => err.name === 'NotAllowedError' && ($('unlock').hidden = false));
    else if (!s.playing && !video.paused) video.pause();
  }

  // Действия самого человека (кнопки плеера) → серверу. Если состояние уже совпадает — это «эхо» от удалённой команды, игнорируем.
  function act(type) {
    const t = video.currentTime;
    lastLocal = Date.now();
    state = { playing: type === 'seek' ? !!(state && state.playing) : type === 'play', pos: t, rcv: performance.now() };
    send({ type, time: t });
  }
  video.addEventListener('play', () => { if (state && !state.playing) act('play'); });
  video.addEventListener('pause', () => { if (state && state.playing) act('pause'); });
  video.addEventListener('seeked', () => {
    if (remoteSeek) { remoteSeek = false; return; }
    if (state && Math.abs(video.currentTime - expected()) > 1) act('seek');
  });

  $('unlock').onclick = () => { // браузер требует касания, чтобы разрешить звук и автозапуск
    $('unlock').hidden = true;
    remoteAudio.play().catch(() => {});
    applyState({ playing: state ? state.playing : false, pos: expected() });
  };

  const loadScript = (src) => new Promise((ok, fail) => {
    const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = fail; document.head.append(s);
  });

  async function loadVideo(url, force) {
    if (!force) return applyState(state);
    curUrl = url;
    $('urlInput').value = url; $('empty').hidden = true; $('playerMsg').hidden = true;
    if (hls) { hls.destroy(); hls = null; }
    video.removeAttribute('src'); video.load();
    video.addEventListener('loadedmetadata', () => applyState(state), { once: true });
    if (/^http:/i.test(url) && location.protocol === 'https:') return showErr('mixed');
    try {
      if (/\.m3u8(\?|#|$)/i.test(url) && !video.canPlayType('application/vnd.apple.mpegurl')) {
        await loadScript(HLS_SRC);
        if (!window.Hls || !Hls.isSupported()) throw new Error('hls');
        hls = new Hls();
        hls.on(Hls.Events.ERROR, (_, d) => d.fatal && showErr('hls'));
        hls.loadSource(url); hls.attachMedia(video);
      } else video.src = url;
    } catch { showErr('hls'); }
  }

  video.addEventListener('error', () => curUrl && showErr('media'));
  function showErr(kind) {
    const ext = ((curUrl || '').split(/[?#]/)[0].match(/\.(mkv|avi|wmv|flv)$/i) || [])[1];
    const text = {
      mixed: 'Ссылка начинается с http:// — браузер блокирует такое видео на защищённом сайте. Найдите версию ссылки с https://.',
      hls: 'Не удалось загрузить поток .m3u8. Скорее всего, сайт не разрешает загрузку с других сайтов или ссылка устарела (такие ссылки часто живут несколько часов).',
      media: ext
        ? `Формат .${ext} не воспроизводится в браузерах (особенно в Safari на iPhone). Нужен .mp4 (H.264) или .m3u8.`
        : 'Это видео не удалось открыть. Возможные причины: ссылка ведёт на страницу сайта, а не на сам видеофайл; сайт запрещает показ видео на других сайтах; формат не поддерживается iPhone; ссылка устарела.',
    }[kind];
    const p = $('playerMsg');
    p.hidden = false;
    p.textContent = '';
    const t = document.createElement('p'); t.textContent = text;
    const h = document.createElement('p'); h.className = 'hint';
    h.textContent = 'Нужна прямая ссылка на файл (.mp4, .webm, .m3u8). Платные сервисы с защитой (DRM) не поддерживаются.';
    p.append(t, h);
  }

  $('urlForm').onsubmit = (e) => {
    e.preventDefault();
    const raw = $('urlInput').value.trim();
    let u;
    try { u = new URL(raw); if (!/^https?:$/.test(u.protocol)) throw 0; } catch { return toast('Это не похоже на ссылку'); }
    if (UNSUPPORTED.test(u.hostname)) {
      curUrl = null; $('empty').hidden = true;
      showErr('media');
      $('playerMsg').firstChild.textContent = `${u.hostname} отдаёт видео через собственный защищённый плеер, прямой ссылки на файл у него нет — этот сайт не поддерживается.`;
      return;
    }
    send({ type: 'video', url: u.href });
  };
  $('demoBtn').onclick = () => send({ type: 'video', url: DEMO_URL });

  // ---------- присутствие ----------
  let others = new Map(); // sid -> {name, mic}
  function onPeers(list) {
    const next = new Map(list.filter((p) => p.sid !== sid).map((p) => [p.sid, p]));
    next.forEach((p, k) => !others.has(k) && sys(`${p.name} в комнате`));
    others.forEach((p, k) => !next.has(k) && sys(`${p.name} вышел(а)`));
    others = next;
    const first = [...others.values()][0];
    $('dot').classList.toggle('on', !!first);
    $('presenceText').textContent = first ? `${first.name} в комнате${first.mic ? ' · 🎤' : ''}` : 'Ждём второго человека…';
    syncPeerConnections();
    renderVoice();
  }

  // ---------- чат ----------
  function addChat(m) {
    const d = document.createElement('div'); d.className = 'msg' + (m.cid === cid ? ' mine' : '');
    if (m.cid !== cid) { const b = document.createElement('b'); b.textContent = m.name; d.append(b); }
    d.append(document.createTextNode(m.text));
    pushMsg(d);
  }
  function sys(text) { const d = document.createElement('div'); d.className = 'msg sys'; d.textContent = text; pushMsg(d); }
  function pushMsg(d) { const box = $('messages'); box.append(d); box.scrollTop = box.scrollHeight; }
  $('chatForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('chatInput').value.trim();
    if (!text) return;
    send({ type: 'chat', text }); $('chatInput').value = '';
  };

  // ---------- приглашение ----------
  $('inviteBtn').onclick = async () => {
    const url = location.href;
    if (navigator.share) {
      try { await navigator.share({ title: 'Смотрим кино вместе', text: 'Заходи в нашу комнату:', url }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(url); toast('Ссылка скопирована — отправьте её'); }
    catch { prompt('Скопируйте ссылку и отправьте:', url); }
  };

  // ---------- голос (WebRTC) ----------
  const peers = new Map(); // sid -> {pc, tr, q}
  let micTrack = null, micOn = false;

  function clearPeers() {
    peers.forEach((p) => p.pc.close()); peers.clear(); others = new Map();
    $('dot').classList.remove('on'); $('presenceText').textContent = 'Ждём второго человека…'; renderVoice();
  }
  function closePeer(id) { const p = peers.get(id); if (p) { p.pc.close(); peers.delete(id); } }

  function ensurePc(id) {
    let p = peers.get(id);
    if (p) return p;
    const pc = new RTCPeerConnection({ iceServers });
    const tr = pc.addTransceiver('audio', { direction: 'sendrecv' });
    if (micTrack) tr.sender.replaceTrack(micTrack);
    pc.onicecandidate = (e) => e.candidate && send({ type: 'signal', to: id, data: { candidate: e.candidate } });
    pc.ontrack = (e) => {
      remoteAudio.srcObject = new MediaStream([e.track]);
      remoteAudio.play().catch(() => ($('unlock').hidden = false));
    };
    pc.onconnectionstatechange = () => {
      renderVoice();
      if (pc.connectionState === 'failed' && peers.get(id) === p) { closePeer(id); if (sid < id) offer(id); }
    };
    p = { pc, tr, q: Promise.resolve() };
    peers.set(id, p);
    return p;
  }
  async function offer(id) {
    const { pc } = ensurePc(id);
    await pc.setLocalDescription(await pc.createOffer());
    send({ type: 'signal', to: id, data: { description: pc.localDescription } });
  }
  function syncPeerConnections() {
    peers.forEach((_, id) => !others.has(id) && closePeer(id));
    others.forEach((_, id) => {
      if (peers.has(id)) return;
      ensurePc(id);
      if (sid < id) offer(id).catch(console.warn); // предложение шлёт тот, у кого идентификатор «меньше»
    });
  }
  function onSignal({ from, data }) {
    if (data.description && data.description.type === 'offer' && peers.get(from)?.pc.remoteDescription) closePeer(from);
    const p = ensurePc(from);
    p.q = p.q.then(async () => {
      if (data.description) {
        await p.pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await p.pc.setLocalDescription(await p.pc.createAnswer());
          send({ type: 'signal', to: from, data: { description: p.pc.localDescription } });
        }
      } else if (data.candidate) await p.pc.addIceCandidate(data.candidate);
    }).catch(console.warn);
  }

  $('micBtn').onclick = async () => {
    if (!micTrack) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return toast('Микрофон работает только по защищённой ссылке https://');
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        micTrack = s.getAudioTracks()[0]; micOn = true;
        peers.forEach((p) => p.tr.sender.replaceTrack(micTrack));
      } catch { return toast('Нет доступа к микрофону. Разрешите его в настройках браузера для этого сайта.'); }
    } else { micOn = !micOn; micTrack.enabled = micOn; }
    send({ type: 'mic', on: micOn });
    renderVoice();
  };

  function renderVoice() {
    const b = $('micBtn');
    b.classList.toggle('live', micTrack && micOn);
    b.classList.toggle('muted', !!micTrack && !micOn);
    $('micText').textContent = !micTrack ? 'Включить микрофон' : micOn ? 'Микрофон включён' : 'Микрофон выключен';
    const p = [...peers.values()][0];
    const st = !p ? '' : { connected: 'Голос соединён', connecting: 'Соединяем голос…', new: 'Соединяем голос…', failed: 'Голос не соединился', disconnected: 'Голос прерван…' }[p.pc.connectionState] || '';
    $('voiceState').textContent = st;
  }
})();
