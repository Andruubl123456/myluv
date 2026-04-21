// ═══════════════════════════════════════════════
//  NuestroRave — Backend Server
//  Node.js + Express + Socket.io
// ═══════════════════════════════════════════════
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const fetch      = require('node-fetch');

const app    = express();
const server = http.createServer(app);

// ── CORS ──────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 10 * 1024 * 1024 // 10 MB (para imágenes de chat)
});

// ── API KEYS ──────────────────────────────────
const YT_API_KEY   = process.env.YT_API_KEY   || '';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';

// ── BASE DE DATOS EN MEMORIA ──────────────────
// (persiste mientras el servidor esté corriendo)
const users = {};   // { username: { passHash, photo } }
const room  = {
  onlineUsers : [],
  queue       : [],
  currentMedia: null,
  isPlaying   : false,
  currentTime : 0,
  currentDuration: 300,
  roomOwner   : null,
  messages    : [],   // últimos 50 mensajes
  photoMap    : {},   // { username: photoBase64 }
  settings    : {
    autoplay        : true,
    micEnabled      : true,
    allowBothControl: true
  }
};

// ── HELPERS ───────────────────────────────────
function getRoomState() {
  return {
    onlineUsers   : room.onlineUsers,
    queue         : room.queue,
    currentMedia  : room.currentMedia,
    isPlaying     : room.isPlaying,
    currentTime   : room.currentTime,
    currentDuration: room.currentDuration,
    roomOwner     : room.roomOwner,
    messages      : room.messages.slice(-50),
    photoMap      : room.photoMap,
    settings      : room.settings
  };
}

function pushMessage(msg) {
  room.messages.push(msg);
  if (room.messages.length > 50) room.messages.shift();
}

// ══════════════════════════════════════════════
//  REST — AUTH
// ══════════════════════════════════════════════
app.post('/register', async (req, res) => {
  const { username, pass } = req.body || {};
  if (!username || !pass) return res.json({ ok: false, error: 'Faltan datos' });
  if (username.length < 2)  return res.json({ ok: false, error: 'Nombre muy corto' });
  if (pass.length < 4)      return res.json({ ok: false, error: 'Contraseña muy corta' });
  if (users[username])      return res.json({ ok: false, error: 'Usuario ya existe' });
  users[username] = { passHash: await bcrypt.hash(pass, 10), photo: null };
  res.json({ ok: true });
});

app.post('/login', async (req, res) => {
  const { username, pass } = req.body || {};
  if (!username || !pass) return res.json({ ok: false, error: 'Faltan datos' });
  const user = users[username];
  if (!user) return res.json({ ok: false, error: 'Usuario no encontrado' });
  const match = await bcrypt.compare(pass, user.passHash);
  if (!match) return res.json({ ok: false, error: 'Contraseña incorrecta' });
  res.json({ ok: true, roomState: getRoomState() });
});

// ══════════════════════════════════════════════
//  REST — YOUTUBE SEARCH
// ══════════════════════════════════════════════
app.get('/search-yt', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json({ results: [] });
  if (!YT_API_KEY) return res.json({ results: [], error: 'Sin API key de YouTube' });
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=15&q=${encodeURIComponent(q)}&key=${YT_API_KEY}`;
    const r    = await fetch(url);
    const data = await r.json();
    const results = (data.items || []).map(item => ({
      id       : item.id.videoId,
      title    : item.snippet.title,
      channel  : item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails?.medium?.url || ''
    }));
    res.json({ results });
  } catch (e) {
    res.json({ results: [], error: e.message });
  }
});

// ══════════════════════════════════════════════
//  REST — HEALTH CHECK
// ══════════════════════════════════════════════
app.get('/', (_req, res) => res.json({ ok: true, status: 'NuestroRave server running 💕' }));
app.get('/health', (_req, res) => res.json({ ok: true }));

// ══════════════════════════════════════════════
//  REST — TMDB SEARCH (películas y series)
// ══════════════════════════════════════════════
app.get('/search-tmdb', async (req, res) => {
  const { q, type } = req.query; // type: 'movie' | 'tv' | 'multi'
  if (!q) return res.json({ results: [] });
  if (!TMDB_API_KEY) return res.json({ results: [], error: 'Sin API key de TMDB' });
  try {
    const searchType = type || 'multi';
    const url = `https://api.themoviedb.org/3/search/${searchType}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(q)}&language=es-ES&page=1`;
    const r    = await fetch(url);
    const data = await r.json();
    const results = (data.results || []).slice(0, 15).map(item => ({
      id        : item.id,
      imdb_id   : item.imdb_id || null,
      title     : item.title || item.name,
      type      : item.media_type || type || 'movie',
      year      : (item.release_date || item.first_air_date || '').substring(0, 4),
      poster    : item.poster_path ? `https://image.tmdb.org/t/p/w200${item.poster_path}` : '',
      overview  : item.overview || '',
      rating    : item.vote_average || 0
    }));
    res.json({ results });
  } catch (e) {
    res.json({ results: [], error: e.message });
  }
});

