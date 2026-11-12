// Vanilla ES Module hosting the compiled Rust IronRDP WebAssembly client (rdp_wasm_bg.wasm)
import initWasm, { RdpSession } from "/wasm/rdp_wasm.js";

const CODE_TO_SCANCODE = {
  Escape: 0x0001,
  Digit1: 0x0002,
  Digit2: 0x0003,
  Digit3: 0x0004,
  Digit4: 0x0005,
  Digit5: 0x0006,
  Digit6: 0x0007,
  Digit7: 0x0008,
  Digit8: 0x0009,
  Digit9: 0x000a,
  Digit0: 0x000b,
  Minus: 0x000c,
  Equal: 0x000d,
  Backspace: 0x000e,
  Tab: 0x000f,
  KeyQ: 0x0010,
  KeyW: 0x0011,
  KeyE: 0x0012,
  KeyR: 0x0013,
  KeyT: 0x0014,
  KeyY: 0x0015,
  KeyU: 0x0016,
  KeyI: 0x0017,
  KeyO: 0x0018,
  KeyP: 0x0019,
  BracketLeft: 0x001a,
  BracketRight: 0x001b,
  Enter: 0x001c,
  ControlLeft: 0x001d,
  KeyA: 0x001e,
  KeyS: 0x001f,
  KeyD: 0x0020,
  KeyF: 0x0021,
  KeyG: 0x0022,
  KeyH: 0x0023,
  KeyJ: 0x0024,
  KeyK: 0x0025,
  KeyL: 0x0026,
  Semicolon: 0x0027,
  Quote: 0x0028,
  Backquote: 0x0029,
  ShiftLeft: 0x002a,
  Backslash: 0x002b,
  KeyZ: 0x002c,
  KeyX: 0x002d,
  KeyC: 0x002e,
  KeyV: 0x002f,
  KeyB: 0x0030,
  KeyN: 0x0031,
  KeyM: 0x0032,
  Comma: 0x0033,
  Period: 0x0034,
  Slash: 0x0035,
  ShiftRight: 0x0036,
  NumpadMultiply: 0x0037,
  AltLeft: 0x0038,
  Space: 0x0039,
  CapsLock: 0x003a,
  F1: 0x003b,
  F2: 0x003c,
  F3: 0x003d,
  F4: 0x003e,
  F5: 0x003f,
  F6: 0x0040,
  F7: 0x0041,
  F8: 0x0042,
  F9: 0x0043,
  F10: 0x0044,
  NumLock: 0x0045,
  ScrollLock: 0x0046,
  Numpad7: 0x0047,
  Numpad8: 0x0048,
  Numpad9: 0x0049,
  NumpadSubtract: 0x004a,
  Numpad4: 0x004b,
  Numpad5: 0x004c,
  Numpad6: 0x004d,
  NumpadAdd: 0x004e,
  Numpad1: 0x004f,
  Numpad2: 0x0050,
  Numpad3: 0x0051,
  Numpad0: 0x0052,
  NumpadDecimal: 0x0053,
  IntlBackslash: 0x0056,
  F11: 0x0057,
  F12: 0x0058,
  NumpadEnter: 0xe01c,
  ControlRight: 0xe01d,
  NumpadDivide: 0xe035,
  PrintScreen: 0xe037,
  AltRight: 0xe038,
  Home: 0xe047,
  ArrowUp: 0xe048,
  PageUp: 0xe049,
  ArrowLeft: 0xe04b,
  ArrowRight: 0xe04d,
  End: 0xe04f,
  ArrowDown: 0xe050,
  PageDown: 0xe051,
  Insert: 0xe052,
  Delete: 0xe053,
  MetaLeft: 0xe05b,
  MetaRight: 0xe05c,
  ContextMenu: 0xe05d,
};

let wasmReadyPromise = null;

