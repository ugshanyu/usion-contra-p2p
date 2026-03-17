/**
 * WebRTC P2P connection manager — generic, reusable.
 * Handles ICE/SDP negotiation and DataChannel for game data.
 *
 * DataChannel is configured as unreliable (UDP-like) for minimum latency.
 * Supports custom ICE servers (TURN) passed from the Usion SDK.
 */

export type P2PRole = 'host' | 'guest';

export interface P2PMessage {
    type: string;
    [key: string]: any;
}

export type OnMessageCallback = (msg: P2PMessage) => void;
export type OnStateCallback = (state: 'connecting' | 'connected' | 'disconnected' | 'failed') => void;

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
];

const DATACHANNEL_LABEL = 'game';

export class WebRTCManager {
    role: P2PRole;
    pc: RTCPeerConnection | null = null;
    dc: RTCDataChannel | null = null;
    onMessage: OnMessageCallback | null = null;
    onState: OnStateCallback | null = null;
    onIceCandidate: ((candidate: RTCIceCandidateInit) => void) | null = null;

    private _iceServers: RTCIceServer[];
    private _state: 'connecting' | 'connected' | 'disconnected' | 'failed' = 'connecting';
    private _rttMs = 0;
    private _pingInterval: ReturnType<typeof setInterval> | null = null;
    private _pendingPingAt = 0;

    /**
     * @param role - 'host' creates the DataChannel, 'guest' receives it
     * @param iceServers - Custom ICE servers (from Usion SDK). Falls back to public STUN if not provided.
     */
    constructor(role: P2PRole, iceServers?: RTCIceServer[]) {
        this.role = role;
        this._iceServers = iceServers && iceServers.length > 0 ? iceServers : DEFAULT_ICE_SERVERS;
    }

    get rttMs() { return this._rttMs; }
    get connected() { return this._state === 'connected'; }

    /** Create the RTCPeerConnection */
    init() {
        this.pc = new RTCPeerConnection({ iceServers: this._iceServers });

        this.pc.onicecandidate = (evt) => {
            if (evt.candidate && this.onIceCandidate) {
                this.onIceCandidate(evt.candidate.toJSON());
            }
        };

        this.pc.onconnectionstatechange = () => {
            const s = this.pc?.connectionState;
            if (s === 'connected') this._setState('connected');
            else if (s === 'failed') this._setState('failed');
            else if (s === 'disconnected') this._setState('disconnected');
        };

        // Host creates the DataChannel
        if (this.role === 'host') {
            this.dc = this.pc.createDataChannel(DATACHANNEL_LABEL, {
                ordered: false,
                maxRetransmits: 0,
            });
            this._setupDataChannel(this.dc);
        } else {
            // Guest receives the DataChannel
            this.pc.ondatachannel = (evt) => {
                this.dc = evt.channel;
                this._setupDataChannel(this.dc);
            };
        }
    }

    /** Host: create SDP offer */
    async createOffer(): Promise<RTCSessionDescriptionInit> {
        if (!this.pc) throw new Error('Not initialized');
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        return offer;
    }

    /** Guest: handle SDP offer and create answer */
    async handleOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
        if (!this.pc) throw new Error('Not initialized');
        await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        return answer;
    }

    /** Host: handle SDP answer */
    async handleAnswer(answer: RTCSessionDescriptionInit) {
        if (!this.pc) throw new Error('Not initialized');
        await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
    }

    /** Add ICE candidate from remote peer */
    async addIceCandidate(candidate: RTCIceCandidateInit) {
        if (!this.pc) return;
        try {
            await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch {
            // Ignore ICE candidate errors (race conditions are normal)
        }
    }

    /** Send a message over the DataChannel */
    send(msg: P2PMessage) {
        if (!this.dc || this.dc.readyState !== 'open') return;
        try {
            this.dc.send(JSON.stringify(msg));
        } catch {
            // DataChannel might close between check and send
        }
    }

    /** Clean up everything */
    destroy() {
        if (this._pingInterval) clearInterval(this._pingInterval);
        this._pingInterval = null;
        try { this.dc?.close(); } catch { /* noop */ }
        try { this.pc?.close(); } catch { /* noop */ }
        this.dc = null;
        this.pc = null;
        this._setState('disconnected');
    }

    // ---- Internals ----
    private _setupDataChannel(dc: RTCDataChannel) {
        dc.binaryType = 'arraybuffer';

        dc.onopen = () => {
            this._setState('connected');
            this._startPingLoop();
        };

        dc.onclose = () => {
            this._setState('disconnected');
        };

        dc.onerror = () => {
            this._setState('failed');
        };

        dc.onmessage = (evt) => {
            try {
                const msg = JSON.parse(evt.data) as P2PMessage;

                // Handle ping/pong internally for RTT measurement
                if (msg.type === '__ping') {
                    this.send({ type: '__pong', t: msg.t });
                    return;
                }
                if (msg.type === '__pong') {
                    this._rttMs = performance.now() - (msg.t || 0);
                    return;
                }

                this.onMessage?.(msg);
            } catch {
                // Ignore malformed messages
            }
        };
    }

    private _startPingLoop() {
        if (this._pingInterval) clearInterval(this._pingInterval);
        this._pingInterval = setInterval(() => {
            if (this.dc?.readyState === 'open') {
                this.send({ type: '__ping', t: performance.now() });
            }
        }, 1000);
    }

    private _setState(s: typeof this._state) {
        if (this._state === s) return;
        this._state = s;
        this.onState?.(s);
    }
}
