// ════════════════════════════════════════════════════════════
//  NUESTRORAVE — SERVIDOR COMPLETO EN UN ARCHIVO
//  Despliega en Railway sin dependencias de subcarpetas
// ════════════════════════════════════════════════════════════

require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const path       = require('path');
const fs         = require('fs');
const { v4: uuidv4 } = require('uuid');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 5e6
});

// ── Middlewares ───────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Servir frontend estático si existe ────────────────────────
const frontendPath = path.join(__dirname, 'public');
if (fs.existsSync(frontendPath)) {
  app.use(express.static(frontendPath));
}

// ════════════════════════════════════════════════════════════
//  BASE DE DATOS EN MEMORIA + PERSISTENCIA JSON
// ════════════════════════════════════════════════════════════

const DB_FILE = path.join(__dirname, 'db.json');

// Estructura de datos
let db = {
  users  : {},   // { username: { hash, photo, friends, createdAt } }
  invites: {}    // { token: { from, to, expires } }
};

// Cargar DB al iniciar
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      db = JSON.parse(raw);
      if (!db.users)   db.users   = {};
      if (!db.invites) db.invites = {};
      console.log(`📂 DB cargada: ${Object.keys(db.users).length} usuarios`);
    }
  } catch(e) {
    console.warn('⚠️ No se pudo cargar DB, empezando vacío');
  }
}

// Guardar DB
function saveDB() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch(e) {
    console.warn('⚠️ No se pudo guardar DB:', e.message);
  }
}

loadDB();

// ════════════════════════════════════════════════════════════
//  FILTRO DE CONTENIDO +18
// ════════════════════════════════════════════════════════════

const BLOCKED_DOMAINS = [
  'pornhub','xvideos','xnxx','redtube','youporn',
  'xhamster','brazzers','onlyfans','porn','xxx',
  'hentai','chaturbate','cam4','spankbang','eporner'
];

const BLOCKED_WORDS = ['porn','xxx','hentai','nude','naked'];

function isBlockedURL(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return BLOCKED_DOMAINS.some(d => lower.includes(d));
}

function isBlockedText(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return BLOCKED_WORDS.some(w => lower.includes(w));
}

// ════════════════════════════════════════════════════════════
//  ESTADO DE LA SALA
// ════════════════════════════════════════════════════════════

let roomState = {
  onlineUsers    : [],
  queue          : [],
  currentMedia   : null,
  isPlaying      : false,
  currentTime    : 0,
  currentDuration: 300,
  roomOwner      : null,
  messages       : [],
  photoMap       : {},
  settings       : {
    autoplay        : true,
    micEnabled      : true,
    allowBothControl: true
  }
};

// Guardar timestamp del último heartbeat para compensar tiempo
let lastHeartbeatAt = Date.now();

// ════════════════════════════════════════════════════════════
//  RUTAS HTTP
// ════════════════════════════════════════════════════════════

// ── Health check ──────────────────────────────────────────────
app.get('/health', (_, res) => {
  res.json({
    ok    : true,
    users : Object.keys(db.users).length,
    online: roomState.onlineUsers.length,
    uptime: Math.floor(process.uptime()),
    version: '2.0.0'
  });
});

// ── REGISTRO ─────────────────────────────────────────────────
app.post('/register', async (req, res) => {
  try {
    const { username, pass } = req.body;

    if (!username || !pass)
      return res.json({ ok: false, error: 'Completa todos los campos' });
    if (username.length < 2)
      return res.json({ ok: false, error: 'Usuario muy corto (mín. 2 caracteres)' });
    if (pass.length < 4)
      return res.json({ ok: false, error: 'Contraseña muy corta (mín. 4 caracteres)' });
    if (db.users[username])
      return res.json({ ok: false, error: 'Ese usuario ya existe' });

    const hash = await bcrypt.hash(pass, 10);
    db.users[username] = {
      username,
      hash,
      photo    : null,
      friends  : [],
      createdAt: Date.now()
    };
    saveDB();

    console.log(`✅ Usuario registrado: ${username}`);
    res.json({ ok: true });

  } catch(e) {
    console.error('Register error:', e.message);
    res.json({ ok: false, error: 'Error interno del servidor' });
  }
});

