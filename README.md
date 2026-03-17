# Contra Co-op — Usion P2P WebRTC Reference

2-player co-op side-scrolling shooter using **browser-to-browser WebRTC**. No game server needed — one player's browser hosts the game, the other connects directly via DataChannel.

This is the **P2P reference implementation** for building games on the [Usion](https://usion.mn) platform.

## The 3 Usion Game Connectivity Modes

| Mode | Transport | Server | Example | Cost |
|------|-----------|--------|---------|------|
| Platform | Socket.IO via Usion backend | None (backend relays) | Tic-Tac-Toe | Free |
| Direct Server | WebRTC to game server | Developer-hosted (Railway, etc.) | [Pong](https://github.com/ugshanyu/usion-pong-webrtc) | Hosting |
| **P2P Direct** | **WebRTC browser-to-browser** | **None** | **This game** | **Free** |

## Quick Start

```bash
npm install
npm run dev    # http://localhost:3012
```

## Architecture

```
Player A (Host)              Usion Backend              Player B (Guest)
     |                            |                          |
     |-- create room ------------>|                          |
     |                            |<-- join room ------------|
     |                            |                          |
     |--- SDP offer (Socket.IO) ->|-> relay to B ----------->|
     |<-- SDP answer (Socket.IO) -|<- relay from B ----------|
     |--- ICE candidates -------->|-> relay ----------------->|
     |<-- ICE candidates ---------|<- relay ------------------|
     |                            |                          |
     |<========= WebRTC DataChannel (UDP-like) ==============>|
     |                            |                          |
     |  Host runs game engine     |  (out of the loop)       |  Guest sends input
     |  Broadcasts state @ 30Hz   |                          |  Renders received state
```

After the signaling handshake, the Usion backend is **completely out of the loop**. Game data flows directly between the two browsers.

## How It Works

### 1. Role Detection

When two players join a room, the Usion SDK provides `host_id`. The player who created the room is the host:

```typescript
const isHost = userId === hostId;
roleRef.current = isHost ? 'host' : 'guest';
```

### 2. Signaling via Platform (`signaling.ts`)

The SDK's `game.realtime('signal', data)` sends messages through the Usion backend's Socket.IO relay. This is used **only for the initial WebRTC handshake** — SDP offers/answers and ICE candidates:

```typescript
// Host sends offer
usion.game.realtime('signal', { type: 'webrtc_offer', sdp: offer });

// Guest sends answer
usion.game.realtime('signal', { type: 'webrtc_answer', sdp: answer });

// Both send ICE candidates
usion.game.realtime('signal', { type: 'ice_candidate', candidate });
```

### 3. WebRTC DataChannel (`webrtc-manager.ts`)

Once the handshake completes, a DataChannel opens with **UDP-like semantics**:

```typescript
this.dc = this.pc.createDataChannel('game', {
    ordered: false,      // Don't wait for order
    maxRetransmits: 0,   // Don't retransmit lost packets
});
```

This means: if a packet is lost, skip it and use the next one. Perfect for 30Hz game state updates where old state is irrelevant.

### 4. Host Game Loop

The host's browser runs the game engine at 30Hz:

```
Every 33ms:
  1. Apply host's local input
  2. Apply guest's latest received input
  3. tick(state, dt)  — physics, enemies, collisions
  4. Broadcast toNetworkState(state) over DataChannel
```

### 5. Guest Rendering

The guest receives state snapshots and renders them immediately. The guest only sends input — it has no game logic:

```
Guest loop:
  1. Capture keyboard/touch input
  2. Send { type: 'input', keys: {...} } over DataChannel
  3. Receive { type: 'state', ... } from host
  4. Render received state
```

## Game Design

### Mechanics
- **Side-scrolling** auto-camera with parallax backgrounds
- **Co-op** — two players fight enemies together
- **3 lives each** — game over when both players are out
- **3 waves** of enemies, final wave has a boss
- **Power-ups** — Spread Shot (S), Rapid Fire (R), Extra Life (L)
- **8-directional shooting** — aim with arrow keys

### Enemy Types
| Type | Behavior | HP | Points |
|------|----------|-----|--------|
| Runner | Charges left toward players | 1 | 100 |
| Shooter | Stationary, fires at closest player | 2 | 200 |
| Flyer | Sine-wave flight, drops bombs | 1 | 150 |
| Boss | Moves in patterns, fires spreads | 30 | 500 |

### Controls

**Keyboard:**
| Key | Action |
|-----|--------|
| Arrow keys / WASD | Move + Aim direction |
| Space | Jump |
| Z / J / Enter | Fire |

**Touch (mobile):**
- Left half: virtual D-pad (drag for direction)
- Right half: tap to fire
- Top area: jump

## File Structure

```
├── app/
│   ├── page.tsx              # Main game: SDK, P2P, host/guest logic, input
│   ├── game-engine.ts        # Contra physics & game logic (host only)
│   ├── renderer.ts           # Canvas rendering (both host & guest)
│   ├── webrtc-manager.ts     # P2P WebRTC DataChannel (generic, reusable)
│   └── signaling.ts          # Usion SDK ↔ WebRTC signaling bridge (reusable)
├── public/
│   ├── usion-sdk.js          # Usion client SDK
│   └── usion-design-system.css
├── package.json              # Only next + react (no server deps!)
├── Dockerfile                # Simple — no native builds needed
└── README.md
```

**Key difference from the Pong reference:** No `server/` directory, no `server.js`, no `node-datachannel`. The game is purely client-side. The host's browser IS the server.

## TURN Server (Production NAT Traversal)

For P2P to work across different networks, both browsers need to find a path to each other. TURN provides a relay when direct connection fails.

The Usion backend automatically provides TURN configuration (from `WEBRTC_TURN_*` env vars) in the game access response. The SDK passes these ICE servers to the `WebRTCManager`:

```typescript
// signaling.ts — automatic TURN from Usion SDK
const access = usion.game.getAccess();
const iceServers = access?.ice_servers; // [{urls: "turn:...", username: "...", credential: "..."}]
const rtc = new WebRTCManager(role, iceServers);
```

Without TURN (localhost development), the game uses public Google STUN servers — works for same-network testing.

## Adapting for Your Game

1. **Replace `game-engine.ts`** with your game logic. Keep the interface:
   - `initState(playerIds)` → initial state
   - `applyInput(state, playerId, input)` → process input
   - `tick(state, dtMs)` → advance simulation
   - `toNetworkState(state)` → serializable snapshot

2. **Replace `renderer.ts`** with your game's rendering

3. **Keep `webrtc-manager.ts` and `signaling.ts` as-is** — they're generic P2P infrastructure

4. **Modify `page.tsx`** input handling for your game's controls

5. **Adjust tick rate** — 30Hz for action, 10Hz for turn-based, 60Hz for precision

## Network Protocol

**Guest → Host:**
```json
{ "type": "input", "keys": { "left": true, "fire": true, ... } }
```

**Host → Guest:**
```json
{ "type": "state", "tick": 1200, "cameraX": 450.5, "players": {...}, "enemies": [...], "bullets": [...], ... }
{ "type": "init", "playerIds": ["user1", "user2"] }
```

Internal (handled by WebRTCManager):
```json
{ "type": "__ping", "t": 12345.678 }
{ "type": "__pong", "t": 12345.678 }
```

## When to Use P2P vs Server-Authoritative

| | P2P (this pattern) | Server (Pong pattern) |
|---|---|---|
| **Cost** | Free — no hosting | Developer pays for server |
| **Anti-cheat** | Host can cheat | Server is authoritative |
| **Use for** | Casual co-op, party games | Competitive, ranked, credits |
| **Latency** | Lowest possible (direct) | Higher (through server) |
| **Max players** | 2-8 practical | 2-50+ |
| **Complexity** | Simple — no backend code | Need to deploy & maintain server |

## Deployment

Since there's no game server, you just need to host the static Next.js app:

```bash
docker build -t contra-p2p .
docker run -p 3012:3012 contra-p2p
```

Or deploy to Vercel/Netlify (static export).

### Service Registration

```javascript
db.services.insertOne({
  id: "contra-p2p",
  name: "Contra Co-op",
  description: "2-player co-op side-scrolling shooter (P2P)",
  type: "game",
  category: "games",
  cost: 0,
  status: "active",
  min_players: 2,
  max_players: 2,
  realtime: {
    connection_mode: "platform",   // Uses Socket.IO for signaling only
    connection_transport: "websocket",
    protocol_version: "2",
    heartbeat_interval_ms: 25000
  },
  iframe_url: "https://your-domain.com",
  created_at: new Date()
});
```

Note: `connection_mode: "platform"` because signaling goes through Usion's Socket.IO. The P2P WebRTC connection is established client-side — the backend just relays the initial handshake.

## License

MIT
