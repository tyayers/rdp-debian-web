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
 *     [0xFE, ...utf8_diagnostic_log]      (Client WASM lifecycle/error log)
 *   Server -> Client:
 *     [0x02, ...x224_connection_confirm]  (X.224 Connection Confirm after TLS upgrade)
 *     [0x00, ...rdp_pdu_bytes]            (Post-TLS RDP stream bytes)
 *     [0xFF, ...utf8_error_message]       (Proxy connection/TLS failure message)
 */
const FRAME_DATA = 0x00;
const FRAME_X224_REQ = 0x01;
const FRAME_X224_RSP = 0x02;
const FRAME_CLIENT_LOG = 0xfe;
const FRAME_ERROR = 0xff;

const MAX_X224_HANDSHAKE_BYTES = 2048;

let nextConnectionSeq = 1;

export interface RdpWsContext {
  connId: number;
  openedAt: number;
  txBytes: number;
  rxBytes: number;
  user: SessionUser;
  phase: "awaiting_x224" | "connecting" | "streaming" | "closed";
  tcpSocket: net.Socket | null;
  tlsSocket: tls.TLSSocket | null;
  rdpHost: string;
  rdpPort: number;
}

export function createRdpWsContext(user: SessionUser, config: AppConfig): RdpWsContext {
  return {
    connId: nextConnectionSeq++,
    openedAt: Date.now(),
    txBytes: 0,
    rxBytes: 0,
    user,
    phase: "awaiting_x224",
    tcpSocket: null,
    tlsSocket: null,
    rdpHost: config.rdpHost,
    rdpPort: config.rdpPort,
  };
}

export function rdpLog(ctx: RdpWsContext, message: string): void {
  const ts = new Date().toISOString();
  console.log(`${ts} [rdp #${ctx.connId} user=${ctx.user.username}] ${message}`);
}

