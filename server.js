const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// =========================
// GAME SETTINGS
// =========================

const WORLD_WIDTH = 1000;
const WORLD_HEIGHT = 760;

const TILE_SIZE = 40;
const TILES_ACROSS = 20;

const PLATFORM_X = 100;
const PLATFORM_WIDTH = TILE_SIZE * TILES_ACROSS;
const PLATFORM_HEIGHT = 24;

const LAYERS = [
  { y: 220 },
  { y: 430 },
  { y: 640 }
];

const PLAYER_WIDTH = 28;
const PLAYER_HEIGHT = 38;

const MOVE_SPEED = 260;
const JUMP_SPEED = 510;
const GRAVITY = 1450;

const TILE_BREAK_DELAY = 180;
const ROUND_RESET_DELAY = 4000;

// =========================
// GAME STATE
// =========================

let players = {};
let tiles = [];
let roundEnding = false;
let roundNumber = 1;

// =========================
// CREATE PLATFORMS
// =========================

function createTiles() {
  tiles = [];

  for (let layer = 0; layer < LAYERS.length; layer++) {
    for (let col = 0; col < TILES_ACROSS; col++) {
      tiles.push({
        id: `${layer}-${col}`,
        layer,
        col,
        x: PLATFORM_X + col * TILE_SIZE,
        y: LAYERS[layer].y,
        width: TILE_SIZE,
        height: PLATFORM_HEIGHT,
        damage: 0,
        broken: false,
        breakAt: null
      });
    }
  }
}

createTiles();

// =========================
// PLAYERS
// =========================

function randomPlayerColor() {
  const colors = [
    "#3498db",
    "#e74c3c",
    "#2ecc71",
    "#9b59b6",
    "#f39c12",
    "#1abc9c",
    "#e84393",
    "#00cec9"
  ];

  return colors[Math.floor(Math.random() * colors.length)];
}

function createPlayer(id) {
  return {
    id,
    x:
      PLATFORM_X +
      PLATFORM_WIDTH / 2 -
      PLAYER_WIDTH / 2 +
      (Math.random() * 200 - 100),

    y: LAYERS[0].y - PLAYER_HEIGHT - 10,

    vx: 0,
    vy: 0,

    width: PLAYER_WIDTH,
    height: PLAYER_HEIGHT,

    left: false,
    right: false,

    alive: true,
    onGround: false,

    color: randomPlayerColor(),

    lastTile: null
  };
}

// =========================
// CONNECTIONS
// =========================

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  players[socket.id] = createPlayer(socket.id);

  socket.emit("init", {
    id: socket.id,
    roundNumber
  });

  socket.on("input", (input) => {
    const player = players[socket.id];

    if (!player || !player.alive) return;

    player.left = !!input.left;
    player.right = !!input.right;

    if (input.jump && player.onGround) {
      player.vy = -JUMP_SPEED;
      player.onGround = false;
    }
  });

  socket.on("disconnect", () => {
    delete players[socket.id];
    checkForWinner();
  });
});

// =========================
// DAMAGE TILES
// =========================

function damageTile(tile, player) {
  if (!tile || tile.broken) return;

  if (player.lastTile === tile.id) {
    return;
  }

  player.lastTile = tile.id;

  tile.damage++;

  if (tile.damage >= 3) {
    tile.damage = 3;

    if (!tile.breakAt) {
      tile.breakAt = Date.now() + TILE_BREAK_DELAY;
    }
  }
}

// =========================
// LANDING COLLISION
// =========================

function findLandingTile(player, previousBottom) {
  const playerBottom = player.y + player.height;

  let landingTile = null;

  for (const tile of tiles) {
    if (tile.broken) continue;

    const horizontalOverlap =
      player.x + player.width > tile.x &&
      player.x < tile.x + tile.width;

    const crossedPlatform =
      previousBottom <= tile.y &&
      playerBottom >= tile.y;

    if (
      horizontalOverlap &&
      crossedPlatform &&
      player.vy >= 0
    ) {
      if (!landingTile || tile.y < landingTile.y) {
        landingTile = tile;
      }
    }
  }

  return landingTile;
}