function ensureWasmInitialized() {
  if (!wasmReadyPromise) {
    wasmReadyPromise = initWasm({ module_or_path: "/wasm/rdp_wasm_bg.wasm" }).catch((err) => {
      wasmReadyPromise = null;
      throw err;
    });
  }
  return wasmReadyPromise;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class RdpViewer {
  constructor(options) {
    this.canvas = options.canvas;
    this.viewport = options.viewport;
    this.ctx = this.canvas.getContext("2d", { alpha: false, desynchronized: true });
    this.onStatus = options.onStatus || (() => {});
    this.onRemoteClipboard = options.onRemoteClipboard || (() => {});

    this.ws = null;
    this.session = null;
    this.connected = false;
    this.connectedAt = 0;
    this.framesDrawn = 0;
    this.pendingLogs = [];
    this.destroyed = false;
    this.cursorCanvas = document.createElement("canvas");
    this.cursorCtx = this.cursorCanvas.getContext("2d");
    this.resizeTimer = null;

    this.boundKeyDown = (e) => this.handleKey(e, true);
    this.boundKeyUp = (e) => this.handleKey(e, false);
    this.boundMouseMove = (e) => this.handleMouseMove(e);
    this.boundMouseDown = (e) => this.handleMouseButton(e, true);
    this.boundMouseUp = (e) => this.handleMouseButton(e, false);
    this.boundWheel = (e) => this.handleWheel(e);
    this.boundContextMenu = (e) => e.preventDefault();
    this.boundBlur = () => this.releaseAllInputs();
    this.boundPaste = (e) => this.handleBrowserPaste(e);

    this.attachInputListeners();
  }

  attachInputListeners() {
    this.canvas.addEventListener("keydown", this.boundKeyDown);
    this.canvas.addEventListener("keyup", this.boundKeyUp);
    this.canvas.addEventListener("mousemove", this.boundMouseMove);
    this.canvas.addEventListener("mousedown", this.boundMouseDown);
    this.canvas.addEventListener("mouseup", this.boundMouseUp);
    this.canvas.addEventListener("wheel", this.boundWheel, { passive: false });
    this.canvas.addEventListener("contextmenu", this.boundContextMenu);
    this.canvas.addEventListener("blur", this.boundBlur);
    window.addEventListener("blur", this.boundBlur);
    document.addEventListener("paste", this.boundPaste);

    this.resizeObserver = new ResizeObserver(() => {
      if (!this.connected) return;
      this.scheduleViewportResize();
    });
    this.resizeObserver.observe(this.viewport);
  }

  scheduleViewportResize(delayMs = 350) {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.requestViewportResize();
    }, delayMs);
  }

  computeTargetDimensions() {
    const rect = this.viewport.getBoundingClientRect();
    const rawW = Math.max(320, Math.floor(rect.width || 1280));
    const rawH = Math.max(240, Math.floor(rect.height || 800));
    const width = Math.min(4096, rawW & ~1);
    const height = Math.min(4096, rawH);
    return { width, height };
  }

  sendClientLog(message) {
    console.info("[rdp]", message);
    const bytes = textEncoder.encode(message);
    const packet = new Uint8Array(1 + bytes.length);
    packet[0] = 0xfe;
    packet.set(bytes, 1);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(packet);
      } catch {
        // Ignore
      }
    } else {
      this.pendingLogs.push(packet);
    }
  }

  async connect({ username, password }) {
    this.disconnect();
    this.destroyed = false;
    this.connectedAt = 0;
    this.framesDrawn = 0;
    this.pendingLogs = [];
    this.onStatus("connecting", "Loading WebAssembly RDP engine…");

    await ensureWasmInitialized();
    if (this.destroyed) return;

    const { width, height } = this.computeTargetDimensions();
    this.canvas.width = width;
    this.canvas.height = height;

    this.session = new RdpSession(
      width,
      height,
      username,
      password,
      "",
      // on_send(kind, Uint8Array)
      (kind, payload) => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const packet = new Uint8Array(1 + payload.length);
        packet[0] = kind;
        packet.set(payload, 1);
        this.ws.send(packet);
      },
      // on_connected(w, h)
      (w, h) => {
        this.canvas.width = w;
        this.canvas.height = h;
        this.connected = true;
        this.connectedAt = Date.now();
        this.onStatus("connected", `${w}×${h}`);
        this.canvas.focus();
        // Sync if viewport changed while RDP handshake was in progress
        this.scheduleViewportResize(400);
      },
      // on_resize(w, h)
      (w, h) => {
        if (this.canvas.width !== w || this.canvas.height !== h) {
          this.canvas.width = w;
          this.canvas.height = h;
        }
        this.onStatus("connected", `${w}×${h}`);
      },
      // on_draw_rect(rgbaUint8Array, x, y, w, h)
      (pixels, x, y, w, h) => {
        if (!this.ctx || w === 0 || h === 0) return;
        this.framesDrawn += 1;
        const clamped = new Uint8ClampedArray(
          pixels.buffer,
          pixels.byteOffset,
          pixels.byteLength
        );
        this.ctx.putImageData(new ImageData(clamped, w, h), x, y);
      },
      // on_cursor(kind, pixels?, w?, h?, hotX?, hotY?)
      (kind, pixels, w, h, hotX, hotY) => {
        if (kind === 0) {
          this.canvas.style.cursor = "default";
        } else if (kind === 1) {
          this.canvas.style.cursor = "none";
        } else if (kind === 2 && pixels && w > 0 && h > 0) {
          this.cursorCanvas.width = w;
          this.cursorCanvas.height = h;
          const clamped = new Uint8ClampedArray(
            pixels.buffer,
            pixels.byteOffset,
            pixels.byteLength
          );
          this.cursorCtx.putImageData(new ImageData(clamped, w, h), 0, 0);
          const dataUrl = this.cursorCanvas.toDataURL("image/png");
          this.canvas.style.cursor = `url("${dataUrl}") ${hotX} ${hotY}, default`;
        }
      },
      // on_clipboard(text)
      (text) => {
        this.onRemoteClipboard(text);
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          navigator.clipboard.writeText(text).catch(() => {});
        }
      },
      // on_terminated(reason)
      (reason) => {
        const elapsed = this.connectedAt ? Date.now() - this.connectedAt : 0;
        const startupFailure = this.framesDrawn <= 2 && elapsed < 8000;
        this.connected = false;
        if (startupFailure) {
          this.onStatus(
            "error",
            `xrdp closed the session (${reason || "disconnected"}). Check /var/log/xrdp-sesman.log and /etc/xrdp/startwm.sh on the VM.`
          );
        } else {
          this.onStatus("disconnected", "Session signed out");
        }
        this.cleanupSessionOnly();
      },
      // on_log(msg)
      (msg) => {
        this.sendClientLog(msg);
      }
    );

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const userParam = new URLSearchParams(window.location.search).get("user")?.trim();
    const wsQuery = userParam ? `?user=${encodeURIComponent(userParam)}` : "";
    const wsUrl = `${proto}//${window.location.host}/api/rdp/ws${wsQuery}`;
    this.onStatus("connecting", "Connecting to VM xrdp session…");

    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.addEventListener("open", () => {
      if (!this.session) return;
      for (const pkt of this.pendingLogs.splice(0)) {
        ws.send(pkt);
      }
      try {
        this.session.start();
      } catch (err) {
        this.sendClientLog(`start() error: ${err}`);
        this.onStatus("error", String(err));
        this.cleanupSessionOnly();
      }
    });

    ws.addEventListener("message", (event) => {
      if (!(event.data instanceof ArrayBuffer) || !this.session) return;
      const bytes = new Uint8Array(event.data);
      if (bytes.length < 1) return;

      const kind = bytes[0];
      const payload = bytes.subarray(1);

      if (kind === 0xfd) {
        const statusMsg = textDecoder.decode(payload);
        if (statusMsg) {
          this.onStatus("connecting", statusMsg);
        }
        return;
      }

      if (kind === 0xff) {
        const msg = textDecoder.decode(payload);
        this.connected = false;
        this.onStatus("error", msg || "Connection closed by gateway");
        this.cleanupSessionOnly();
        return;
      }

      try {
        if (kind === 0x02) {
          this.onStatus("connecting", "Authenticating Linux session…");
          this.session.on_tls_ready(payload);
        } else if (kind === 0x00) {
          this.session.on_rdp_data(payload);
        }
      } catch (err) {
        this.sendClientLog(`WASM error: ${err}`);
        this.connected = false;
        this.onStatus("error", String(err));
        this.cleanupSessionOnly();
      }
    });

    ws.addEventListener("close", (ev) => {
      const wasConnected = this.connected;
      const elapsed = this.connectedAt ? Date.now() - this.connectedAt : 0;
      this.connected = false;
      if (this.session) {
        this.cleanupSessionOnly();
        if (ev.code === 4001) {
          this.onStatus("disconnected", "Moved to new tab");
        } else if (!wasConnected || (this.framesDrawn <= 2 && elapsed < 8000)) {
          this.onStatus(
            "error",
            `xrdp closed the connection (${ev.reason || `code ${ev.code}`}). Check server console logs and /var/log/xrdp-sesman.log.`
          );
        } else {
          this.onStatus("disconnected", "Session signed out");
        }
      }
    });

    ws.addEventListener("error", () => {
      if (this.connected || this.session) {
        this.onStatus("error", "WebSocket connection failed");
      }
    });
  }

  translateCoords(event) {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const x = Math.max(
      0,
      Math.min(this.canvas.width - 1, Math.round((event.clientX - rect.left) * scaleX))
    );
    const y = Math.max(
      0,
      Math.min(this.canvas.height - 1, Math.round((event.clientY - rect.top) * scaleY))
    );
    return { x, y };
  }

  handleMouseMove(event) {
    if (!this.connected || !this.session) return;
    const { x, y } = this.translateCoords(event);
    this.session.mouse_move(x, y);
  }

  handleMouseButton(event, pressed) {
    if (!this.connected || !this.session) return;
    if (pressed) {
      this.canvas.focus();
      const { x, y } = this.translateCoords(event);
      this.session.mouse_move(x, y);
    }
    event.preventDefault();
    this.session.mouse_button(event.button, pressed);
  }

  handleWheel(event) {
    if (!this.connected || !this.session) return;
    event.preventDefault();
    if (event.deltaY !== 0) {
      const units = Math.max(-1200, Math.min(1200, Math.round(-event.deltaY)));
      if (units !== 0) {
        this.session.mouse_wheel(units, true);
      }
    }
    if (event.deltaX !== 0) {
      const units = Math.max(-1200, Math.min(1200, Math.round(event.deltaX)));
      if (units !== 0) {
        this.session.mouse_wheel(units, false);
      }
    }
  }

  handleKey(event, pressed) {
    if (!this.connected || !this.session) return;
    if (event.isComposing) return;

    event.preventDefault();
    event.stopPropagation();

    if (pressed && (event.code === "CapsLock" || event.code === "NumLock" || event.code === "ScrollLock")) {
      this.session.sync_locks(
        event.getModifierState("ScrollLock"),
        event.getModifierState("NumLock"),
        event.getModifierState("CapsLock")
      );
    }

    const scancode = CODE_TO_SCANCODE[event.code];
    if (scancode !== undefined) {
      this.session.key_scancode(scancode, pressed);
      return;
    }

    if (event.key && event.key.length === 1) {
      const cp = event.key.codePointAt(0);
      if (cp !== undefined) {
        this.session.key_unicode(cp, pressed);
      }
    }
  }

  handleBrowserPaste(event) {
    if (!this.connected || document.activeElement !== this.canvas) return;
    const text = event.clipboardData?.getData("text/plain");
    if (text) {
      this.sendClipboardText(text);
    }
  }

  sendClipboardText(text) {
    if (!this.connected || !this.session || typeof text !== "string") return;
    this.session.copy_text(text);
  }

  sendCtrlAltDel() {
    if (!this.connected || !this.session) return;
    this.session.key_scancode(0x001d, true);
    this.session.key_scancode(0x0038, true);
    this.session.key_scancode(0xe053, true);
    this.session.key_scancode(0xe053, false);
    this.session.key_scancode(0x0038, false);
    this.session.key_scancode(0x001d, false);
  }

  requestViewportResize() {
    if (!this.connected || !this.session) return;
    const { width, height } = this.computeTargetDimensions();
    if (width === this.canvas.width && height === this.canvas.height) return;
    this.session.resize(width, height);
  }

  releaseAllInputs() {
    if (!this.connected || !this.session) return;
    this.session.release_all();
  }

  cleanupSessionOnly() {
    const sess = this.session;
    this.session = null;
    this.connected = false;
    if (sess) {
      try {
        sess.free();
      } catch {
        // Ignore
      }
    }
    if (this.ws) {
      const sock = this.ws;
      this.ws = null;
      try {
        if (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING) {
          sock.close(1000, "Client closed");
        }
      } catch {
        // Ignore
      }
    }
    this.canvas.style.cursor = "default";
  }

  disconnect() {
    clearTimeout(this.resizeTimer);
    this.cleanupSessionOnly();
  }

  destroy() {
    this.destroyed = true;
    this.disconnect();
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener("keydown", this.boundKeyDown);
    this.canvas.removeEventListener("keyup", this.boundKeyUp);
    this.canvas.removeEventListener("mousemove", this.boundMouseMove);
    this.canvas.removeEventListener("mousedown", this.boundMouseDown);
    this.canvas.removeEventListener("mouseup", this.boundMouseUp);
    this.canvas.removeEventListener("wheel", this.boundWheel);
    this.canvas.removeEventListener("contextmenu", this.boundContextMenu);
    this.canvas.removeEventListener("blur", this.boundBlur);
    window.removeEventListener("blur", this.boundBlur);
    document.removeEventListener("paste", this.boundPaste);
  }
}