// ── LOGIN ─────────────────────────────────────────────────────
app.post('/login', async (req, res) => {
  try {
    const { username, pass } = req.body;

    if (!username || !pass)
      return res.json({ ok: false, error: 'Ingresa usuario y contraseña' });

    const user = db.users[username];
    if (!user)
      return res.json({ ok: false, error: 'Usuario no encontrado' });

    const ok = await bcrypt.compare(pass, user.hash);
    if (!ok)
      return res.json({ ok: false, error: 'Contraseña incorrecta' });

    const token = jwt.sign(
      { username },
      process.env.JWT_SECRET || 'nuestrorave_secret_2024',
      { expiresIn: '7d' }
    );

    console.log(`🔑 Login: ${username}`);
    res.json({ ok: true, token, roomState: { ...roomState } });

  } catch(e) {
    console.error('Login error:', e.message);
    res.json({ ok: false, error: 'Error interno del servidor' });
  }
});

// ── MIDDLEWARE JWT ────────────────────────────────────────────
function verifyToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer '))
    return res.status(401).json({ ok: false, error: 'Token requerido' });
  try {
    req.user = jwt.verify(
      auth.split(' ')[1],
      process.env.JWT_SECRET || 'nuestrorave_secret_2024'
    );
    next();
  } catch(e) {
    res.status(401).json({ ok: false, error: 'Token inválido o expirado' });
  }
}

// ── BUSCAR USUARIOS ───────────────────────────────────────────
app.get('/friends/search', verifyToken, (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2)
    return res.json({ ok: false, error: 'Mínimo 2 caracteres' });

  const me = req.user.username;
  const myFriends = db.users[me]?.friends || [];

  const results = Object.keys(db.users)
    .filter(u => u.toLowerCase().includes(q.toLowerCase()) && u !== me)
    .slice(0, 10)
    .map(u => ({
      username: u,
      photo   : db.users[u]?.photo || null,
      isFriend: myFriends.includes(u),
      online  : roomState.onlineUsers.includes(u)
    }));

  res.json({ ok: true, results });
});

// ── ENVIAR SOLICITUD DE AMISTAD ───────────────────────────────
app.post('/friends/request', verifyToken, (req, res) => {
  const { to } = req.body;
  const from = req.user.username;

  if (!to || !db.users[to])
    return res.json({ ok: false, error: 'Usuario no encontrado' });
  if (to === from)
    return res.json({ ok: false, error: 'No puedes agregarte a ti mismo' });

  const myFriends = db.users[from]?.friends || [];
  if (myFriends.includes(to))
    return res.json({ ok: false, error: 'Ya son amigos' });

  // Notificar por socket si está online
  const targetSocket = getSocketByUsername(to);
  if (targetSocket) {
    targetSocket.emit('friend-request', {
      from,
      photo: db.users[from]?.photo || null
    });
  }

  res.json({ ok: true, message: `Solicitud enviada a ${to}` });
});

// ── ACEPTAR AMISTAD ───────────────────────────────────────────
app.post('/friends/accept', verifyToken, (req, res) => {
  const { from } = req.body;
  const me = req.user.username;

  if (!db.users[me])   db.users[me]   = { friends: [] };
  if (!db.users[from]) db.users[from] = { friends: [] };
  if (!db.users[me].friends)   db.users[me].friends   = [];
  if (!db.users[from].friends) db.users[from].friends = [];

  if (!db.users[me].friends.includes(from))   db.users[me].friends.push(from);
  if (!db.users[from].friends.includes(me))   db.users[from].friends.push(me);
  saveDB();

  const fromSocket = getSocketByUsername(from);
  if (fromSocket) {
    fromSocket.emit('friend-accepted', {
      username: me,
      photo   : db.users[me]?.photo || null
    });
  }

  res.json({ ok: true });
});