// =========================
// UPDATE PLAYER
// =========================

function updatePlayer(player, dt) {
  if (!player.alive) return;

  player.vx = 0;

  if (player.left) {
    player.vx = -MOVE_SPEED;
  }

  if (player.right) {
    player.vx = MOVE_SPEED;
  }

  player.x += player.vx * dt;

  const previousBottom = player.y + player.height;

  player.vy += GRAVITY * dt;
  player.y += player.vy * dt;

  player.onGround = false;

  const landingTile = findLandingTile(
    player,
    previousBottom
  );

  if (landingTile) {
    player.y = landingTile.y - player.height;

    player.vy = 0;
    player.onGround = true;

    damageTile(landingTile, player);
  } else {
    const feetX = player.x + player.width / 2;
    const feetY = player.y + player.height + 2;

    let stillAboveLastTile = false;

    if (player.lastTile) {
      const oldTile = tiles.find(
        (tile) => tile.id === player.lastTile
      );

      if (oldTile && !oldTile.broken) {
        if (
          feetX >= oldTile.x &&
          feetX <= oldTile.x + oldTile.width &&
          Math.abs(feetY - oldTile.y) < 15
        ) {
          stillAboveLastTile = true;
        }
      }
    }

    if (!stillAboveLastTile) {
      player.lastTile = null;
    }
  }

  if (player.x < 0) {
    player.x = 0;
  }

  if (player.x + player.width > WORLD_WIDTH) {
    player.x = WORLD_WIDTH - player.width;
  }

  if (player.y > WORLD_HEIGHT + 100) {
    player.alive = false;
    player.left = false;
    player.right = false;

    checkForWinner();
  }
}

// =========================
// BREAK TILES
// =========================

function updateTiles() {
  const now = Date.now();

  for (const tile of tiles) {
    if (tile.breakAt && now >= tile.breakAt) {
      tile.broken = true;
      tile.breakAt = null;
    }
  }
}

// =========================
// CHECK WINNER
// =========================

function checkForWinner() {
  if (roundEnding) return;

  const connectedPlayers = Object.values(players);

  if (connectedPlayers.length === 0) {
    return;
  }

  const alivePlayers = connectedPlayers.filter(
    (player) => player.alive
  );

  if (
    connectedPlayers.length > 1 &&
    alivePlayers.length <= 1
  ) {
    roundEnding = true;

    let winnerId = null;

    if (alivePlayers.length === 1) {
      winnerId = alivePlayers[0].id;
    }

    io.emit("roundOver", {
      winnerId
    });

    setTimeout(resetRound, ROUND_RESET_DELAY);
  }

  // Allows you to test the game by yourself.
  if (
    connectedPlayers.length === 1 &&
    alivePlayers.length === 0
  ) {
    roundEnding = true;

    io.emit("roundOver", {
      winnerId: null
    });

    setTimeout(resetRound, 2500);
  }
}

// =========================
// RESET ROUND
// =========================

function resetRound() {
  createTiles();

  roundNumber++;

  for (const id in players) {
    const oldColor = players[id].color;

    players[id] = createPlayer(id);

    players[id].color = oldColor;
  }

  roundEnding = false;

  io.emit("newRound", {
    roundNumber
  });
}

// =========================
// GAME LOOP
// =========================

let lastUpdate = Date.now();

setInterval(() => {
  const now = Date.now();

  let dt = (now - lastUpdate) / 1000;
  lastUpdate = now;

  if (dt > 0.05) {
    dt = 0.05;
  }

  updateTiles();

  for (const id in players) {
    updatePlayer(players[id], dt);
  }

  io.emit("state", {
    players,
    tiles,
    roundNumber,
    roundEnding
  });
}, 1000 / 30);

// =========================
// START SERVER
// =========================

server.listen(PORT, () => {
  console.log(
    `Bob's Falling Platforms running on port ${PORT}`
  );
});
