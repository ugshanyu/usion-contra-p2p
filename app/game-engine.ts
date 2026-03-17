/**
 * Contra P2P — Co-op Side-Scrolling Shooter Engine
 *
 * Runs in the HOST browser only. The guest sends input, receives state.
 * Deterministic seeded random ensures consistent enemy spawns.
 *
 * Coordinate system: 320×180 virtual pixels (16:9 retro).
 * Gravity, platforms, scrolling camera, enemy waves.
 */

// ─── Types ────────────────────────────────────────────────────────────

export interface Vec2 { x: number; y: number }

export interface PlayerInput {
    left: boolean;
    right: boolean;
    up: boolean;
    down: boolean;
    jump: boolean;
    fire: boolean;
}

export interface Player {
    id: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    dir: 1 | -1;       // facing direction
    grounded: boolean;
    hp: number;         // lives remaining
    alive: boolean;
    invincibleMs: number;
    powerup: string | null;  // 'spread' | 'rapid' | null
    fireCooldownMs: number;
    anim: string;       // 'idle' | 'run' | 'jump' | 'fall' | 'die'
    input: PlayerInput;
}

export interface Enemy {
    id: string;
    type: 'runner' | 'shooter' | 'flyer' | 'boss';
    x: number;
    y: number;
    vx: number;
    vy: number;
    hp: number;
    maxHp: number;
    dir: 1 | -1;
    anim: string;
    fireCooldownMs: number;
    phaseTimer: number; // multi-purpose timer (sine wave, boss phases)
    active: boolean;
}

export interface Bullet {
    id: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    owner: 'player' | 'enemy';
    playerId?: string;
    ttlMs: number;
}

export interface Pickup {
    id: string;
    x: number;
    y: number;
    type: 'spread' | 'rapid' | 'life';
}

export interface Platform {
    x: number;
    y: number;
    w: number;
}

export interface Explosion {
    x: number;
    y: number;
    ttlMs: number;
    radius: number;
}

export interface GameState {
    phase: 'waiting' | 'countdown' | 'playing' | 'wave_clear' | 'game_over';
    tick: number;
    seed: number;
    cameraX: number;
    countdownMs: number;
    players: Record<string, Player>;
    enemies: Enemy[];
    bullets: Bullet[];
    pickups: Pickup[];
    platforms: Platform[];
    explosions: Explosion[];
    score: number;
    wave: number;
    waveEnemiesLeft: number;
    waveSpawnTimer: number;
    waveClearMs: number;
    scrollSpeed: number;
}

// ─── Constants ────────────────────────────────────────────────────────

export const W = 320;
export const H = 180;
const GRAVITY = 600;        // px/s²
const JUMP_VEL = -220;      // px/s
const MOVE_SPEED = 80;      // px/s
const GROUND_Y = 155;       // ground level
const PLAYER_W = 10;
const PLAYER_H = 16;
const BULLET_SPEED = 200;
const ENEMY_BULLET_SPEED = 100;
const FIRE_COOLDOWN = 200;  // ms
const RAPID_COOLDOWN = 100;
const INVINCIBLE_MS = 2000;
const MAX_LIVES = 3;
const SCROLL_SPEED = 15;    // px/s

const WAVE_CONFIGS: Array<{ runners: number; shooters: number; flyers: number; boss: boolean }> = [
    { runners: 6, shooters: 2, flyers: 0, boss: false },
    { runners: 8, shooters: 4, flyers: 2, boss: false },
    { runners: 10, shooters: 5, flyers: 3, boss: true },
];

// ─── Seeded Random ────────────────────────────────────────────────────

function seededRandom(seed: number): number {
    const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
}

// ─── State Init ───────────────────────────────────────────────────────

