import net from "node:net";
import tls from "node:tls";
import type { ServerWebSocket } from "bun";
import type { AppConfig } from "./config.ts";
import type { SessionUser } from "./auth.ts";

/**
 * Binary WebSocket framing between browser IronRDP WASM and Bun xrdp proxy:
 *   Client -> Server:
 *     [0x01, ...x224_connection_request]  (Initial X.224 Connection Request PDU)
 *     [0x00, ...rdp_pdu_bytes]            (Post-TLS RDP stream bytes)
 *   Server -> Client:
 *     [0x02, ...x224_connection_confirm]  (X.224 Connection Confirm after TLS upgrade)
 *     [0x00, ...rdp_pdu_bytes]            (Post-TLS RDP stream bytes)
 *     [0xFF, ...utf8_error_message]       (Proxy connection/TLS failure message)
 */
const FRAME_DATA = 0x00;
const FRAME_X224_REQ = 0x01;
const FRAME_X224_RSP = 0x02;
const FRAME_ERROR = 0xff;

const MAX_X224_HANDSHAKE_BYTES = 2048;

export interface RdpWsContext {
  user: SessionUser;
  phase: "awaiting_x224" | "connecting" | "streaming" | "closed";
  tcpSocket: net.Socket | null;
  tlsSocket: tls.TLSSocket | null;
  rdpHost: string;
  rdpPort: number;
}

function sendErrorAndClose(ws: ServerWebSocket<RdpWsContext>, message: string): void {
  if (ws.data.phase === "closed") return;
  ws.data.phase = "closed";
  try {
    const textBytes = Buffer.from(message, "utf8");
    const frame = new Uint8Array(1 + textBytes.length);
    frame[0] = FRAME_ERROR;
    frame.set(textBytes, 1);
    ws.sendBinary(frame);
    ws.close(1011, "RDP proxy error");
  } catch {
    // Ignore close errors
  }
  cleanupSockets(ws.data);
}

export function cleanupSockets(ctx: RdpWsContext): void {
  ctx.phase = "closed";
  if (ctx.tlsSocket) {
    try {
      ctx.tlsSocket.destroy();
    } catch {
      // Ignore
    }
    ctx.tlsSocket = null;
  }
  if (ctx.tcpSocket) {
    try {
      ctx.tcpSocket.destroy();
    } catch {
      // Ignore
    }
    ctx.tcpSocket = null;
  }
}

function parseX224NegotiationConfirm(tpkt: Buffer): {
  isResponse: boolean;
  selectedProtocol: number;
} {
  // TPKT (4 bytes) + X.224 CC fixed header (7 bytes) = 11 bytes.
  // Optional RDP_NEG_RSP / RDP_NEG_FAILURE (8 bytes) starts at offset 11:
  //   byte 11: type (0x02 = RDP_NEG_RSP, 0x03 = RDP_NEG_FAILURE)
  //   byte 12: flags
  //   bytes 13..15: length (u16 LE = 8)
  //   bytes 15..19: selectedProtocol or failureCode (u32 LE)
  if (tpkt.length >= 19) {
    const negType = tpkt[11];
    const code = tpkt.readUInt32LE(15);
    if (negType === 0x02) {
      return { isResponse: true, selectedProtocol: code };
    }
    if (negType === 0x03) {
      return { isResponse: false, selectedProtocol: 0 };
    }
  }
  return { isResponse: true, selectedProtocol: 0 };
}

export function handleRdpWsMessage(
  ws: ServerWebSocket<RdpWsContext>,
  message: string | Buffer,
  _config: AppConfig
): void {
  if (typeof message === "string") {
    return;
  }
  const buf = Buffer.isBuffer(message) ? message : Buffer.from(message);
  if (buf.length < 2) return;

  const kind = buf[0];
  const payload = buf.subarray(1);

  if (ws.data.phase === "awaiting_x224") {
    if (kind !== FRAME_X224_REQ) {
      sendErrorAndClose(ws, "Expected initial X.224 Connection Request frame.");
      return;
    }
    if (payload.length < 11 || payload.length > MAX_X224_HANDSHAKE_BYTES || payload[0] !== 0x03) {
      sendErrorAndClose(ws, "Malformed X.224 TPKT Connection Request.");
      return;
    }

    ws.data.phase = "connecting";
    startBackendHandshake(ws, Buffer.from(payload));
    return;
  }

  if (ws.data.phase === "streaming" && kind === FRAME_DATA) {
    const activeSock = ws.data.tlsSocket ?? ws.data.tcpSocket;
    if (activeSock && !activeSock.destroyed) {
      activeSock.write(payload);
    }
  }
}

