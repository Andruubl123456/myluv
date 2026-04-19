/**
 * NuestroRave — Servidor FINAL UNIFICADO
 */

try { require('dotenv').config(); } catch(e) {}

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors    = require('cors');

// ─────────────────────────────
// 1. INIT (ANTES DE TODO)
// ─────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] }
});

// ─────────────────────────────
// 2. MIDDLEWARES
// ─────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
const { createProxyMiddleware } = require('http-proxy-middleware');

// Este es el túnel que "engaña" a los sitios de películas
app.use('/proxy', createProxyMiddleware({
    router: (req) => new URL(req.query.url).origin,
    pathRewrite: (path, req) => new URL(req.query.url).pathname + new URL(req.query.url).search,
    changeOrigin: true,
    followRedirects: true,
    onProxyRes: function (proxyRes, req, res) {
        // AQUÍ ESTÁ LA MAGIA: Borramos lo que bloquea el iframe
        delete proxyRes.headers['x-frame-options'];
        delete proxyRes.headers['content-security-policy'];
        
        // Permitimos que tu app lea el contenido
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    }
}));

// ─────────────────────────────
// 3. SEARCH MODULE
// ─────────────────────────────
let searchGoogle, searchYouTubeGoogle;
try {
  ({ searchGoogle, searchYouTubeGoogle } = require('./search'));
  console.log('[SEARCH] OK');
} catch {
  console.warn('[SEARCH] No configurado');
}

// ─────────────────────────────
// 4. CONSTANTES
// ─────────────────────────────
const SYNC = {
  CATCHUP_THRESHOLD: 0.2,
  CATCHUP_SOFT: 0.5,
  CATCHUP_HARD: 3,
  ROOM_GC_TIMEOUT: 30000
};

// ─────────────────────────────
// 5. DB
// ─────────────────────────────
const db = {
  users: {},
  room: {
    onlineUsers: [],
    socketMap: {},
    photoMap: {},
    queue: [],
    currentMedia: null,
    isPlaying: false,
    currentTime: 0,
    currentDuration: 0,
    roomOwner: null,
    messages: [],
    gcTimer: null,
    settings: {
      autoplay: true,
      micEnabled: true,
      allowBothControl: true,
      blockedDomains: [
        'pornhub','xvideos','xnxx','redtube','youporn'
      ]
    }
  }
};

const socketUsers = {};

// ─────────────────────────────
// 6. HELPERS
// ─────────────────────────────
function roomPublicState() {
  const r = db.room;
  return {
    onlineUsers: r.onlineUsers,
    photoMap: r.photoMap,
    queue: r.queue,
    currentMedia: r.currentMedia,
    isPlaying: r.isPlaying,
    currentTime: r.currentTime,
    currentDuration: r.currentDuration,
    roomOwner: r.roomOwner,
    messages: r.messages.slice(-50),
    settings: r.settings
  };
}

function calcCatchup(clientTime, hostTime) {
  const delta = hostTime - clientTime;
  if (Math.abs(delta) < SYNC.CATCHUP_THRESHOLD) return { rate: 1 };
  if (Math.abs(delta) > SYNC.CATCHUP_HARD) return { seek: true, seekTo: hostTime };
  if (delta > SYNC.CATCHUP_SOFT) return { rate: 1.25 };
  if (delta < -SYNC.CATCHUP_SOFT) return { rate: 0.9 };
  return { rate: 1 };
}

function scheduleGC() {
  clearTimeout(db.room.gcTimer);
  db.room.gcTimer = setTimeout(() => {
    if (!db.room.onlineUsers.length) {
      db.room = { ...db.room, onlineUsers: [], queue: [], messages: [] };
      console.log('[GC] limpiado');
    }
  }, SYNC.ROOM_GC_TIMEOUT);
}

// ─────────────────────────────
// 7. YOUTUBE SEARCH
// ─────────────────────────────
const YT_API_KEY = process.env.YT_API_KEY || '';

async function searchYouTube(query) {
  if (!YT_API_KEY) return [];
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=${encodeURIComponent(query)}&key=${YT_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  return (data.items || []).map(v => ({
    id: v.id.videoId,
    title: v.snippet.title,
    thumbnail: v.snippet.thumbnails?.default?.url
  }));
}

// ─────────────────────────────
// 8. ENDPOINTS
// ─────────────────────────────
app.get('/api/config', (req,res)=>{
  res.json({
    googleApiKey: process.env.GOOGLE_API_KEY,
    googleCxId: process.env.GOOGLE_CX_ID
  });
});

app.get('/health', (_req,res)=>{
  res.json({ ok:true, online: db.room.onlineUsers.length });
});

app.post('/register',(req,res)=>{
  const { username, pass } = req.body || {};
  if(!username || !pass) return res.json({ ok:false });
  db.users[username] = { pass };
  res.json({ ok:true });
});

app.post('/login',(req,res)=>{
  const { username, pass } = req.body || {};
  if(!db.users[username] || db.users[username].pass !== pass)
    return res.json({ ok:false });
  res.json({ ok:true, roomState: roomPublicState() });
});

app.post('/search', async (req,res)=>{
  if(!searchGoogle) return res.json({ ok:false });
  const { query, type='video' } = req.body || {};
  const results = type === 'youtube'
    ? await searchYouTubeGoogle(query)
    : await searchGoogle(query,type);
  res.json({ ok:true, results });
});

// ─────────────────────────────
// 9. SOCKET.IO
// ─────────────────────────────
io.on('connection', socket => {

  socket.on('join', ({ username })=>{
    socketUsers[socket.id] = username;
    db.room.onlineUsers.push(username);

    if(!db.room.roomOwner) db.room.roomOwner = username;

    socket.join('room');
    socket.emit('room-state', roomPublicState());
    io.to('room').emit('user-joined', { username });
  });

  socket.on('chat', msg=>{
    db.room.messages.push(msg);
    io.to('room').emit('chat', msg);
  });

  socket.on('chat-image', msg=>{
    msg.type = 'image';
    db.room.messages.push(msg);
    io.to('room').emit('chat', msg);
  });

  socket.on('react-message', data=>{
    io.to('room').emit('message-reaction', data);
  });

  socket.on('play', data=>{
    db.room.isPlaying = true;
    io.to('room').emit('play', data);
  });

  socket.on('pause', data=>{
    db.room.isPlaying = false;
    io.to('room').emit('pause', data);
  });

  socket.on('search-yt', async ({ query })=>{
    socket.emit('yt-results', await searchYouTube(query));
  });

  socket.on('disconnect', ()=>{
    const user = socketUsers[socket.id];
    db.room.onlineUsers = db.room.onlineUsers.filter(u=>u!==user);
    if(!db.room.onlineUsers.length) scheduleGC();
  });
});

// ─────────────────────────────
// 10. START (RAILWAY READY)
// ─────────────────────────────
server.listen(process.env.PORT || 3000, '0.0.0.0', ()=>{
  console.log('[SERVER] Online');
});
