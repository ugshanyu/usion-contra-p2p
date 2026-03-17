/**
 * Contra P2P — Canvas Renderer
 *
 * Renders the game state to a 2D canvas with:
 * - Parallax scrolling background (sky, mountains, ground)
 * - Player sprites (geometric, color-coded)
 * - Enemy sprites (per type)
 * - Bullets, pickups, explosions
 * - HUD overlay (lives, score, wave, connection info)
 */

import { W, H } from './game-engine';

// ─── Colors ───────────────────────────────────────────────────────────

const COLORS = {
    sky: '#1a1a2e',
    mountains: '#16213e',
    ground: '#2d4a22',
    groundLine: '#3d6a32',
    platform: '#5a3d2b',
    platformTop: '#7a5d4b',
    player1: '#e74c3c',
    player2: '#3498db',
    playerOutline: '#fff',
    runner: '#e67e22',
    shooter: '#8e44ad',
    flyer: '#1abc9c',
    boss: '#c0392b',
    bossOutline: '#e74c3c',
    playerBullet: '#f1c40f',
    enemyBullet: '#e74c3c',
    pickup_spread: '#e74c3c',
    pickup_rapid: '#f39c12',
    pickup_life: '#2ecc71',
    explosion: '#ff6b35',
    hud: '#fff',
    hudBg: 'rgba(0,0,0,0.6)',
    star: '#ffffff44',
};

// ─── Stars (parallax layer 0) ─────────────────────────────────────────

const stars: Array<{ x: number; y: number; size: number }> = [];
for (let i = 0; i < 60; i++) {
    stars.push({
        x: Math.random() * W * 3,
        y: Math.random() * H * 0.6,
        size: 0.5 + Math.random() * 1,
    });
}

// ─── Render ───────────────────────────────────────────────────────────

export function render(
    ctx: CanvasRenderingContext2D,
    canvasW: number,
    canvasH: number,
    state: any,
    myId: string,
    connectionInfo: { transport: string; rttMs: number },
) {
    if (!state) return;

    // Scale canvas to fit game resolution
    const scaleX = canvasW / W;
    const scaleY = canvasH / H;
    const scale = Math.min(scaleX, scaleY);
    const offsetX = (canvasW - W * scale) / 2;
    const offsetY = (canvasH - H * scale) / 2;

    ctx.clearRect(0, 0, canvasW, canvasH);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvasW, canvasH);

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    const camX = state.cameraX || 0;

    // Background layers
    drawSky(ctx, camX);
    drawMountains(ctx, camX);
    drawGround(ctx, camX);

    // Game world (camera-relative)
    ctx.save();
    ctx.translate(-camX, 0);

    // Platforms
    drawPlatforms(ctx, state.platforms || []);

    // Pickups
    for (const pu of (state.pickups || [])) {
        drawPickup(ctx, pu);
    }

    // Enemies
    for (const e of (state.enemies || [])) {
        drawEnemy(ctx, e);
    }

    // Bullets
    for (const b of (state.bullets || [])) {
        drawBullet(ctx, b);
    }

    // Explosions
    for (const ex of (state.explosions || [])) {
        drawExplosion(ctx, ex);
    }

    // Players
    const playerIds = Object.keys(state.players || {});
    for (const pid of playerIds) {
        const p = state.players[pid];
        const color = pid === playerIds[0] ? COLORS.player1 : COLORS.player2;
        drawPlayer(ctx, p, color, state.tick);
    }

    ctx.restore(); // end camera transform

    // HUD
    drawHUD(ctx, state, myId, connectionInfo, playerIds);

    // Countdown overlay
    if (state.phase === 'countdown') {
        drawCountdown(ctx, state.countdownMs);
    }

    // Wave clear overlay
    if (state.phase === 'wave_clear') {
        drawWaveClear(ctx, state.wave);
    }

    // Game over overlay
    if (state.phase === 'game_over') {
        drawGameOver(ctx, state.score, state.wave);
    }

    ctx.restore(); // end scale transform
}

// ─── Background Layers ────────────────────────────────────────────────

function drawSky(ctx: CanvasRenderingContext2D, camX: number) {
    ctx.fillStyle = COLORS.sky;
    ctx.fillRect(0, 0, W, H);

    // Stars (slowest parallax)
    ctx.fillStyle = COLORS.star;
    for (const s of stars) {
        const sx = ((s.x - camX * 0.05) % (W * 3) + W * 3) % (W * 3) - W;
        if (sx >= -2 && sx <= W + 2) {
            ctx.beginPath();
            ctx.arc(sx, s.y, s.size, 0, Math.PI * 2);
            ctx.fill();
        }
    }
}

function drawMountains(ctx: CanvasRenderingContext2D, camX: number) {
    ctx.fillStyle = COLORS.mountains;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 4) {
        const worldX = x + camX * 0.15;
        const y = 100 + Math.sin(worldX * 0.008) * 25 + Math.sin(worldX * 0.015) * 15;
        ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
}