function sendErrorAndClose(ws: ServerWebSocket<RdpWsContext>, message: string): void {
  if (ws.data.phase === "closed") return;
  rdpLog(ws.data, `ERROR: ${message}`);
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

function describeProtocol(proto: number): string {
  if (proto === 0) return "PROTOCOL_RDP (0x0 - Standard RDP without TLS)";
  const names: string[] = [];
  if (proto & 0x01) names.push("PROTOCOL_SSL/TLS");
  if (proto & 0x02) names.push("PROTOCOL_HYBRID/CredSSP");
  if (proto & 0x08) names.push("PROTOCOL_HYBRID_EX");
  return `${names.join("|") || "UNKNOWN"} (0x${proto.toString(16)})`;
}

function describeFailureCode(code: number): string {
  switch (code) {
    case 0x01:
      return "SSL_REQUIRED_BY_SERVER (0x01)";
    case 0x02:
      return "SSL_NOT_ALLOWED_BY_SERVER (0x02)";
    case 0x03:
      return "SSL_CERT_NOT_ON_SERVER (0x03) — check /etc/xrdp/cert.pem & key.pem permissions";
    case 0x04:
      return "INCONSISTENT_FLAGS (0x04)";
    case 0x05:
      return "HYBRID_REQUIRED_BY_SERVER (0x05) — NLA/CredSSP enforced on server";
    case 0x06:
      return "SSL_WITH_USER_AUTH_REQUIRED_BY_SERVER (0x06)";
    default:
      return `UNKNOWN_FAILURE (0x${code.toString(16)})`;
  }
}

function parseX224NegotiationConfirm(tpkt: Buffer): {
  isResponse: boolean;
  code: number;
} {
  if (tpkt.length >= 19) {
    const negType = tpkt[11];
    const code = tpkt.readUInt32LE(15);
    if (negType === 0x02) {
      return { isResponse: true, code };
    }
    if (negType === 0x03) {
      return { isResponse: false, code };
    }
  }
  return { isResponse: true, code: 0 };
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
  if (buf.length < 1) return;

  const kind = buf[0];
  const payload = buf.subarray(1);

  if (kind === FRAME_CLIENT_LOG) {
    const logText = payload.subarray(0, 1024).toString("utf8");
    rdpLog(ws.data, `[client] ${logText}`);
    return;
  }

  if (buf.length < 2) return;

  if (ws.data.phase === "awaiting_x224") {
    if (kind !== FRAME_X224_REQ) {
      sendErrorAndClose(ws, `Expected initial X.224 frame (0x01), got 0x${kind?.toString(16)}`);
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
      ws.data.txBytes += payload.length;
      activeSock.write(payload);
    }
  }
}

function startBackendHandshake(ws: ServerWebSocket<RdpWsContext>, x224Req: Buffer): void {
  const { rdpHost, rdpPort } = ws.data;
  rdpLog(
    ws.data,
    `Opening TCP connection to xrdp at ${rdpHost}:${rdpPort} (X.224 request=${x224Req.length}B)`
  );

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
      sendErrorAndClose(
        ws,
        `Unexpected non-TPKT header from xrdp: 0x${rxAccum.subarray(0, 4).toString("hex")}`
      );
      return;
    }

    const tpktLen = rxAccum.readUInt16BE(2);
    if (tpktLen < 11 || tpktLen > MAX_X224_HANDSHAKE_BYTES) {
      tcp.off("data", onInitialData);
      sendErrorAndClose(ws, `Invalid X.224 Connection Confirm length (${tpktLen}) from xrdp.`);
      return;
    }

    if (rxAccum.length < tpktLen) return;

    x224Done = true;
    tcp.off("data", onInitialData);
    tcp.setTimeout(0);

    const x224Confirm = rxAccum.subarray(0, tpktLen);
    const leftover = rxAccum.subarray(tpktLen);
    const { isResponse, code } = parseX224NegotiationConfirm(x224Confirm);

    if (isResponse && (code & 0x03) !== 0) {
      rdpLog(ws.data, `xrdp confirmed X.224 negotiation: ${describeProtocol(code)}; upgrading to TLS`);
      upgradeToTls(ws, tcp, x224Confirm, leftover);
    } else if (isResponse && code === 0) {
      sendErrorAndClose(
        ws,
        "xrdp selected Standard RDP without TLS (0x0). Ensure xrdp can read /etc/xrdp/key.pem (run: sudo adduser xrdp ssl-cert && sudo systemctl restart xrdp)."
      );
    } else {
      const reason = describeFailureCode(code);
      rdpLog(ws.data, `xrdp rejected X.224 security negotiation: ${reason}`);
      sendErrorAndClose(ws, `xrdp rejected TLS negotiation: ${reason}`);
    }
  };

  tcp.once("connect", () => {
    if (ws.data.phase !== "connecting") {
      cleanupSockets(ws.data);
      return;
    }
    rdpLog(ws.data, `TCP connected to ${rdpHost}:${rdpPort}; sending X.224 Connection Request`);
    tcp.on("data", onInitialData);
    ws.data.txBytes += x224Req.length;
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

  tcp.on("close", (hadError) => {
    if (ws.data.phase !== "closed" && !ws.data.tlsSocket) {
      const elapsed = Date.now() - ws.data.openedAt;
      rdpLog(
        ws.data,
        `xrdp TCP socket closed before TLS (hadError=${hadError}, duration=${elapsed}ms, tx=${ws.data.txBytes}B, rx=${ws.data.rxBytes}B)`
      );
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

    const proto = tlsSock.getProtocol() ?? "unknown";
    const cipher = tlsSock.getCipher()?.name ?? "unknown";
    rdpLog(ws.data, `TLS handshake complete (${proto}, cipher=${cipher}); streaming RDP session`);

    ws.data.phase = "streaming";

    const rspFrame = new Uint8Array(1 + x224Confirm.length);
    rspFrame[0] = FRAME_X224_RSP;
    rspFrame.set(x224Confirm, 1);
    ws.sendBinary(rspFrame);

    tlsSock.on("data", (chunk: Buffer) => {
      if (ws.data.phase !== "streaming") return;
      ws.data.rxBytes += chunk.length;
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
      const elapsed = Date.now() - ws.data.openedAt;
      rdpLog(
        ws.data,
        `xrdp TLS stream closed by remote host (duration=${elapsed}ms, tx=${ws.data.txBytes}B, rx=${ws.data.rxBytes}B)${
          elapsed < 5000
            ? " — HINT: Quick disconnect after connect usually means xrdp-sesman rejected the PAM password or /etc/xrdp/startwm.sh exited immediately (check /var/log/xrdp-sesman.log and ~/.xsession-errors)."
            : ""
        }`
      );
      ws.data.phase = "closed";
      try {
        ws.close(1000, "xrdp session closed");
      } catch {
        // Ignore
      }
    }
  });
}