export function initState(playerIds: string[]): GameState {
    const players: Record<string, Player> = {};
    const spawnXs = [60, 90];

    for (let i = 0; i < Math.min(playerIds.length, 2); i++) {
        const id = playerIds[i];
        players[id] = {
            id, x: spawnXs[i], y: GROUND_Y - PLAYER_H,
            vx: 0, vy: 0, dir: 1, grounded: true,
            hp: MAX_LIVES, alive: true, invincibleMs: 0,
            powerup: null, fireCooldownMs: 0,
            anim: 'idle',
            input: { left: false, right: false, up: false, down: false, jump: false, fire: false },
        };
    }

    return {
        phase: 'countdown', tick: 0, seed: Date.now(),
        cameraX: 0, countdownMs: 3000,
        players, enemies: [], bullets: [], pickups: [],
        platforms: generatePlatforms(0),
        explosions: [],
        score: 0, wave: 1,
        waveEnemiesLeft: 0, waveSpawnTimer: 0, waveClearMs: 0,
        scrollSpeed: SCROLL_SPEED,
    };
}

function generatePlatforms(startX: number): Platform[] {
    // Generate floating platforms in the level
    const platforms: Platform[] = [];
    for (let i = 0; i < 20; i++) {
        const x = startX + 100 + i * 80 + seededRandom(i * 31 + 7) * 40;
        const y = GROUND_Y - 35 - seededRandom(i * 17 + 3) * 40;
        const w = 30 + seededRandom(i * 53 + 11) * 20;
        platforms.push({ x, y, w });
    }
    return platforms;
}

// ─── Input ────────────────────────────────────────────────────────────

const DEFAULT_INPUT: PlayerInput = { left: false, right: false, up: false, down: false, jump: false, fire: false };

export function applyInput(state: GameState, playerId: string, input: Partial<PlayerInput>) {
    const p = state.players[playerId];
    if (!p) return;
    p.input = { ...DEFAULT_INPUT, ...input };
}

// ─── Main Tick ────────────────────────────────────────────────────────

export function tick(state: GameState, dtMs: number): GameState {
    const dt = dtMs / 1000;
    state.tick += 1;

    // Phase: countdown
    if (state.phase === 'countdown') {
        state.countdownMs -= dtMs;
        if (state.countdownMs <= 0) {
            state.phase = 'playing';
            startWave(state, state.wave);
        }
        return state;
    }

    // Phase: wave clear delay
    if (state.phase === 'wave_clear') {
        state.waveClearMs -= dtMs;
        if (state.waveClearMs <= 0) {
            state.wave += 1;
            if (state.wave > WAVE_CONFIGS.length) {
                state.phase = 'game_over'; // Victory!
                return state;
            }
            startWave(state, state.wave);
            state.phase = 'playing';
        }
        return state;
    }

    if (state.phase !== 'playing') return state;

    // Scroll camera
    state.cameraX += state.scrollSpeed * dt;

    // Update players
    for (const p of Object.values(state.players)) {
        if (!p.alive) continue;
        updatePlayer(state, p, dt, dtMs);
    }

    // Spawn enemies
    state.waveSpawnTimer -= dtMs;
    if (state.waveSpawnTimer <= 0 && state.waveEnemiesLeft > 0) {
        spawnNextEnemy(state);
        state.waveSpawnTimer = 800 + seededRandom(state.tick * 7 + 13) * 600;
    }

    // Update enemies
    for (const e of state.enemies) {
        if (!e.active) continue;
        updateEnemy(state, e, dt, dtMs);
    }
    state.enemies = state.enemies.filter(e => e.active);

    // Update bullets
    for (const b of state.bullets) {
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.ttlMs -= dtMs;
    }
    state.bullets = state.bullets.filter(b => b.ttlMs > 0 && b.x > state.cameraX - 20 && b.x < state.cameraX + W + 20);

    // Collisions
    checkBulletEnemyCollisions(state);
    checkBulletPlayerCollisions(state);
    checkPlayerEnemyCollisions(state);
    checkPickupCollisions(state);

    // Expire explosions
    for (const ex of state.explosions) ex.ttlMs -= dtMs;
    state.explosions = state.explosions.filter(e => e.ttlMs > 0);

    // Check wave clear
    if (state.waveEnemiesLeft <= 0 && state.enemies.length === 0) {
        state.phase = 'wave_clear';
        state.waveClearMs = 2000;
    }

    // Check game over
    const anyAlive = Object.values(state.players).some(p => p.alive);
    if (!anyAlive) {
        state.phase = 'game_over';
    }

    return state;
}