// ── RECHAZAR AMISTAD ──────────────────────────────────────────
app.post('/friends/reject', verifyToken, (req, res) => {
  res.json({ ok: true });
});

// ── ELIMINAR AMIGO ────────────────────────────────────────────
app.delete('/friends/:username', verifyToken, (req, res) => {
  const { username } = req.params;
  const me = req.user.username;
  if (db.users[me]?.friends) {
    db.users[me].friends = db.users[me].friends.filter(f => f !== username);
  }
  if (db.users[username]?.friends) {
    db.users[username].friends = db.users[username].friends.filter(f => f !== me);
  }
  saveDB();
  res.json({ ok: true });
});

// ── LISTA DE AMIGOS ───────────────────────────────────────────
app.get('/friends/list', verifyToken, (req, res) => {
  const me = req.user.username;
  const myFriends = db.users[me]?.friends || [];

  const list = myFriends
    .filter(f => db.users[f]) // solo usuarios que existen
    .map(f => ({
      username: f,
      photo   : db.users[f]?.photo || null,
      online  : roomState.onlineUsers.includes(f)
    }));

  res.json({ ok: true, friends: list });
});

// ── GENERAR LINK DE INVITACIÓN ────────────────────────────────
app.post('/invites/generate', verifyToken, (req, res) => {
  const from  = req.user.username;
  const token = uuidv4();
  const baseURL = process.env.RAILWAY_URL
    || process.env.RAILWAY_PUBLIC_DOMAIN
    || `http://localhost:${process.env.PORT || 3000}`;

  const inviteUrl = `${baseURL}/?invite=${token}`;

  db.invites[token] = {
    from,
    to     : null,
    expires: Date.now() + 48 * 60 * 60 * 1000
  };

  res.json({ ok: true, inviteUrl, token });
});

// ── ENVIAR INVITACIÓN A USUARIO ───────────────────────────────
app.post('/invites/send', verifyToken, (req, res) => {
  const { to } = req.body;
  const from   = req.user.username;
  const token  = uuidv4();
  const baseURL = process.env.RAILWAY_URL
    || process.env.RAILWAY_PUBLIC_DOMAIN
    || `http://localhost:${process.env.PORT || 3000}`;

  const inviteUrl = `${baseURL}/?invite=${token}`;

  db.invites[token] = {
    from,
    to,
    expires: Date.now() + 24 * 60 * 60 * 1000
  };

  const targetSocket = getSocketByUsername(to);
  if (targetSocket) {
    targetSocket.emit('room-invite', { from, inviteUrl, token });
    res.json({ ok: true, sent: true, inviteUrl });
  } else {
    res.json({ ok: true, sent: false, inviteUrl,
      message: `${to} está offline. Comparte el link.` });
  }
});

// ── VALIDAR INVITACIÓN ────────────────────────────────────────
app.get('/invites/validate/:token', (req, res) => {
  const invite = db.invites[req.params.token];
  if (!invite)
    return res.json({ ok: false, error: 'Invitación no válida' });
  if (Date.now() > invite.expires) {
    delete db.invites[req.params.token];
    return res.json({ ok: false, error: 'Invitación expirada' });
  }
  res.json({ ok: true, from: invite.from });
});

// ── BÚSQUEDA YOUTUBE ──────────────────────────────────────────
app.get('/yt/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ ok: false, results: [] });

  const API_KEY = process.env.YOUTUBE_API_KEY;
  if (!API_KEY) {
    return res.json({
      ok     : true,
      results: [],
      notice : 'Agrega YOUTUBE_API_KEY en Railway para búsquedas'
    });
  }

  try {
    const axios = require('axios');
    const { data } = await axios.get(
      'https://www.googleapis.com/youtube/v3/search', {
        params: {
          part      : 'snippet',
          q,
          type      : 'video',
          maxResults: 12,
          key       : API_KEY,
          safeSearch: 'strict'
        },
        timeout: 8000
      }
    );

    const results = (data.items || []).map(item => ({
      id       : item.id.videoId,
      title    : item.snippet.title,
      channel  : item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails?.medium?.url || ''
    }));

    res.json({ ok: true, results });

  } catch(e) {
    console.error('YouTube search error:', e.message);
    res.json({ ok: false, results: [], error: e.message });
  }
});

