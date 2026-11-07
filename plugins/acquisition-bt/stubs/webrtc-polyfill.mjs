// Peers are reached over TCP, never WebRTC. webtorrent imports this module unconditionally, so this stand-in keeps the native WebRTC
// library (and its licence and binary) out of the plugin. A tracker or peer that would need WebRTC is left out by the engine before it gets here.
const unavailable = () => { throw new Error("WebRTC is not available in this plugin"); };
export class RTCPeerConnection { constructor() { unavailable(); } }
export class RTCSessionDescription { constructor() { unavailable(); } }
export class RTCIceCandidate { constructor() { unavailable(); } }