function drawGround(ctx: CanvasRenderingContext2D, camX: number) {
    ctx.fillStyle = COLORS.ground;
    ctx.fillRect(0, 155, W, H - 155);
    ctx.fillStyle = COLORS.groundLine;
    ctx.fillRect(0, 155, W, 2);
}

function drawPlatforms(ctx: CanvasRenderingContext2D, platforms: any[]) {
    for (const p of platforms) {
        ctx.fillStyle = COLORS.platform;
        ctx.fillRect(p.x, p.y, p.w, 6);
        ctx.fillStyle = COLORS.platformTop;
        ctx.fillRect(p.x, p.y, p.w, 2);
    }
}

// ─── Player ───────────────────────────────────────────────────────────

function drawPlayer(ctx: CanvasRenderingContext2D, p: any, color: string, tick: number) {
    if (!p.alive) return;

    // Blink when invincible
    if (p.invincibleMs > 0 && Math.floor(tick / 3) % 2 === 0) return;

    const x = p.x;
    const y = p.y;

    // Body
    ctx.fillStyle = color;
    ctx.fillRect(x - 4, y + 2, 8, 12);

    // Head
    ctx.fillStyle = color;
    ctx.fillRect(x - 3, y - 2, 6, 5);

    // Direction indicator (gun arm)
    ctx.fillStyle = COLORS.playerOutline;
    const gunX = p.dir === 1 ? x + 4 : x - 6;
    ctx.fillRect(gunX, y + 4, 5, 2);

    // Legs animation
    if (p.anim === 'run') {
        const legOffset = Math.sin(tick * 0.3) * 2;
        ctx.fillRect(x - 3, y + 14, 2, 2 + legOffset);
        ctx.fillRect(x + 1, y + 14, 2, 2 - legOffset);
    } else {
        ctx.fillRect(x - 3, y + 14, 2, 2);
        ctx.fillRect(x + 1, y + 14, 2, 2);
    }

    // Powerup indicator
    if (p.powerup) {
        ctx.fillStyle = p.powerup === 'spread' ? COLORS.pickup_spread : COLORS.pickup_rapid;
        ctx.fillRect(x - 1, y - 4, 2, 2);
    }
}

// ─── Enemy ────────────────────────────────────────────────────────────

function drawEnemy(ctx: CanvasRenderingContext2D, e: any) {
    const colorMap: Record<string, string> = {
        runner: COLORS.runner,
        shooter: COLORS.shooter,
        flyer: COLORS.flyer,
        boss: COLORS.boss,
    };
    const color = colorMap[e.type] || COLORS.runner;

    if (e.type === 'boss') {
        // Boss: large rectangle with health bar
        ctx.fillStyle = COLORS.bossOutline;
        ctx.fillRect(e.x - 12, e.y - 14, 24, 28);
        ctx.fillStyle = color;
        ctx.fillRect(e.x - 10, e.y - 12, 20, 24);

        // Boss eyes
        ctx.fillStyle = '#fff';
        ctx.fillRect(e.x - 6, e.y - 6, 4, 4);
        ctx.fillRect(e.x + 2, e.y - 6, 4, 4);
        ctx.fillStyle = '#000';
        ctx.fillRect(e.x - 5, e.y - 5, 2, 2);
        ctx.fillRect(e.x + 3, e.y - 5, 2, 2);

        // Health bar
        const hpPct = e.hp / e.maxHp;
        ctx.fillStyle = '#333';
        ctx.fillRect(e.x - 12, e.y - 18, 24, 3);
        ctx.fillStyle = hpPct > 0.5 ? '#2ecc71' : hpPct > 0.25 ? '#f39c12' : '#e74c3c';
        ctx.fillRect(e.x - 12, e.y - 18, 24 * hpPct, 3);
    } else if (e.type === 'flyer') {
        // Flyer: diamond shape
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(e.x, e.y - 6);
        ctx.lineTo(e.x + 8, e.y);
        ctx.lineTo(e.x, e.y + 6);
        ctx.lineTo(e.x - 8, e.y);
        ctx.closePath();
        ctx.fill();
    } else if (e.type === 'shooter') {
        // Shooter: rectangle with "turret"
        ctx.fillStyle = color;
        ctx.fillRect(e.x - 5, e.y - 5, 10, 14);
        ctx.fillStyle = '#fff';
        ctx.fillRect(e.x - 7, e.y - 2, 3, 4);
    } else {
        // Runner: simple rectangle
        ctx.fillStyle = color;
        ctx.fillRect(e.x - 4, e.y - 5, 8, 14);
        // Eyes
        ctx.fillStyle = '#fff';
        ctx.fillRect(e.x - 2, e.y - 3, 2, 2);
    }
}

// ─── Bullets ──────────────────────────────────────────────────────────

function drawBullet(ctx: CanvasRenderingContext2D, b: any) {
    ctx.fillStyle = b.owner === 'player' ? COLORS.playerBullet : COLORS.enemyBullet;
    const size = b.owner === 'player' ? 2 : 2.5;
    ctx.beginPath();
    ctx.arc(b.x, b.y, size, 0, Math.PI * 2);
    ctx.fill();
}