// ── CATCH-ALL: servir index.html para SPA ────────────────────
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.json({
      ok     : true,
      message: 'NuestroRave API funcionando ✅',
      health : '/health'
    });
  }
});

// ════════════════════════════════════════════════════════════
//  SOCKET.IO
// ════════════════════════════════════════════════════════════

function getSocketByUsername(username) {
  return [...io.sockets.sockets.values()]
    .find(s => s.username === username) || null;
}

function canControl(username) {
  if (!username) return false;
  if (roomState.settings?.allowBothControl) return true;
  return username === roomState.roomOwner;
}

function handleLeave(socket, username) {
  if (!username) return;

  roomState.onlineUsers = roomState.onlineUsers.filter(u => u !== username);
  socket.leave('room');

  if (roomState.roomOwner === username) {
    roomState.roomOwner = roomState.onlineUsers[0] || null;
    if (roomState.roomOwner) {
      io.to('room').emit('host-changed', { roomOwner: roomState.roomOwner });
    }
  }

  if (roomState.onlineUsers.length === 0) {
    roomState.isPlaying = false;
  }

  io.to('room').emit('user-left', {
    username,
    onlineUsers: roomState.onlineUsers,
    roomOwner  : roomState.roomOwner
  });

  console.log(`👋 ${username} salió | Online: [${roomState.onlineUsers.join(', ')}]`);
}