// ─── Player Update ────────────────────────────────────────────────────

function updatePlayer(state: GameState, p: Player, dt: number, dtMs: number) {
    // Invincibility timer
    if (p.invincibleMs > 0) p.invincibleMs -= dtMs;

    // Horizontal movement
    p.vx = 0;
    if (p.input.left) { p.vx = -MOVE_SPEED; p.dir = -1; }
    if (p.input.right) { p.vx = MOVE_SPEED; p.dir = 1; }

    // Jump
    if (p.input.jump && p.grounded) {
        p.vy = JUMP_VEL;
        p.grounded = false;
    }

    // Gravity
    if (!p.grounded) {
        p.vy += GRAVITY * dt;
    }

    // Move
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    // Clamp to camera bounds
    const minX = state.cameraX + PLAYER_W / 2;
    const maxX = state.cameraX + W - PLAYER_W / 2;
    p.x = Math.max(minX, Math.min(maxX, p.x));

    // Ground collision
    p.grounded = false;
    if (p.y >= GROUND_Y - PLAYER_H) {
        p.y = GROUND_Y - PLAYER_H;
        p.vy = 0;
        p.grounded = true;
    }

    // Platform collision (only when falling)
    if (p.vy >= 0) {
        for (const plat of state.platforms) {
            if (p.x >= plat.x - PLAYER_W / 2 && p.x <= plat.x + plat.w + PLAYER_W / 2 &&
                p.y + PLAYER_H >= plat.y && p.y + PLAYER_H <= plat.y + 8) {
                p.y = plat.y - PLAYER_H;
                p.vy = 0;
                p.grounded = true;
                break;
            }
        }
    }

    // Fire
    p.fireCooldownMs = Math.max(0, p.fireCooldownMs - dtMs);
    if (p.input.fire && p.fireCooldownMs <= 0) {
        firePlayerBullet(state, p);
        p.fireCooldownMs = p.powerup === 'rapid' ? RAPID_COOLDOWN : FIRE_COOLDOWN;
    }

    // Animation
    if (!p.alive) p.anim = 'die';
    else if (!p.grounded) p.anim = p.vy < 0 ? 'jump' : 'fall';
    else if (p.vx !== 0) p.anim = 'run';
    else p.anim = 'idle';
}

function firePlayerBullet(state: GameState, p: Player) {
    // Determine aim direction based on input
    let dx: number = p.dir;
    let dy: number = 0;
    if (p.input.up) dy = -1;
    if (p.input.down && !p.grounded) dy = 1;
    if (p.input.up && !p.input.left && !p.input.right) { dx = 0; dy = -1; }

    const mag = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= mag;
    dy /= mag;

    if (p.powerup === 'spread') {
        // 3-way spread
        const angles = [-0.3, 0, 0.3];
        for (const a of angles) {
            const cos = Math.cos(a);
            const sin = Math.sin(a);
            const rdx = dx * cos - dy * sin;
            const rdy = dx * sin + dy * cos;
            state.bullets.push({
                id: `pb:${state.tick}:${p.id}:${a}`,
                x: p.x + dx * 8, y: p.y + PLAYER_H / 2 + dy * 4,
                vx: rdx * BULLET_SPEED, vy: rdy * BULLET_SPEED,
                owner: 'player', playerId: p.id, ttlMs: 1500,
            });
        }
    } else {
        state.bullets.push({
            id: `pb:${state.tick}:${p.id}`,
            x: p.x + dx * 8, y: p.y + PLAYER_H / 2 + dy * 4,
            vx: dx * BULLET_SPEED, vy: dy * BULLET_SPEED,
            owner: 'player', playerId: p.id, ttlMs: 1500,
        });
    }
}

