const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] }
});

// Serve static files (HTML, icons, sw.js etc.)
app.use(express.static(path.join(__dirname, 'public')));

// ── ROOMS ──────────────────────────────────────────────
// rooms[code] = {
//   code, players: [socketId, socketId], state: GameState|null,
//   ready: Set<socketId>
// }
const rooms = {};

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function buildInitialState(levelIdx, clientMaxMoves, endless) {
  // Levels mirror the client config
  const LEVELS = [
    { cols:28, rows:46, numColors:7 },
    { cols:30, rows:50, numColors:7 },
    { cols:32, rows:52, numColors:7 },
    { cols:34, rows:54, numColors:7 },
    { cols:36, rows:56, numColors:7 },
    { cols:38, rows:58, numColors:7 },
    { cols:40, rows:60, numColors:7 },
    { cols:42, rows:62, numColors:7 },
  ];
  const cfg = LEVELS[Math.min(levelIdx, LEVELS.length - 1)];
  const { cols, rows, numColors } = cfg;
  // Use maxMoves from client, fallback to 50
  const maxMoves = endless ? 0 : (clientMaxMoves || 50);

  // Build random grid
  const grid = [];
  for (let r = 0; r < rows; r++) {
    grid[r] = [];
    for (let c = 0; c < cols; c++) {
      grid[r][c] = Math.floor(Math.random() * numColors);
    }
  }

  // P1 spawns in bottom zone, P2 gets mirrored position
  function randInt(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); }
  const padC  = Math.max(2, Math.floor(cols * 0.08));
  const p1rowLo = Math.floor(rows * 0.65);
  const p1rowHi = Math.floor(rows * 0.90);

  let p1r, p1c, attempts = 0;
  do {
    p1r = randInt(p1rowLo, p1rowHi);
    p1c = randInt(padC, cols - 1 - padC);
    attempts++;
  } while (attempts < 200);

  // Mirror P2 exactly
  const p2r = rows - 1 - p1r;
  const p2c = cols - 1 - p1c;

  if (grid[p2r][p2c] === grid[p1r][p1c]) grid[p2r][p2c] = (grid[p1r][p1c]+1) % numColors;

  return {
    levelIdx, cols, rows, numColors, maxMoves,
    movesLeft: endless ? 9999 : maxMoves,
    endless: !!endless,
    currentPlayer: 1,
    gameOver: false,
    grid,
    players: [
      { id:1, captured: [`${p1r},${p1c}`], colorIdx: -1, homeR: p1r, homeC: p1c, hasMoved: false },
      { id:2, captured: [`${p2r},${p2c}`], colorIdx: -1, homeR: p2r, homeC: p2c, hasMoved: false },
    ]
  };
}

// ── BFS (server-side mirror of client logic) ────────────
function hexNeighbors(col, row, cols, rows) {
  const even = row % 2 === 0;
  const dirs = even
    ? [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1]]
    : [[-1,0],[1,0],[0,-1],[0,1],[1,-1],[1,1]];
  return dirs.map(([dc,dr])=>[col+dc,row+dr])
             .filter(([c,r])=>c>=0&&r>=0&&c<cols&&r<rows);
}

function bfsCapture(state, playerIdx, colorIdx) {
  const player  = state.players[playerIdx];
  const other   = state.players[1-playerIdx];
  const otherSet = new Set(other.captured);
  const capSet   = new Set(player.captured);
  const { grid, cols, rows } = state;

  // Recolor captured cells
  capSet.forEach(key => {
    const [r,c] = key.split(',').map(Number);
    grid[r][c] = colorIdx;
  });

  // BFS expand
  const queue = [];
  capSet.forEach(key => {
    const [r,c] = key.split(',').map(Number);
    hexNeighbors(c,r,cols,rows).forEach(([nc,nr]) => {
      const k = `${nr},${nc}`;
      if (!capSet.has(k) && !otherSet.has(k) && grid[nr][nc] === colorIdx) {
        queue.push(k);
      }
    });
  });

  const visited = new Set(queue);
  let head = 0;
  while (head < queue.length) {
    const key = queue[head++];
    if (otherSet.has(key)) continue;
    capSet.add(key);
    const [r,c] = key.split(',').map(Number);
    hexNeighbors(c,r,cols,rows).forEach(([nc,nr]) => {
      const k = `${nr},${nc}`;
      if (!visited.has(k) && !capSet.has(k) && !otherSet.has(k) && grid[nr][nc] === colorIdx) {
        visited.add(k); queue.push(k);
      }
    });
  }

  player.captured = [...capSet];
  player.colorIdx = colorIdx;
  player.hasMoved = true;
}