// ── Obtener IMDB ID de una película/serie ─────
app.get('/tmdb-imdb', async (req, res) => {
  const { id, type } = req.query;
  if (!id || !TMDB_API_KEY) return res.json({ imdb_id: null });
  try {
    const url = `https://api.themoviedb.org/3/${type || 'movie'}/${id}/external_ids?api_key=${TMDB_API_KEY}`;
    const r    = await fetch(url);
    const data = await r.json();
    res.json({ imdb_id: data.imdb_id || null });
  } catch (e) {
    res.json({ imdb_id: null });
  }
});

// ── Obtener temporadas de una serie ───────────
app.get('/tmdb-seasons', async (req, res) => {
  const { id } = req.query;
  if (!id || !TMDB_API_KEY) return res.json({ seasons: [] });
  try {
    const url = `https://api.themoviedb.org/3/tv/${id}?api_key=${TMDB_API_KEY}&language=es-ES`;
    const r    = await fetch(url);
    const data = await r.json();
    const seasons = (data.seasons || [])
      .filter(s => s.season_number > 0)
      .map(s => ({ number: s.season_number, name: s.name, episodes: s.episode_count }));
    res.json({ seasons, imdb_id: null });
  } catch (e) {
    res.json({ seasons: [] });
  }
});

// ══════════════════════════════════════════════
//  REST — VIDEO PROXY
//  Permite cargar streams de sitios externos
//  sin bloqueo de CORS
// ══════════════════════════════════════════════
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing url');

  // Solo permitir URLs de sitios de video conocidos
  const ALLOWED = [
    'vidsrc.to', 'vidsrc.me', 'vidsrc.xyz', '2embed.cc',
    'embedder.net', 'moviesapi.club', 'nontongo.cc',
    'archive.org', 'cdn.pluto.tv'
  ];
  const isAllowed = ALLOWED.some(d => targetUrl.includes(d));
  if (!isAllowed) return res.status(403).send('Domain not allowed');

  try {
    const r = await fetch(targetUrl, {
      headers: {
        'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept'         : '*/*',
        'Referer'        : targetUrl,
        'Origin'         : new URL(targetUrl).origin
      }
    });

    // Pasar headers relevantes
    const contentType = r.headers.get('content-type') || 'application/octet-stream';
    res.set('Content-Type', contentType);
    res.set('Access-Control-Allow-Origin', '*');

    // Stream directo
    r.body.pipe(res);
  } catch (e) {
    res.status(500).send('Proxy error: ' + e.message);
  }
});