// ─── Enemy Logic ──────────────────────────────────────────────────────

function startWave(state: GameState, waveNum: number) {
    const idx = Math.min(waveNum - 1, WAVE_CONFIGS.length - 1);
    const cfg = WAVE_CONFIGS[idx];
    state.waveEnemiesLeft = cfg.runners + cfg.shooters + cfg.flyers + (cfg.boss ? 1 : 0);
    state.waveSpawnTimer = 500;
}

function spawnNextEnemy(state: GameState) {
    const waveIdx = Math.min(state.wave - 1, WAVE_CONFIGS.length - 1);
    const cfg = WAVE_CONFIGS[waveIdx];
    const r = seededRandom(state.tick * 97 + state.waveEnemiesLeft * 13);
    const spawnX = state.cameraX + W + 20;
    const spawnY = GROUND_Y - 14;

    // Determine type based on remaining counts
    let type: Enemy['type'] = 'runner';
    if (cfg.boss && state.waveEnemiesLeft === 1) {
        type = 'boss';
    } else if (r < 0.4) {
        type = 'runner';
    } else if (r < 0.7) {
        type = 'shooter';
    } else {
        type = 'flyer';
    }

    const enemy: Enemy = {
        id: `e:${state.wave}:${state.tick}`,
        type,
        x: spawnX,
        y: type === 'flyer' ? 40 + seededRandom(state.tick * 37) * 60 : spawnY,
        vx: 0, vy: 0,
        hp: type === 'boss' ? 30 : type === 'shooter' ? 2 : 1,
        maxHp: type === 'boss' ? 30 : type === 'shooter' ? 2 : 1,
        dir: -1,
        anim: 'idle',
        fireCooldownMs: 1000 + seededRandom(state.tick * 41) * 1000,
        phaseTimer: 0,
        active: true,
    };

    state.enemies.push(enemy);
    state.waveEnemiesLeft -= 1;
}

function updateEnemy(state: GameState, e: Enemy, dt: number, dtMs: number) {
    e.phaseTimer += dtMs;
    e.fireCooldownMs = Math.max(0, e.fireCooldownMs - dtMs);

    // Remove if too far behind camera
    if (e.x < state.cameraX - 40) {
        e.active = false;
        return;
    }

    const closestPlayer = getClosestAlivePlayer(state, e.x, e.y);

    switch (e.type) {
        case 'runner':
            e.vx = -40 - state.wave * 5;
            e.x += e.vx * dt;
            e.anim = 'walk';
            break;

        case 'shooter':
            // Stay in place, shoot at players
            e.anim = 'idle';
            if (e.fireCooldownMs <= 0 && closestPlayer) {
                fireEnemyBullet(state, e, closestPlayer);
                e.fireCooldownMs = 1200 - state.wave * 100;
            }
            // Slowly drift left with camera
            e.x -= state.scrollSpeed * dt * 0.5;
            break;

        case 'flyer':
            e.vx = -30 - state.wave * 5;
            e.x += e.vx * dt;
            e.y += Math.sin(e.phaseTimer / 400) * 40 * dt;
            e.y = Math.max(20, Math.min(GROUND_Y - 30, e.y));
            e.anim = 'fly';
            if (e.fireCooldownMs <= 0 && closestPlayer) {
                fireEnemyBullet(state, e, closestPlayer);
                e.fireCooldownMs = 1500;
            }
            break;

        case 'boss':
            e.x = Math.max(e.x, state.cameraX + W - 60);
            e.x = Math.min(e.x, state.cameraX + W - 30);
            e.y = 30 + Math.sin(e.phaseTimer / 600) * 40;
            e.anim = 'boss';
            if (e.fireCooldownMs <= 0 && closestPlayer) {
                // Boss fires 3 bullets in spread
                for (let a = -0.4; a <= 0.4; a += 0.4) {
                    const dx = closestPlayer.x - e.x;
                    const dy = closestPlayer.y - e.y;
                    const mag = Math.sqrt(dx * dx + dy * dy) || 1;
                    const cos = Math.cos(a);
                    const sin = Math.sin(a);
                    const ndx = (dx / mag) * cos - (dy / mag) * sin;
                    const ndy = (dx / mag) * sin + (dy / mag) * cos;
                    state.bullets.push({
                        id: `eb:${state.tick}:${e.id}:${a}`,
                        x: e.x, y: e.y + 10,
                        vx: ndx * ENEMY_BULLET_SPEED * 1.2,
                        vy: ndy * ENEMY_BULLET_SPEED * 1.2,
                        owner: 'enemy', ttlMs: 3000,
                    });
                }
                e.fireCooldownMs = 600;
            }
            break;
    }
}

