/**
 * Signaling adapter: bridges WebRTC signaling with Usion SDK Platform mode.
 *
 * Uses `game.realtime("signal", data)` to send signaling messages
 * and `game.onRealtime()` to receive them.
 *
 * The host creates the WebRTC offer, the guest creates the answer.
 * ICE candidates are exchanged bidirectionally.
 *
 * IMPORTANT: Usion's onRealtime is a SETTER (overwrites previous handler),
 * so we use a single persistent handler with a pending-signal queue.
 */

import { WebRTCManager, type P2PRole, type OnMessageCallback, type OnStateCallback } from './webrtc-manager';

declare global {
    interface Window { Usion?: any; }
}

interface SignalingConfig {
    role: P2PRole;
    onMessage: OnMessageCallback;
    onState: OnStateCallback;
    onLog?: (msg: string) => void;
}

/**
 * Set up P2P connection using Usion Platform signaling.
 * Returns the WebRTCManager instance. Call destroy() when done.
 */
export async function setupP2PConnection(config: SignalingConfig): Promise<WebRTCManager> {
    const { role, onMessage, onState, onLog } = config;
    const log = onLog || (() => { });

    const usion = window.Usion;
    if (!usion?.game) throw new Error('Usion SDK not available');

    // Get ICE servers from Usion SDK (includes TURN for NAT traversal)
    let iceServers: RTCIceServer[] | undefined;
    try {
        const access = usion.game.getAccess?.() || usion.game._access;
        if (access?.ice_servers && Array.isArray(access.ice_servers)) {
            iceServers = access.ice_servers as RTCIceServer[];
            log(`Using ${iceServers.length} ICE servers from Usion SDK`);
        }
    } catch {
        // Fall back to default STUN servers
    }

    const rtc = new WebRTCManager(role, iceServers);
    rtc.onMessage = onMessage;
    rtc.onState = onState;
    rtc.init();

    // Queue for waiting signals
    let pendingResolve: ((payload: any) => void) | null = null;
    let pendingType: string | null = null;

    // Send ICE candidates through Usion Platform
    rtc.onIceCandidate = (candidate) => {
        log(`Sending ICE candidate`);
        usion.game.realtime('signal', { type: 'ice_candidate', candidate });
    };

    // Single persistent handler — onRealtime is a SETTER, so we register only once
    usion.game.onRealtime((data: any) => {
        // Filter: only handle 'signal' action_type
        if (data?.action_type !== 'signal') return;

        const payload = data?.action_data || data;
        if (!payload?.type) return;

        log(`Signal recv: ${payload.type}`);

        // Always process ICE candidates immediately
        if (payload.type === 'ice_candidate' && payload.candidate) {
            rtc.addIceCandidate(payload.candidate);
            return;
        }

        // Resolve any pending waitForSignal
        if (pendingResolve && pendingType === payload.type) {
            const resolve = pendingResolve;
            pendingResolve = null;
            pendingType = null;
            resolve(payload);
        }
    });

    const waitForSignal = (expectedType: string): Promise<any> => {
        return new Promise((resolve) => {
            pendingType = expectedType;
            pendingResolve = resolve;
        });
    };

    if (role === 'host') {
        // Host flow: create offer → send → wait for answer
        log('Creating WebRTC offer...');
        const offer = await rtc.createOffer();
        usion.game.realtime('signal', { type: 'webrtc_offer', sdp: offer });
        log('Offer sent, waiting for answer...');

        const answerMsg = await waitForSignal('webrtc_answer');
        log('Answer received, connecting...');
        await rtc.handleAnswer(answerMsg.sdp);
    } else {
        // Guest flow: wait for offer → create answer → send
        log('Waiting for WebRTC offer...');
        const offerMsg = await waitForSignal('webrtc_offer');
        log('Offer received, creating answer...');

        const answer = await rtc.handleOffer(offerMsg.sdp);
        usion.game.realtime('signal', { type: 'webrtc_answer', sdp: answer });
        log('Answer sent, connecting...');
    }

    return rtc;
}
