
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// GAME SETTINGS
const WIDTH = 1000;
const HEIGHT = 760;
const TILE = 40;
const COLS = 20;
const START_X = 100;
const LEVELS = [220, 430, 640];

const PW = 28;
const PH = 38;
const SPEED = 260;
const JUMP = 510;
const GRAVITY = 1450;

const DAMAGE_INTERVAL = 450;
const BREAK_DELAY = 160;
const RESET_DELAY = 4000;

const players = new Map();

const colors = [
  "#3498db",
  "#e74c3c",
  "#9b59b6",
  "#f39c12",
  "#1abc9c",
  "#e84393"
];

let tiles = [];
let round = 1;
let phase = "waiting";
let endAt = 0;

// CREATE TILES
function buildTiles() {
  tiles = LEVELS.flatMap((y, layer) =>
    Array.from({ length: COLS }, (_, col) => ({
      id: `${layer}-${col}`,
      layer,
      x: START_X + col * TILE,
      y,
      width: TILE,
      height: 24,
      damage: 0,
      broken: false,
      breakAt: 0,
      lastDamageAt: 0
    }))
  );
}

// SPAWN PLAYER
function spawn(p) {
  p.x = START_X + 200 + Math.random() * 360;
  p.y = LEVELS[0] - PH;
  p.vx = 0;
  p.vy = 0;
  p.alive = true;
  p.onGround = true;
  p.left = false;
  p.right = false;
  p.jumpHeld = false;
}

function activePlayers() {
  return [...players.values()].filter(p => p.inRound);
}

// START NEW ROUND
function beginRound() {
  buildTiles();
  round++;
  phase = "playing";

  for (const p of players.values()) {
    p.inRound = true;
    spawn(p);
  }

  io.emit("newRound", { round });
}

// END ROUND
function finishRound() {
  if (phase !== "playing") return;

  phase = "ending";
  endAt = Date.now() + RESET_DELAY;

  const alive = activePlayers().filter(p => p.alive);

  io.emit("roundOver", {
    winnerId: alive.length === 1 ? alive[0].id : null
  });
}

// CHECK WINNER
function checkEnd() {
  if (phase !== "playing") return;

  const participants = activePlayers();
  const alive = participants.filter(p => p.alive);

  if (
    participants.length === 0 ||
    alive.length === 0 ||
    (participants.length > 1 && alive.length <= 1)
  ) {
    finishRound();
  }
}

// DAMAGE TILES
function damage(tile, now) {
  if (tile.broken || tile.breakAt) return;

  if (now - tile.lastDamageAt < DAMAGE_INTERVAL) {
    return;
  }

  tile.lastDamageAt = now;
  tile.damage++;

  if (tile.damage >= 3) {
    tile.damage = 3;
    tile.breakAt = now + BREAK_DELAY;
  }
}

// UPDATE PLAYER
function updatePlayer(p, dt, now) {
  if (!p.inRound || !p.alive) return;

  // Horizontal movement
  p.vx = (Number(p.right) - Number(p.left)) * SPEED;

  p.x = Math.max(
    0,
    Math.min(WIDTH - PW, p.x + p.vx * dt)
  );

  // AUTOMATIC JUMP
  // Holding jump makes the player jump again
  // whenever they are on the ground.
  if (p.jumpHeld && p.onGround) {
    p.vy = -JUMP;
    p.onGround = false;
  }

  const previousBottom = p.y + PH;

  // Gravity
  p.vy += GRAVITY * dt;
  p.y += p.vy * dt;

  const bottom = p.y + PH;
  let ground = null;

  // Platform collision
  if (p.vy >= 0) {
    for (const tile of tiles) {
      if (tile.broken) continue;

      if (
        p.x + PW <= tile.x ||
        p.x >= tile.x + TILE
      ) {
        continue;
      }

      if (
        previousBottom <= tile.y + 2 &&
        bottom >= tile.y &&
        (!ground || tile.y < ground.y)
      ) {
        ground = tile;
      }
    }
  }

  if (ground) {
    p.y = ground.y - PH;
    p.vy = 0;
    p.onGround = true;
  } else {
    p.onGround = false;
  }

  // Damage tiles while standing on them
  if (p.onGround && ground) {
    const feet = tiles.filter(t =>
      !t.broken &&
      t.y === ground.y &&
      p.x + PW > t.x &&
      p.x < t.x + TILE
    );

    for (const tile of feet) {
      damage(tile, now);
    }
  }

  // Death below bottom layer
  if (p.y > HEIGHT + 100) {
    p.alive = false;
    p.left = false;
    p.right = false;
    p.jumpHeld = false;

    checkEnd();
  }
}

// CREATE FIRST ARENA
buildTiles();

// MULTIPLAYER CONNECTIONS
io.on("connection", socket => {
  const p = {
    id: socket.id,
    color: colors[
      Math.floor(Math.random() * colors.length)
    ],
    inRound: false,
    alive: false,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    left: false,
    right: false,
    onGround: false,
    jumpHeld: false
  };

  players.set(socket.id, p);

  // Only first visitor starts an empty game.
  // Anyone else waits until next round.
  if (phase === "waiting") {
    phase = "playing";
    p.inRound = true;
    spawn(p);
  }

  socket.emit("init", {
    id: socket.id,
    round,
    spectator: !p.inRound
  });

  // PLAYER CONTROLS
  socket.on("input", data => {
    if (
      !p.inRound ||
      !p.alive ||
      phase !== "playing" ||
      !data ||
      typeof data !== "object"
    ) {
      return;
    }

    p.left = data.left === true;
    p.right = data.right === true;

    // Store whether jump is being held.
    p.jumpHeld = data.jump === true;
  });

  socket.on("disconnect", () => {
    players.delete(socket.id);
    checkEnd();
  });
});

// MAIN GAME LOOP
let last = Date.now();

setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  if (phase === "playing") {
    // Break damaged tiles
    for (const tile of tiles) {
      if (tile.breakAt && now >= tile.breakAt) {
        tile.broken = true;
        tile.breakAt = 0;
      }
    }

    // Update players
    for (const p of players.values()) {
      updatePlayer(p, dt, now);
    }

    checkEnd();
  } else if (phase === "ending" && now >= endAt) {
    beginRound();
  }

  // Send synchronized game state
  io.emit("state", {
    round,
    phase,
    tiles: tiles.map(t => ({
      id: t.id,
      x: t.x,
      y: t.y,
      width: t.width,
      height: t.height,
      damage: t.damage,
      broken: t.broken
    })),
    players: Object.fromEntries(
      [...players].map(([id, p]) => [
        id,
        {
          id,
          x: p.x,
          y: p.y,
          width: PW,
          height: PH,
          color: p.color,
          alive: p.alive,
          inRound: p.inRound
        }
      ])
    )
  });
}, 1000 / 30);

// START SERVER
server.listen(PORT, () => {
  console.log(
    `Bob's Falling Platforms running on port ${PORT}`
  );
});