// ══════════════════════════════════════════════
//  SOCKET.IO
// ══════════════════════════════════════════════
io.on('connection', socket => {
  let currentUser = null;

  // ── JOIN ──────────────────────────────────
  socket.on('join', ({ username, photo }) => {
    if (!username) return;
    currentUser = username;

    // Actualizar foto si viene
    if (photo) {
      room.photoMap[username] = photo;
      if (users[username]) users[username].photo = photo;
    }

    // Añadir a lista si no está
    if (!room.onlineUsers.includes(username)) {
      room.onlineUsers.push(username);
    }

    // Asignar owner si sala vacía
    if (!room.roomOwner || !room.onlineUsers.includes(room.roomOwner)) {
      room.roomOwner = username;
    }

    socket.join('room');

    // Enviar estado actual al que se une
    socket.emit('room-state', getRoomState());

    // Notificar a todos
    io.to('room').emit('user-joined', {
      username,
      onlineUsers: room.onlineUsers,
      roomOwner  : room.roomOwner,
      photoMap   : room.photoMap
    });

    // Si hay algo reproduciéndose, sincronizar posición
    if (room.currentMedia && room.isPlaying) {
      // Pedir posición actual al owner
      const ownerSocket = [...io.sockets.sockets.values()]
        .find(s => s._username === room.roomOwner);
      if (ownerSocket) {
        ownerSocket.emit('request-position', {}, (time) => {
          room.currentTime = time || room.currentTime;
          socket.emit('sync-position', {
            media   : room.currentMedia,
            time    : room.currentTime,
            isPlaying: room.isPlaying
          });
        });
      } else {
        socket.emit('sync-position', {
          media   : room.currentMedia,
          time    : room.currentTime,
          isPlaying: room.isPlaying
        });
      }
    }

    socket._username = username;
  });

  // ── UPDATE PHOTO (sin re-join) ────────────
  socket.on('update-photo', ({ username, photo }) => {
    if (!username || !photo) return;
    room.photoMap[username] = photo;
    if (users[username]) users[username].photo = photo;
    io.to('room').emit('photo-updated', { username, photo });
  });

  // ── CHAT ─────────────────────────────────
  socket.on('chat', ({ username, text, photo }) => {
    if (!username || !text) return;
    const msg = { username, text, photo, time: Date.now() };
    pushMessage(msg);
    // Broadcast a todos MENOS el emisor
    socket.to('room').emit('chat', msg);
  });

  // ── CHAT IMAGE ───────────────────────────
  socket.on('chat-image', ({ username, imageData, photo }) => {
    if (!username || !imageData) return;
    const msg = { username, imageData, photo, type: 'image', time: Date.now() };
    pushMessage(msg);
    socket.to('room').emit('chat', msg);
  });

  // ── REACT ────────────────────────────────
  socket.on('react-message', ({ messageId, emoji, username }) => {
    socket.to('room').emit('message-reaction', { messageId, emoji, username });
  });

  // ── PLAY ─────────────────────────────────
  socket.on('play', ({ username, time }) => {
    room.isPlaying  = true;
    room.currentTime = time || room.currentTime;
    io.to('room').emit('play', { username, time: room.currentTime });
  });

  // ── PAUSE ────────────────────────────────
  socket.on('pause', ({ username, time }) => {
    room.isPlaying  = false;
    room.currentTime = time || room.currentTime;
    io.to('room').emit('pause', { username, time: room.currentTime });
  });

  // ── SEEK ─────────────────────────────────
  socket.on('seek', ({ username, time }) => {
    room.currentTime = time;
    io.to('room').emit('seek', { username, time });
  });

  // ── HEARTBEAT (sync drift) ───────────────
  socket.on('heartbeat', ({ username, time, duration }) => {
    if (username !== room.roomOwner) return;
    room.currentTime    = time;
    room.currentDuration = duration || room.currentDuration;

    // Mandar catchup a todos los demás
    socket.to('room').emit('catchup-check', { serverTime: time });
  });

  // ── LOAD MEDIA ───────────────────────────
  socket.on('load-media', ({ username, media }) => {
    room.currentMedia   = media;
    room.isPlaying      = false;
    room.currentTime    = 0;
    io.to('room').emit('load-media', { username, media });
  });

  // ── UPDATE QUEUE ─────────────────────────
  socket.on('update-queue', ({ queue }) => {
    room.queue = queue || [];
    io.to('room').emit('update-queue', { queue: room.queue });
  });

  // ── UPDATE SETTINGS ──────────────────────
  socket.on('update-settings', ({ username, settings }) => {
    if (username !== room.roomOwner) return;
    room.settings = { ...room.settings, ...settings };
    io.to('room').emit('update-settings', { settings: room.settings });
  });

  // ── TRANSFER HOST ────────────────────────
  socket.on('transfer-host', ({ username, newOwner }) => {
    if (username !== room.roomOwner) return;
    if (!room.onlineUsers.includes(newOwner)) return;
    room.roomOwner = newOwner;
    io.to('room').emit('host-changed', { roomOwner: newOwner });
  });

  // ── MIC ──────────────────────────────────
  socket.on('mic-on',  ({ username }) => socket.to('room').emit('mic-on',  { username }));
  socket.on('mic-off', ({ username }) => socket.to('room').emit('mic-off', { username }));

  // ── YOUTUBE SEARCH ───────────────────────
  socket.on('search-yt', async ({ query }) => {
    if (!query) return;
    if (!YT_API_KEY) {
      socket.emit('search-yt-results', { results: [] });
      return;
    }
    try {
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=15&q=${encodeURIComponent(query)}&key=${YT_API_KEY}`;
      const r    = await fetch(url);
      const data = await r.json();
      const results = (data.items || []).map(item => ({
        id       : item.id.videoId,
        title    : item.snippet.title,
        channel  : item.snippet.channelTitle,
        thumbnail: item.snippet.thumbnails?.medium?.url || ''
      }));
      socket.emit('search-yt-results', { results });
    } catch (e) {
      socket.emit('search-yt-results', { results: [] });
    }
  });

  // ── REQUEST SYNC ─────────────────────────
  socket.on('request-sync', () => {
    if (room.currentMedia) {
      socket.emit('sync-position', {
        media   : room.currentMedia,
        time    : room.currentTime,
        isPlaying: room.isPlaying
      });
    }
  });

  // ── LEAVE ────────────────────────────────
  socket.on('leave', ({ username }) => handleLeave(username));

  socket.on('disconnect', () => {
    if (currentUser) handleLeave(currentUser);
  });

  function handleLeave(username) {
    room.onlineUsers = room.onlineUsers.filter(u => u !== username);
    // Reasignar owner
    if (room.roomOwner === username && room.onlineUsers.length > 0) {
      room.roomOwner = room.onlineUsers[0];
      io.to('room').emit('host-changed', { roomOwner: room.roomOwner });
    }
    if (room.onlineUsers.length === 0) room.roomOwner = null;
    io.to('room').emit('user-left', {
      username,
      onlineUsers: room.onlineUsers,
      roomOwner  : room.roomOwner
    });
    currentUser = null;
  }
});

// ══════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`💕 NuestroRave server corriendo en puerto ${PORT}`);
});