function applyMove(state, playerIdx, colorIdx) {
  const player = state.players[playerIdx];
  const other  = state.players[1-playerIdx];

  if (colorIdx === player.colorIdx && player.hasMoved) return false;
  if (colorIdx === other.colorIdx && other.colorIdx !== -1) return false;

  bfsCapture(state, playerIdx, colorIdx);
  if (!state.endless) state.movesLeft--;

  const total = state.players[0].captured.length + state.players[1].captured.length;
  if (total >= state.cols * state.rows || (!state.endless && state.movesLeft <= 0)) {
    state.gameOver = true;
  } else {
    state.currentPlayer = state.currentPlayer === 1 ? 2 : 1;
  }
  return true;
}

// ── SOCKET EVENTS ───────────────────────────────────────
io.on('connection', socket => {
  console.log('connect', socket.id);

  // Create room
  socket.on('create_room', ({ levelIdx = 0, endless = false, maxMoves = 30 }) => {
    let code;
    do { code = makeCode(); } while (rooms[code]);

    rooms[code] = {
      code,
      players: [socket.id],
      state: null,
      levelIdx,
      endless,
      maxMoves: endless ? 0 : maxMoves,
    };
    socket.join(code);
    socket.data.room = code;
    socket.data.playerIdx = 0;
    socket.emit('room_created', { code });
    console.log('room created', code, 'maxMoves:', maxMoves, 'endless:', endless);
  });

  // Join room
  socket.on('join_room', ({ code }) => {
    const room = rooms[code.toUpperCase()];
    if (!room) { socket.emit('error', { msg: 'Комната не найдена' }); return; }
    if (room.players.length >= 2) { socket.emit('error', { msg: 'Комната заполнена' }); return; }

    room.players.push(socket.id);
    socket.join(code);
    socket.data.room = code;
    socket.data.playerIdx = 1;

    // Both players connected — build state and start
    room.state = buildInitialState(room.levelIdx, room.maxMoves, room.endless);

    io.to(code).emit('game_start', { state: room.state });
    console.log('game started in room', code);
  });

  // Player makes a move
  socket.on('move', ({ colorIdx }) => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || !room.state) return;

    const pi = socket.data.playerIdx;
    if (room.state.currentPlayer - 1 !== pi) return; // not your turn

    const ok = applyMove(room.state, pi, colorIdx);
    if (!ok) return;

    io.to(code).emit('state_update', { state: room.state });

    if (room.state.gameOver) {
      console.log('game over in room', code);
      setTimeout(() => { delete rooms[code]; }, 30000);
    }
  });

  // Rematch
  socket.on('rematch', () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room) return;
    if (!room.rematchVotes) room.rematchVotes = new Set();
    room.rematchVotes.add(socket.id);

    if (room.rematchVotes.size >= 2) {
      room.state = buildInitialState(room.levelIdx, room.maxMoves, room.endless);
      room.rematchVotes = new Set();
      io.to(code).emit('game_start', { state: room.state });
    } else {
      // Notify other player
      socket.to(code).emit('rematch_requested');
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    const code = socket.data.room;
    if (!code || !rooms[code]) return;
    io.to(code).emit('opponent_left');
    delete rooms[code];
    console.log('room', code, 'closed — player disconnected');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Fill More server running on port ${PORT}`));