function fireEnemyBullet(state: GameState, e: Enemy, target: Player) {
    const dx = target.x - e.x;
    const dy = (target.y + PLAYER_H / 2) - e.y;
    const mag = Math.sqrt(dx * dx + dy * dy) || 1;
    state.bullets.push({
        id: `eb:${state.tick}:${e.id}`,
        x: e.x, y: e.y,
        vx: (dx / mag) * ENEMY_BULLET_SPEED,
        vy: (dy / mag) * ENEMY_BULLET_SPEED,
        owner: 'enemy', ttlMs: 3000,
    });
}

function getClosestAlivePlayer(state: GameState, ex: number, ey: number): Player | null {
    let closest: Player | null = null;
    let closestDist = Infinity;
    for (const p of Object.values(state.players)) {
        if (!p.alive) continue;
        const d = Math.hypot(p.x - ex, p.y - ey);
        if (d < closestDist) { closest = p; closestDist = d; }
    }
    return closest;
}

// ─── Collisions ───────────────────────────────────────────────────────

function checkBulletEnemyCollisions(state: GameState) {
    const keptBullets: Bullet[] = [];
    for (const b of state.bullets) {
        if (b.owner !== 'player') { keptBullets.push(b); continue; }
        let hit = false;
        for (const e of state.enemies) {
            if (!e.active) continue;
            const hitW = e.type === 'boss' ? 20 : 10;
            const hitH = e.type === 'boss' ? 24 : 14;
            if (b.x > e.x - hitW / 2 && b.x < e.x + hitW / 2 &&
                b.y > e.y - hitH / 2 && b.y < e.y + hitH / 2) {
                e.hp -= 1;
                if (e.hp <= 0) {
                    e.active = false;
                    state.score += e.type === 'boss' ? 500 : e.type === 'shooter' ? 200 : e.type === 'flyer' ? 150 : 100;
                    state.explosions.push({ x: e.x, y: e.y, ttlMs: 400, radius: e.type === 'boss' ? 30 : 15 });
                    // Chance to drop pickup
                    if (seededRandom(state.tick * 71 + e.hp) < 0.25) {
                        const types: Pickup['type'][] = ['spread', 'rapid', 'life'];
                        const t = types[Math.floor(seededRandom(state.tick * 53) * types.length)];
                        state.pickups.push({ id: `pu:${state.tick}`, x: e.x, y: e.y, type: t });
                    }
                }
                hit = true;
                break;
            }
        }
        if (!hit) keptBullets.push(b);
    }
    state.bullets = keptBullets;
}

