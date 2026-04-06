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
 * so page.tsx registers the handler EARLY (before game.join) and passes
 * a signalSubscribe function to avoid overwriting and losing signals.
 *
 * RACE PROTECTION: Both the early signal buffer in page.tsx and the
 * internal signal buffer here capture signals that arrive before the
 * dispatcher is wired up. The host sends its offer immediately and
 * the guest's early buffer catches it whether or not the guest's
 * handler is already registered. Retries are handled by the caller
 * (`startP2PConnection` in page.tsx).
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
    /** Subscribe to signals from the early handler registered in page.tsx */
    signalSubscribe?: (handler: (data: any) => void) => void;
    /** Signals buffered before setupP2PConnection was called */
    earlySignals?: any[];
}

/**
 * Set up P2P connection using Usion Platform signaling.
 * Returns the WebRTCManager instance. Call destroy() when done.
 */
export async function setupP2PConnection(config: SignalingConfig): Promise<WebRTCManager> {
    const { role, onMessage, onState, onLog, signalSubscribe, earlySignals } = config;
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

    // Internal signal buffer — holds signals that arrive before waitForSignal
    const signalBuffer: any[] = [];
    let pendingResolve: ((payload: any) => void) | null = null;
    let pendingType: string | null = null;

    // Send ICE candidates through Usion Platform
    rtc.onIceCandidate = (candidate) => {
        log(`Sending ICE candidate`);
        usion.game.realtime('signal', { type: 'ice_candidate', candidate });
    };

    // Process a signal payload (from early buffer or live handler)
    const processSignal = (payload: any) => {
        if (!payload?.type) return;

        log(`Signal recv: ${payload.type}`);

        // Always process ICE candidates immediately
        if (payload.type === 'ice_candidate' && payload.candidate) {
            rtc.addIceCandidate(payload.candidate);
            return;
        }

        // Resolve any pending waitForSignal, or buffer for later
        if (pendingResolve && pendingType === payload.type) {
            const resolve = pendingResolve;
            pendingResolve = null;
            pendingType = null;
            resolve(payload);
        } else {
            signalBuffer.push(payload);
        }
    };

    // Raw handler for onRealtime events (extracts signal payload)
    const handleRealtime = (data: any) => {
        if (data?.action_type !== 'signal') return;
        const payload = data?.action_data || data;
        processSignal(payload);
    };

    // Subscribe to signals — prefer external subscription (from page.tsx early handler)
    if (signalSubscribe) {
        signalSubscribe(handleRealtime);
    } else {
        // Fallback: register directly (may miss signals if called late)
        usion.game.onRealtime(handleRealtime);
    }

    // Drain any early-buffered signals
    if (earlySignals && earlySignals.length > 0) {
        log(`Processing ${earlySignals.length} early-buffered signals`);
        for (const sig of earlySignals) {
            handleRealtime(sig);
        }
        earlySignals.length = 0; // Clear the buffer
    }

    // Wait for a specific signal type, checking internal buffer first
    const waitForSignal = (expectedType: string, timeoutMs = 8000): Promise<any> => {
        // Check buffer first — signal may have already arrived
        const idx = signalBuffer.findIndex(s => s.type === expectedType);
        if (idx >= 0) {
            log(`Found ${expectedType} in signal buffer`);
            return Promise.resolve(signalBuffer.splice(idx, 1)[0]);
        }

        return new Promise((resolve, reject) => {
            pendingType = expectedType;
            pendingResolve = resolve;

            // Timeout to prevent hanging forever
            const timer = setTimeout(() => {
                if (pendingResolve === resolve) {
                    pendingResolve = null;
                    pendingType = null;
                    reject(new Error(`Timeout waiting for ${expectedType}`));
                }
            }, timeoutMs);

            // Wrap resolve to clear timeout
            const originalResolve = resolve;
            pendingResolve = (payload) => {
                clearTimeout(timer);
                originalResolve(payload);
            };
        });
    };

    if (role === 'host') {
        // Host flow: create offer → broadcast it on a heartbeat → wait for
        // answer. The first offer often races the guest's room subscription
        // (or the guest's onRealtime handler registration). Re-sending the
        // SAME SDP every 1.5s is safe — the guest only acts on the first
        // one it sees, and our processSignal short-circuits duplicates by
        // resolving the pending wait the first time it arrives.
        log('Creating WebRTC offer...');
        const offer = await rtc.createOffer();
        const sendOffer = () => {
            try {
                usion.game.realtime('signal', { type: 'webrtc_offer', sdp: offer });
            } catch { /* ignore */ }
        };
        sendOffer();
        log('Offer sent, waiting for answer...');
        const offerHeartbeat = setInterval(sendOffer, 1500);

        let answerMsg: any;
        try {
            answerMsg = await waitForSignal('webrtc_answer', 20000);
        } finally {
            clearInterval(offerHeartbeat);
        }
        log('Answer received, connecting...');
        await rtc.handleAnswer(answerMsg.sdp);
    } else {
        // Guest flow: wait for offer → create answer → broadcast it on a
        // heartbeat until the host's WebRTC connection state flips to
        // 'connected'. We also send a `guest_ready` ping every 1.5s as a
        // tiny heartbeat the host can use to confirm the room is live and
        // to help wake up sticky relays.
        log('Waiting for WebRTC offer...');
        const guestReadyHeartbeat = setInterval(() => {
            try { usion.game.realtime('signal', { type: 'guest_ready' }); } catch { /* ignore */ }
        }, 1500);
        // Send one immediately
        try { usion.game.realtime('signal', { type: 'guest_ready' }); } catch { /* ignore */ }

        let offerMsg: any;
        try {
            offerMsg = await waitForSignal('webrtc_offer', 30000);
        } finally {
            clearInterval(guestReadyHeartbeat);
        }
        log('Offer received, creating answer...');

        const answer = await rtc.handleOffer(offerMsg.sdp);
        const sendAnswer = () => {
            try {
                usion.game.realtime('signal', { type: 'webrtc_answer', sdp: answer });
            } catch { /* ignore */ }
        };
        sendAnswer();
        log('Answer sent, connecting...');
        // Re-broadcast the answer until the data channel is open. The host
        // signals completion via rtc.connected (DataChannel onopen).
        const answerHeartbeat = setInterval(() => {
            if (rtc.connected) {
                clearInterval(answerHeartbeat);
                return;
            }
            sendAnswer();
        }, 1500);
        // Safety stop after 20s — by then either the connection is up or
        // the WebRTC stack has given up.
        setTimeout(() => clearInterval(answerHeartbeat), 20000);
    }

    return rtc;
}
