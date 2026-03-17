"use client";

/**
 * Contra P2P — Main Game Page
 *
 * Orchestrates:
 * - Usion SDK initialization (detects host vs guest)
 * - P2P WebRTC connection via signaling.ts
 * - Host: runs game engine, broadcasts state
 * - Guest: sends input, receives state, renders
 * - Keyboard + touch input
 * - Canvas rendering via renderer.ts
 *
 * Reference implementation for Usion P2P game developers.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { initState, applyInput, tick, toNetworkState, isTerminal, W, H } from "./game-engine";
import type { GameState, PlayerInput } from "./game-engine";
import { setupP2PConnection } from "./signaling";
import type { WebRTCManager, P2PMessage } from "./webrtc-manager";
import { render } from "./renderer";

declare global { interface Window { Usion?: any } }

type Role = 'host' | 'guest';
type Phase = 'loading' | 'waiting' | 'connecting' | 'playing' | 'disconnected';

const TICK_MS = 33; // ~30Hz
const STATE_BROADCAST_MS = 33; // 30Hz state broadcast

export default function ContraPage() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [phase, setPhase] = useState<Phase>('loading');
    const [statusText, setStatusText] = useState('Initializing...');

    // Refs for game state (avoid re-renders)
    const roleRef = useRef<Role>('guest');
    const myIdRef = useRef<string>('');
    const playerIdsRef = useRef<string[]>([]);
    const rtcRef = useRef<WebRTCManager | null>(null);
    const gameStateRef = useRef<GameState | null>(null);
    const networkStateRef = useRef<any>(null);
    const keysRef = useRef<PlayerInput>({
        left: false, right: false, up: false, down: false, jump: false, fire: false,
    });
    const connectionInfoRef = useRef({ transport: 'P2P', rttMs: 0 });
    const p2pStartedRef = useRef(false);
    const tickHandleRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const rafRef = useRef<number>(0);
    const lastTickRef = useRef<number>(0);

    // ─── SDK Initialization ───────────────────────────────────────────

    useEffect(() => {
        const usion = window.Usion;
        if (!usion) {
            setStatusText('Usion SDK not found');
            return;
        }

        usion.init((config: any) => {
            const userId = usion.user?.getId?.() || config.userId || 'unknown';
            const roomId = config.roomId;
            const initHostId = config.hostId || config.host_id;
            const initPlayerIds = config.playerIds || config.player_ids || [];

            myIdRef.current = userId;
            playerIdsRef.current = initPlayerIds;

            console.log(`[CONTRA] Init: userId=${userId}, hostId=${initHostId}, players=${initPlayerIds.length}`);

            setPhase('waiting');
            setStatusText('Connecting...');

            // Connect to platform (Socket.IO) for signaling
            usion.game.connect()
                .then(() => usion.game.join(roomId))
                .then((joinData: any) => {
                    // Get host_id from join response (backend sends it)
                    // Fall back to INIT config hostId
                    const hostId = joinData?.host_id || initHostId;
                    const joinPlayerIds = joinData?.player_ids || initPlayerIds;

                    if (joinPlayerIds.length > 0) {
                        playerIdsRef.current = joinPlayerIds;
                    }

                    // Determine role: room creator is host
                    // Fallback: if no hostId available, first player in list is host
                    const isHost = hostId
                        ? userId === hostId
                        : (playerIdsRef.current.length > 0 && userId === playerIdsRef.current[0]);
                    roleRef.current = isHost ? 'host' : 'guest';

                    console.log(`[CONTRA] Role: ${roleRef.current}, userId: ${userId}, hostId: ${hostId}`);

                    setStatusText(isHost
                        ? 'Waiting for player 2 to join...'
                        : 'Connecting to host...');

                    // Listen for opponent joining the socket room
                    usion.game.onPlayerJoined((data: any) => {
                        if (data?.player_ids) {
                            playerIdsRef.current = data.player_ids;
                        }
                        if (!hostId && data?.host_id) {
                            const eventIsHost = userId === data.host_id;
                            roleRef.current = eventIsHost ? 'host' : 'guest';
                            console.log(`[CONTRA] Role updated from event: ${roleRef.current}`);
                        }
                        console.log('[CONTRA] Player joined socket room, starting P2P');
                        startP2PConnection();
                    });

                    // Only start P2P if the other player is ALREADY connected
                    // to the socket room (connected_count reflects live sockets,
                    // not just MongoDB membership). This avoids sending an offer
                    // before the guest has joined the socket room to receive it.
                    const connectedCount = joinData?.connected_count || 0;
                    console.log(`[CONTRA] Connected count: ${connectedCount}`);
                    if (connectedCount >= 2) {
                        startP2PConnection();
                    }
                })
                .catch((err: Error) => {
                    console.error('[CONTRA] Connect error:', err);
                    setStatusText('Connection failed');
                });
        });

        return () => {
            if (tickHandleRef.current) clearInterval(tickHandleRef.current);
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            rtcRef.current?.destroy();
        };
    }, []);

    // ─── P2P Connection ───────────────────────────────────────────────

    const startP2PConnection = useCallback(async () => {
        if (p2pStartedRef.current) {
            console.log('[CONTRA] P2P already started, skipping');
            return;
        }
        p2pStartedRef.current = true;
        setPhase('connecting');
        setStatusText('Establishing P2P connection...');

        try {
            const rtc = await setupP2PConnection({
                role: roleRef.current,
                onMessage: handleP2PMessage,
                onState: (state) => {
                    console.log(`[CONTRA] P2P state: ${state}`);
                    if (state === 'connected') {
                        connectionInfoRef.current.transport = 'P2P';
                        onP2PConnected();
                    } else if (state === 'disconnected' || state === 'failed') {
                        setPhase('disconnected');
                        setStatusText('Connection lost');
                    }
                },
                onLog: (msg) => console.log(`[SIGNAL] ${msg}`),
            });

            rtcRef.current = rtc;
        } catch (err) {
            console.error('[CONTRA] P2P setup failed:', err);
            p2pStartedRef.current = false; // Allow retry
            setStatusText('P2P connection failed');
            setPhase('disconnected');
        }
    }, []);

    // ─── P2P Connected — Start Game ───────────────────────────────────

    const onP2PConnected = useCallback(() => {
        setPhase('playing');
        setStatusText('');

        if (roleRef.current === 'host') {
            // Host: initialize game state and start game loop
            const ids = playerIdsRef.current.length >= 2
                ? playerIdsRef.current.slice(0, 2)
                : [myIdRef.current, 'guest'];
            gameStateRef.current = initState(ids);

            // Send initial player IDs to guest
            rtcRef.current?.send({ type: 'init', playerIds: ids });

            lastTickRef.current = performance.now();
            tickHandleRef.current = setInterval(hostTick, TICK_MS);
        }

        // Start render loop
        renderLoop();
    }, []);

    // ─── Host Game Loop ───────────────────────────────────────────────

    const hostTick = useCallback(() => {
        if (!gameStateRef.current || roleRef.current !== 'host') return;

        const now = performance.now();
        const dt = Math.min(now - lastTickRef.current, TICK_MS * 2);
        lastTickRef.current = now;

        // Apply host's own input
        applyInput(gameStateRef.current, myIdRef.current, keysRef.current);

        // Advance simulation
        tick(gameStateRef.current, dt);

        // Broadcast state to guest
        const ns = toNetworkState(gameStateRef.current);
        networkStateRef.current = ns;
        rtcRef.current?.send({ type: 'state', ...ns });

        // Check game over
        if (isTerminal(gameStateRef.current)) {
            if (tickHandleRef.current) clearInterval(tickHandleRef.current);
            tickHandleRef.current = null;
        }
    }, []);

    // ─── Handle P2P Messages ──────────────────────────────────────────

    const handleP2PMessage = useCallback((msg: P2PMessage) => {
        if (roleRef.current === 'host') {
            // Host receives guest's input
            if (msg.type === 'input') {
                if (gameStateRef.current) {
                    // Find the guest player in game state (not playerIdsRef,
                    // which may have the real ID while state uses fallback 'guest')
                    const guestId = Object.keys(gameStateRef.current.players).find(
                        id => id !== myIdRef.current
                    );
                    if (guestId) {
                        applyInput(gameStateRef.current, guestId, msg.keys);
                    }
                }
            }
        } else {
            // Guest receives game state from host
            if (msg.type === 'state') {
                networkStateRef.current = msg;
            } else if (msg.type === 'init') {
                playerIdsRef.current = msg.playerIds;
            }
        }
    }, []);

    // ─── Render Loop ──────────────────────────────────────────────────

    const renderLoop = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) { rafRef.current = requestAnimationFrame(renderLoop); return; }
        const ctx = canvas.getContext('2d');
        if (!ctx) { rafRef.current = requestAnimationFrame(renderLoop); return; }

        // Update RTT
        if (rtcRef.current) {
            connectionInfoRef.current.rttMs = rtcRef.current.rttMs;
        }

        // Render current state
        const state = roleRef.current === 'host'
            ? (gameStateRef.current ? toNetworkState(gameStateRef.current) : null)
            : networkStateRef.current;

        render(ctx, canvas.width, canvas.height, state, myIdRef.current, connectionInfoRef.current);

        rafRef.current = requestAnimationFrame(renderLoop);
    }, []);

    // ─── Guest Input Sender ───────────────────────────────────────────

    useEffect(() => {
        if (roleRef.current !== 'guest') return;

        const interval = setInterval(() => {
            if (rtcRef.current?.connected) {
                rtcRef.current.send({ type: 'input', keys: { ...keysRef.current } });
            }
        }, TICK_MS);

        return () => clearInterval(interval);
    }, [phase]);

    // ─── Keyboard Input ───────────────────────────────────────────────

    useEffect(() => {
        const keyMap: Record<string, keyof PlayerInput> = {
            ArrowLeft: 'left', KeyA: 'left',
            ArrowRight: 'right', KeyD: 'right',
            ArrowUp: 'up', KeyW: 'up',
            ArrowDown: 'down', KeyS: 'down',
            Space: 'jump',
            KeyZ: 'fire', KeyJ: 'fire', Enter: 'fire',
        };

        const onKey = (e: KeyboardEvent, down: boolean) => {
            const mapped = keyMap[e.code];
            if (mapped) {
                e.preventDefault();
                keysRef.current[mapped] = down;
            }
        };

        const onDown = (e: KeyboardEvent) => onKey(e, true);
        const onUp = (e: KeyboardEvent) => onKey(e, false);

        window.addEventListener('keydown', onDown);
        window.addEventListener('keyup', onUp);
        return () => {
            window.removeEventListener('keydown', onDown);
            window.removeEventListener('keyup', onUp);
        };
    }, []);

    // ─── Canvas Resize ────────────────────────────────────────────────

    useEffect(() => {
        const resize = () => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        };
        resize();
        window.addEventListener('resize', resize);
        return () => window.removeEventListener('resize', resize);
    }, []);

    // ─── Touch Controls ───────────────────────────────────────────────

    const handleTouchStart = useCallback((e: React.TouchEvent) => {
        e.preventDefault();
        updateTouches(e.touches);
    }, []);

    const handleTouchMove = useCallback((e: React.TouchEvent) => {
        e.preventDefault();
        updateTouches(e.touches);
    }, []);

    const handleTouchEnd = useCallback((e: React.TouchEvent) => {
        e.preventDefault();
        updateTouches(e.touches);
    }, []);

    const updateTouches = useCallback((touches: React.TouchList | TouchList) => {
        const w = window.innerWidth;
        const h = window.innerHeight;

        // Reset all inputs
        keysRef.current = { left: false, right: false, up: false, down: false, jump: false, fire: false };

        for (let i = 0; i < touches.length; i++) {
            const t = touches[i];
            const x = t.clientX / w;
            const y = t.clientY / h;

            if (x < 0.5) {
                // Left half: D-pad
                const centerX = 0.15;
                const centerY = 0.75;
                const dx = x - centerX;
                const dy = y - centerY;

                if (Math.abs(dx) > 0.04) {
                    if (dx < 0) keysRef.current.left = true;
                    else keysRef.current.right = true;
                }
                if (dy < -0.06) keysRef.current.up = true;
                if (dy > 0.06) keysRef.current.down = true;

                // Jump: top-left area
                if (y < 0.5) keysRef.current.jump = true;
            } else {
                // Right half: fire button
                keysRef.current.fire = true;
                // Jump if touching upper right
                if (y < 0.4) keysRef.current.jump = true;
            }
        }
    }, []);

    // ─── Render ───────────────────────────────────────────────────────

    return (
        <div style={{
            width: '100vw', height: '100dvh', overflow: 'hidden',
            background: '#000', position: 'relative', touchAction: 'none',
        }}>
            <canvas
                ref={canvasRef}
                style={{ display: 'block', width: '100%', height: '100%' }}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
            />

            {/* Status overlay */}
            {phase !== 'playing' && (
                <div style={{
                    position: 'absolute', inset: 0,
                    display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center',
                    background: 'rgba(0,0,0,0.8)', color: '#fff',
                    fontFamily: 'monospace',
                }}>
                    <div style={{ fontSize: 24, fontWeight: 'bold', marginBottom: 12 }}>
                        CONTRA CO-OP
                    </div>
                    <div style={{ fontSize: 14, opacity: 0.8 }}>
                        {statusText}
                    </div>
                    {phase === 'loading' && (
                        <div style={{ fontSize: 10, opacity: 0.5, marginTop: 20 }}>
                            P2P WebRTC — No server required
                        </div>
                    )}
                    {phase === 'waiting' && (
                        <div style={{ fontSize: 10, opacity: 0.5, marginTop: 20 }}>
                            Role: {roleRef.current.toUpperCase()}
                        </div>
                    )}
                </div>
            )}

            {/* Touch control hints (mobile) */}
            {phase === 'playing' && (
                <>
                    {/* Left: D-pad zone hint */}
                    <div style={{
                        position: 'absolute', left: 10, bottom: 10,
                        width: 80, height: 80, borderRadius: '50%',
                        border: '1px solid rgba(255,255,255,0.15)',
                        pointerEvents: 'none',
                    }} />
                    {/* Right: Fire zone hint */}
                    <div style={{
                        position: 'absolute', right: 20, bottom: 20,
                        width: 50, height: 50, borderRadius: '50%',
                        border: '1px solid rgba(255,255,255,0.15)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: 'rgba(255,255,255,0.2)', fontSize: 10,
                        fontFamily: 'monospace', pointerEvents: 'none',
                    }}>
                        FIRE
                    </div>
                </>
            )}
        </div>
    );
}