function checkBulletPlayerCollisions(state: GameState) {
    const keptBullets: Bullet[] = [];
    for (const b of state.bullets) {
        if (b.owner !== 'enemy') { keptBullets.push(b); continue; }
        let hit = false;
        for (const p of Object.values(state.players)) {
            if (!p.alive || p.invincibleMs > 0) continue;
            if (b.x > p.x - PLAYER_W / 2 && b.x < p.x + PLAYER_W / 2 &&
                b.y > p.y && b.y < p.y + PLAYER_H) {
                hitPlayer(state, p);
                hit = true;
                break;
            }
        }
        if (!hit) keptBullets.push(b);
    }
    state.bullets = keptBullets;
}

function checkPlayerEnemyCollisions(state: GameState) {
    for (const p of Object.values(state.players)) {
        if (!p.alive || p.invincibleMs > 0) continue;
        for (const e of state.enemies) {
            if (!e.active) continue;
            const hitDist = e.type === 'boss' ? 18 : 12;
            if (Math.hypot(p.x - e.x, (p.y + PLAYER_H / 2) - e.y) < hitDist) {
                hitPlayer(state, p);
                break;
            }
        }
    }
}

function hitPlayer(state: GameState, p: Player) {
    p.hp -= 1;
    p.powerup = null;
    if (p.hp <= 0) {
        p.alive = false;
        p.anim = 'die';
        state.explosions.push({ x: p.x, y: p.y, ttlMs: 500, radius: 12 });
    } else {
        p.invincibleMs = INVINCIBLE_MS;
        // Respawn at safe position
        p.x = state.cameraX + 40;
        p.y = GROUND_Y - PLAYER_H - 30;
        p.vy = 0;
    }
}

function checkPickupCollisions(state: GameState) {
    const kept: Pickup[] = [];
    for (const pu of state.pickups) {
        let collected = false;
        for (const p of Object.values(state.players)) {
            if (!p.alive) continue;
            if (Math.hypot(p.x - pu.x, (p.y + PLAYER_H / 2) - pu.y) < 14) {
                if (pu.type === 'life') {
                    p.hp = Math.min(MAX_LIVES, p.hp + 1);
                } else {
                    p.powerup = pu.type;
                }
                state.score += 50;
                collected = true;
                break;
            }
        }
        if (!collected) kept.push(pu);
    }
    state.pickups = kept;
}

// ─── Terminal Check ───────────────────────────────────────────────────

export function isTerminal(state: GameState): boolean {
    return state.phase === 'game_over';
}

// ─── Network Serialization ────────────────────────────────────────────

export function toNetworkState(state: GameState) {
    const players: Record<string, any> = {};
    for (const [id, p] of Object.entries(state.players)) {
        players[id] = {
            id: p.id, x: r(p.x), y: r(p.y), vx: r(p.vx), vy: r(p.vy),
            dir: p.dir, grounded: p.grounded, hp: p.hp, alive: p.alive,
            invincibleMs: p.invincibleMs, powerup: p.powerup, anim: p.anim,
        };
    }
    return {
        phase: state.phase, tick: state.tick, cameraX: r(state.cameraX),
        countdownMs: state.countdownMs,
        players,
        enemies: state.enemies.filter(e => e.active).map(e => ({
            id: e.id, type: e.type, x: r(e.x), y: r(e.y), hp: e.hp, maxHp: e.maxHp,
            dir: e.dir, anim: e.anim,
        })),
        bullets: state.bullets.map(b => ({
            id: b.id, x: r(b.x), y: r(b.y), vx: r(b.vx), vy: r(b.vy), owner: b.owner,
        })),
        pickups: state.pickups,
        platforms: state.platforms.map(p => ({ x: r(p.x), y: r(p.y), w: r(p.w) })),
        explosions: state.explosions.map(e => ({ x: r(e.x), y: r(e.y), ttlMs: e.ttlMs, radius: e.radius })),
        score: state.score, wave: state.wave,
    };
}

function r(v: number): number {
    return Math.round(v * 10) / 10;
}