function startBackendHandshake(ws: ServerWebSocket<RdpWsContext>, x224Req: Buffer): void {
  const { rdpHost, rdpPort } = ws.data;
  const tcp = net.createConnection({ host: rdpHost, port: rdpPort });
  tcp.setNoDelay(true);
  tcp.setTimeout(15_000);
  ws.data.tcpSocket = tcp;

  let rxAccum = Buffer.alloc(0);
  let x224Done = false;

  const onInitialData = (chunk: Buffer) => {
    rxAccum = Buffer.concat([rxAccum, chunk]);
    if (rxAccum.length < 4) return;

    if (rxAccum[0] !== 0x03 || rxAccum[1] !== 0x00) {
      tcp.off("data", onInitialData);
      sendErrorAndClose(ws, "Unexpected non-TPKT response from xrdp server.");
      return;
    }

    const tpktLen = rxAccum.readUInt16BE(2);
    if (tpktLen < 11 || tpktLen > MAX_X224_HANDSHAKE_BYTES) {
      tcp.off("data", onInitialData);
      sendErrorAndClose(ws, "Invalid X.224 Connection Confirm length from xrdp server.");
      return;
    }

    if (rxAccum.length < tpktLen) return;

    x224Done = true;
    tcp.off("data", onInitialData);
    tcp.setTimeout(0);

    const x224Confirm = rxAccum.subarray(0, tpktLen);
    const leftover = rxAccum.subarray(tpktLen);
    const { isResponse, selectedProtocol } = parseX224NegotiationConfirm(x224Confirm);

    // PROTOCOL_SSL (0x01) or PROTOCOL_HYBRID (0x02) -> upgrade TCP socket to TLS
    if (isResponse && (selectedProtocol & 0x03) !== 0) {
      upgradeToTls(ws, tcp, x224Confirm, leftover);
    } else {
      // Negotiation failure PDU: forward to WASM so ClientConnector reports exact reason
      const rspFrame = new Uint8Array(1 + x224Confirm.length);
      rspFrame[0] = FRAME_X224_RSP;
      rspFrame.set(x224Confirm, 1);
      try {
        ws.sendBinary(rspFrame);
      } catch {
        // Ignore
      }
      cleanupSockets(ws.data);
    }
  };

  tcp.once("connect", () => {
    if (ws.data.phase !== "connecting") {
      cleanupSockets(ws.data);
      return;
    }
    tcp.on("data", onInitialData);
    tcp.write(x224Req);
  });

  tcp.once("timeout", () => {
    if (!x224Done) {
      sendErrorAndClose(ws, `Timed out connecting to xrdp on ${rdpHost}:${rdpPort}.`);
    }
  });

  tcp.on("error", (err) => {
    if (ws.data.phase !== "closed") {
      sendErrorAndClose(
        ws,
        `Cannot reach xrdp service (${rdpHost}:${rdpPort}): ${err.message}`
      );
    }
  });

  tcp.on("close", () => {
    if (ws.data.phase !== "closed" && !ws.data.tlsSocket) {
      ws.data.phase = "closed";
      try {
        ws.close(1000, "xrdp connection closed");
      } catch {
        // Ignore
      }
    }
  });
}

function upgradeToTls(
  ws: ServerWebSocket<RdpWsContext>,
  tcp: net.Socket,
  x224Confirm: Buffer,
  leftover: Buffer
): void {
  if (leftover.length > 0) {
    tcp.unshift(leftover);
  }

  // xrdp uses a local self-signed certificate (/etc/xrdp/cert.pem) on 127.0.0.1:3389
  const tlsSock = tls.connect({
    socket: tcp,
    rejectUnauthorized: false,
  });
  ws.data.tlsSocket = tlsSock;

  tlsSock.once("secureConnect", () => {
    if (ws.data.phase !== "connecting") {
      cleanupSockets(ws.data);
      return;
    }

    ws.data.phase = "streaming";

    const rspFrame = new Uint8Array(1 + x224Confirm.length);
    rspFrame[0] = FRAME_X224_RSP;
    rspFrame.set(x224Confirm, 1);
    ws.sendBinary(rspFrame);

    tlsSock.on("data", (chunk: Buffer) => {
      if (ws.data.phase !== "streaming") return;
      const out = new Uint8Array(1 + chunk.length);
      out[0] = FRAME_DATA;
      out.set(chunk, 1);
      try {
        ws.sendBinary(out);
      } catch {
        cleanupSockets(ws.data);
      }
    });
  });

  tlsSock.on("error", (err) => {
    if (ws.data.phase !== "closed") {
      sendErrorAndClose(ws, `xrdp TLS error: ${err.message}`);
    }
  });

  tlsSock.on("close", () => {
    if (ws.data.phase !== "closed") {
      ws.data.phase = "closed";
      try {
        ws.close(1000, "xrdp session closed");
      } catch {
        // Ignore
      }
    }
  });
}