// ─── Pickups ──────────────────────────────────────────────────────────

function drawPickup(ctx: CanvasRenderingContext2D, pu: any) {
    const colorKey = `pickup_${pu.type}` as keyof typeof COLORS;
    ctx.fillStyle = (COLORS as any)[colorKey] || '#fff';
    ctx.fillRect(pu.x - 4, pu.y - 4, 8, 8);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(pu.x - 4, pu.y - 4, 8, 8);

    // Letter
    ctx.fillStyle = '#fff';
    ctx.font = '6px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(pu.type[0].toUpperCase(), pu.x, pu.y + 2);
}

// ─── Explosions ───────────────────────────────────────────────────────

function drawExplosion(ctx: CanvasRenderingContext2D, ex: any) {
    const alpha = Math.max(0, ex.ttlMs / 400);
    const r = ex.radius * (1 - alpha * 0.3);

    ctx.beginPath();
    ctx.arc(ex.x, ex.y, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 107, 53, ${alpha * 0.6})`;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(ex.x, ex.y, r * 0.5, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 200, 50, ${alpha * 0.8})`;
    ctx.fill();
}

// ─── HUD ──────────────────────────────────────────────────────────────

function drawHUD(
    ctx: CanvasRenderingContext2D,
    state: any,
    myId: string,
    connectionInfo: { transport: string; rttMs: number },
    playerIds: string[],
) {
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';

    // Score
    ctx.fillStyle = COLORS.hudBg;
    ctx.fillRect(W / 2 - 30, 2, 60, 12);
    ctx.fillStyle = COLORS.hud;
    ctx.textAlign = 'center';
    ctx.fillText(`SCORE ${state.score}`, W / 2, 10);

    // Wave
    ctx.fillStyle = COLORS.hudBg;
    ctx.fillRect(W / 2 - 25, 15, 50, 10);
    ctx.fillStyle = COLORS.hud;
    ctx.fillText(`WAVE ${state.wave}`, W / 2, 23);

    // Player lives
    ctx.textAlign = 'left';
    for (let i = 0; i < playerIds.length; i++) {
        const p = state.players[playerIds[i]];
        const color = i === 0 ? COLORS.player1 : COLORS.player2;
        const y = 6 + i * 12;
        const label = playerIds[i] === myId ? 'YOU' : 'P' + (i + 1);

        ctx.fillStyle = COLORS.hudBg;
        ctx.fillRect(2, y - 5, 55, 10);
        ctx.fillStyle = color;
        ctx.fillText(`${label}`, 4, y + 2);

        // Hearts
        for (let h = 0; h < (p?.hp || 0); h++) {
            ctx.fillStyle = '#e74c3c';
            ctx.fillText('♥', 28 + h * 8, y + 2);
        }

        if (p?.powerup) {
            ctx.fillStyle = p.powerup === 'spread' ? COLORS.pickup_spread : COLORS.pickup_rapid;
            ctx.fillText(p.powerup[0].toUpperCase(), 52, y + 2);
        }
    }

    // Connection badge
    ctx.textAlign = 'right';
    const badgeColor = connectionInfo.transport === 'P2P' ? '#2ecc71' : '#f39c12';
    ctx.fillStyle = COLORS.hudBg;
    ctx.fillRect(W - 65, 2, 63, 10);
    ctx.fillStyle = badgeColor;
    ctx.fillText(`${connectionInfo.transport} ${Math.round(connectionInfo.rttMs)}ms`, W - 4, 10);
}

// ─── Overlays ─────────────────────────────────────────────────────────

function drawCountdown(ctx: CanvasRenderingContext2D, ms: number) {
    const seconds = Math.ceil(ms / 1000);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 32px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(seconds > 0 ? String(seconds) : 'GO!', W / 2, H / 2 + 8);

    ctx.font = '10px monospace';
    ctx.fillText('CONTRA CO-OP', W / 2, H / 2 - 25);
}

function drawWaveClear(ctx: CanvasRenderingContext2D, wave: number) {
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#2ecc71';
    ctx.font = 'bold 16px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`WAVE ${wave} CLEAR!`, W / 2, H / 2);
    ctx.font = '8px monospace';
    ctx.fillStyle = '#fff';
    ctx.fillText('Next wave incoming...', W / 2, H / 2 + 16);
}

function drawGameOver(ctx: CanvasRenderingContext2D, score: number, wave: number) {
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, 0, W, H);

    const victory = wave > 3; // Completed all waves
    ctx.fillStyle = victory ? '#f1c40f' : '#e74c3c';
    ctx.font = 'bold 20px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(victory ? 'VICTORY!' : 'GAME OVER', W / 2, H / 2 - 10);

    ctx.fillStyle = '#fff';
    ctx.font = '10px monospace';
    ctx.fillText(`Score: ${score}  Wave: ${wave}`, W / 2, H / 2 + 12);
}