io.on('connection', socket => {
  console.log(`🔌 Nueva conexión: ${socket.id}`);

  // ── JOIN ────────────────────────────────────────────────────
  socket.on('join', ({ username, photo } = {}) => {
    if (!username) return;

    socket.username = username;
    socket.join('room');

    // Actualizar foto
    if (photo) {
      roomState.photoMap[username] = photo;
      if (db.users[username]) {
        db.users[username].photo = photo;
        saveDB();
      }
    }

    // Agregar a online (sin duplicados)
    if (!roomState.onlineUsers.includes(username)) {
      roomState.onlineUsers.push(username);
    }

    // Asignar owner si no hay
    if (!roomState.roomOwner) {
      roomState.roomOwner = username;
    }

    // Enviar estado completo al nuevo
    socket.emit('room-state', { ...roomState });

    // Avisar a los demás
    socket.to('room').emit('user-joined', {
      username,
      onlineUsers: roomState.onlineUsers,
      roomOwner  : roomState.roomOwner,
      photoMap   : roomState.photoMap
    });

    // Sincronizar media si hay algo reproduciéndose
    if (roomState.currentMedia) {
      // Compensar tiempo transcurrido
      let adjustedTime = roomState.currentTime;
      if (roomState.isPlaying) {
        const elapsed = (Date.now() - lastHeartbeatAt) / 1000;
        adjustedTime = Math.min(
          roomState.currentTime + elapsed,
          roomState.currentDuration
        );
      }
      socket.emit('sync-position', {
        media    : roomState.currentMedia,
        time     : adjustedTime,
        isPlaying: roomState.isPlaying
      });
    }

    console.log(`👤 ${username} se unió | Online: [${roomState.onlineUsers.join(', ')}]`);
  });

  // ── ACTUALIZAR FOTO (sin re-join) ───────────────────────────
  socket.on('update-photo', ({ username, photo } = {}) => {
    if (!username || !photo) return;
    roomState.photoMap[username] = photo;
    if (db.users[username]) {
      db.users[username].photo = photo;
      saveDB();
    }
    io.to('room').emit('photo-updated', { username, photo });
  });

  // ── LEAVE ───────────────────────────────────────────────────
  socket.on('leave',      ({ username } = {}) => handleLeave(socket, username));
  socket.on('disconnect', ()               => handleLeave(socket, socket.username));

  // ── CHAT TEXTO ──────────────────────────────────────────────
  socket.on('chat', ({ username, text, photo } = {}) => {
    if (!text?.trim() || !username) return;

    // Filtrar contenido inapropiado
    if (isBlockedText(text)) {
      socket.emit('chat', {
        username: 'Sistema',
        text    : '⚠️ Mensaje bloqueado por contener contenido inapropiado',
        photo   : null,
        type    : 'text',
        time    : Date.now()
      });
      return;
    }

    const msg = {
      username,
      text : text.trim(),
      photo,
      type : 'text',
      time : Date.now()
    };

    // Guardar en historial (máx 50)
    roomState.messages.push(msg);
    if (roomState.messages.length > 50) roomState.messages.shift();

    // Enviar SOLO a los demás (emisor ya lo mostró)
    socket.to('room').emit('chat', msg);
  });

  // ── CHAT IMAGEN ─────────────────────────────────────────────
  socket.on('chat-image', ({ username, imageData, photo } = {}) => {
    if (!imageData || !username) return;
    const msg = {
      username,
      imageData,
      photo,
      type: 'image',
      time: Date.now()
    };
    roomState.messages.push(msg);
    if (roomState.messages.length > 50) roomState.messages.shift();
    socket.to('room').emit('chat', msg);
  });

  // ── REACCIONES ──────────────────────────────────────────────
  socket.on('react-message', ({ messageId, emoji, username } = {}) => {
    socket.to('room').emit('message-reaction', { messageId, emoji, username });
  });

  // ── PLAY ────────────────────────────────────────────────────
  socket.on('play', ({ username, time } = {}) => {
    if (!canControl(username)) return;
    roomState.isPlaying   = true;
    roomState.currentTime = time ?? roomState.currentTime;
    lastHeartbeatAt       = Date.now();
    io.to('room').emit('play', { username, time: roomState.currentTime });
  });

  // ── PAUSE ───────────────────────────────────────────────────
  socket.on('pause', ({ username, time } = {}) => {
    if (!canControl(username)) return;
    roomState.isPlaying   = false;
    roomState.currentTime = time ?? roomState.currentTime;
    io.to('room').emit('pause', { username, time: roomState.currentTime });
  });

  // ── SEEK ────────────────────────────────────────────────────
  socket.on('seek', ({ username, time } = {}) => {
    if (!canControl(username)) return;
    roomState.currentTime = time;
    io.to('room').emit('seek', { username, time });
  });

  // ── LOAD MEDIA ──────────────────────────────────────────────
  socket.on('load-media', ({ username, media } = {}) => {
    if (!media) return;

    // Bloquear URLs +18
    if (isBlockedURL(media.url)) {
      socket.emit('chat', {
        username: 'Sistema',
        text    : '⛔ URL bloqueada por contenido inapropiado',
        type    : 'text',
        time    : Date.now()
      });
      return;
    }

    roomState.currentMedia    = media;
    roomState.currentTime     = 0;
    roomState.isPlaying       = false;
    lastHeartbeatAt           = Date.now();

    io.to('room').emit('load-media', { username, media });
  });

  // ── HEARTBEAT ───────────────────────────────────────────────
  socket.on('heartbeat', ({ username, time, duration } = {}) => {
    if (username !== roomState.roomOwner) return;
    roomState.currentTime     = time;
    roomState.currentDuration = duration || roomState.currentDuration;
    lastHeartbeatAt           = Date.now();
    socket.lastKnownTime      = time;

    // Enviar catchup a todos los demás
    socket.to('room').emit('catchup', { seek: true, seekTo: time });
  });

  // ── QUEUE ───────────────────────────────────────────────────
  socket.on('update-queue', ({ queue } = {}) => {
    roomState.queue = queue || [];
    io.to('room').emit('update-queue', { queue: roomState.queue });
  });

  // ── SETTINGS ────────────────────────────────────────────────
  socket.on('update-settings', ({ username, settings } = {}) => {
    if (username !== roomState.roomOwner) return;
    roomState.settings = { ...roomState.settings, ...settings };
    io.to('room').emit('update-settings', { settings: roomState.settings });
  });

  // ── TRANSFER HOST ───────────────────────────────────────────
  socket.on('transfer-host', ({ username, newOwner } = {}) => {
    if (username !== roomState.roomOwner) return;
    if (!roomState.onlineUsers.includes(newOwner)) return;
    roomState.roomOwner = newOwner;
    io.to('room').emit('host-changed', { roomOwner: newOwner });
  });

  // ── MIC ─────────────────────────────────────────────────────
  socket.on('mic-on',  ({ username } = {}) => socket.to('room').emit('mic-on',  { username }));
  socket.on('mic-off', ({ username } = {}) => socket.to('room').emit('mic-off', { username }));

  // ── BÚSQUEDA YT VIA SOCKET ──────────────────────────────────
  socket.on('search-yt', async ({ query } = {}) => {
    const API_KEY = process.env.YOUTUBE_API_KEY;
    if (!API_KEY) {
      socket.emit('search-yt-results', { results: [] });
      return;
    }
    try {
      const axios = require('axios');
      const { data } = await axios.get(
        'https://www.googleapis.com/youtube/v3/search', {
          params: {
            part      : 'snippet',
            q         : query,
            type      : 'video',
            maxResults: 12,
            key       : API_KEY,
            safeSearch: 'strict'
          },
          timeout: 8000
        }
      );
      const results = (data.items || []).map(item => ({
        id       : item.id.videoId,
        title    : item.snippet.title,
        channel  : item.snippet.channelTitle,
        thumbnail: item.snippet.thumbnails?.medium?.url || ''
      }));
      socket.emit('search-yt-results', { results });
    } catch(e) {
      socket.emit('search-yt-results', { results: [] });
    }
  });

  // ── SYNC ON DEMAND ──────────────────────────────────────────
  socket.on('request-sync', () => {
    if (roomState.currentMedia) {
      socket.emit('sync-position', {
        media    : roomState.currentMedia,
        time     : roomState.currentTime,
        isPlaying: roomState.isPlaying
      });
    }
  });

  // ── AMISTADES VIA SOCKET ────────────────────────────────────
  socket.on('send-friend-request', ({ from, to } = {}) => {
    const target = getSocketByUsername(to);
    if (target) {
      target.emit('friend-request', {
        from,
        photo: db.users[from]?.photo || null
      });
    }
  });

  socket.on('accept-friend', ({ from, to } = {}) => {
    const target = getSocketByUsername(from);
    if (target) {
      target.emit('friend-accepted', { username: to });
    }
  });

  // ── INVITACIONES VIA SOCKET ─────────────────────────────────
  socket.on('invite-to-room', ({ from, to } = {}) => {
    const target = getSocketByUsername(to);
    if (target) {
      const token   = uuidv4();
      const baseURL = process.env.RAILWAY_URL || `http://localhost:${process.env.PORT || 3000}`;
      const url     = `${baseURL}/?invite=${token}`;
      db.invites[token] = { from, to, expires: Date.now() + 24 * 3600 * 1000 };
      target.emit('room-invite', { from, inviteUrl: url });
      socket.emit('invite-sent', { to, sent: true });
    } else {
      socket.emit('invite-sent', { to, sent: false, offline: true });
    }
  });

});

// ════════════════════════════════════════════════════════════
//  INICIAR SERVIDOR
// ════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════╗
║      NuestroRave Server v2.0         ║
║  Puerto : ${PORT}                      ║
║  Estado : ✅ Funcionando             ║
║  Health : /health                    ║
╚══════════════════════════════════════╝
  `);
});
