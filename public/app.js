import { RdpViewer } from "./rdp-viewer.js";

const urlParams = new URLSearchParams(window.location.search);
const queryUserParam = urlParams.get("user")?.trim() || "";

const state = {
  csrfToken: "",
  authSource: "",
  user: null,
  rdpPassword: "",
  viewer: null,
  connecting: false,
  isStandaloneTab:
    window.location.pathname === "/desktop" || urlParams.get("view") === "desktop",
};

// Cross-tab coordination so opening "/desktop" disconnects the embedded viewer cleanly
const handoffChannel =
  typeof BroadcastChannel === "function" ? new BroadcastChannel("apigee_ai_demos_rdp") : null;

const el = {
  unauthView: document.getElementById("unauth-view"),
  unauthAlert: document.getElementById("unauth-alert"),
  userSelectForm: document.getElementById("user-select-form"),
  userParamInput: document.getElementById("user-param-input"),
  userSelectSubmit: document.getElementById("user-select-submit"),

  workspaceView: document.getElementById("workspace-view"),
  navToggleBtn: document.getElementById("nav-toggle-btn"),
  navRail: document.getElementById("nav-rail"),
  topbarBrandLink: document.getElementById("topbar-brand-link"),
  standaloneBadge: document.getElementById("standalone-badge"),
  openNewTabLink: document.getElementById("open-new-tab-link"),
  themeToggleBtn: document.getElementById("theme-toggle-btn"),
  topbarUserEmail: document.getElementById("topbar-user-email"),
  logoutBtn: document.getElementById("logout-btn"),
  sidebarVmUser: document.getElementById("sidebar-vm-user"),
  sidebarVmHome: document.getElementById("sidebar-vm-home"),

  rdpStatusDot: document.getElementById("rdp-status-dot"),
  rdpStatusText: document.getElementById("rdp-status-text"),
  clipboardBtn: document.getElementById("clipboard-btn"),
  cadBtn: document.getElementById("cad-btn"),
  fullscreenBtn: document.getElementById("fullscreen-btn"),
  disconnectBtn: document.getElementById("disconnect-btn"),

  rdpViewport: document.getElementById("rdp-viewport"),
  rdpCanvas: document.getElementById("rdp-canvas"),
  rdpConnectOverlay: document.getElementById("rdp-connect-overlay"),
  overlayHeading: document.getElementById("overlay-heading"),
  overlayDesc: document.getElementById("overlay-desc"),
  overlayUsername: document.getElementById("overlay-username"),
  rdpErrorBanner: document.getElementById("rdp-error-banner"),
  rdpReconnectBtn: document.getElementById("rdp-reconnect-btn"),

  clipboardDialog: document.getElementById("clipboard-dialog"),
  closeClipboardDialogBtn: document.getElementById("close-clipboard-dialog-btn"),
  closeClipboardBtn: document.getElementById("close-clipboard-btn"),
  clipboardForm: document.getElementById("clipboard-form"),
  clipboardTextarea: document.getElementById("clipboard-textarea"),
};

function setBanner(bannerEl, message) {
  if (!message) {
    bannerEl.hidden = true;
    bannerEl.textContent = "";
    return;
  }
  bannerEl.textContent = message;
  bannerEl.hidden = false;
}

function installDialogLightDismissFallback(dialogEl) {
  if (!("closedBy" in HTMLDialogElement.prototype)) {
    dialogEl.addEventListener("click", (event) => {
      if (event.target !== dialogEl) return;
      const rect = dialogEl.getBoundingClientRect();
      const inside =
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width;
      if (!inside) {
        dialogEl.close();
      }
    });
  }
}

function setupThemeToggle() {
  const meta = document.querySelector('meta[name="color-scheme"]');
  const sysDarkQuery = window.matchMedia("(prefers-color-scheme: dark)");

  const applyScheme = (scheme) => {
    document.documentElement.classList.remove("theme-light", "theme-dark");
    if (scheme === "light" || scheme === "dark") {
      meta.content = scheme;
      document.documentElement.classList.add(`theme-${scheme}`);
      localStorage.setItem("color-scheme", scheme);
    } else {
      meta.content = "light dark";
      localStorage.removeItem("color-scheme");
    }
  };

  el.themeToggleBtn.addEventListener("click", () => {
    const pinned = localStorage.getItem("color-scheme");
    const systemScheme = sysDarkQuery.matches ? "dark" : "light";
    const oppositeOfSystem = systemScheme === "dark" ? "light" : "dark";

    if (!pinned) {
      applyScheme(oppositeOfSystem);
    } else {
      applyScheme(null);
    }
  });
}

function withUserQuery(basePath) {
  if (!queryUserParam) return basePath;
  const sep = basePath.includes("?") ? "&" : "?";
  return `${basePath}${sep}user=${encodeURIComponent(queryUserParam)}`;
}

async function apiPost(path, payload) {
  const headers = { "Content-Type": "application/json" };
  if (state.csrfToken) {
    headers["X-CSRF-Token"] = state.csrfToken;
  }
  const resp = await fetch(withUserQuery(path), {
    method: "POST",
    credentials: "same-origin",
    headers,
    body: JSON.stringify(payload || {}),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.error || `Request failed (${resp.status})`);
  }
  return data;
}

function showExclusiveView(target) {
  el.unauthView.hidden = target !== "unauth";
  el.workspaceView.hidden = target !== "workspace";
}

function ensureRdpViewer() {
  if (state.viewer) return state.viewer;
  state.viewer = new RdpViewer({
    canvas: el.rdpCanvas,
    viewport: el.rdpViewport,
    onStatus: (status, detail) => {
      el.rdpStatusDot.dataset.state = status === "error" ? "disconnected" : status;

      if (status === "connected") {
        state.connecting = false;
        el.rdpStatusText.textContent = detail ? `Connected · ${detail}` : "Connected";
        el.rdpConnectOverlay.hidden = true;
        el.disconnectBtn.hidden = false;
        el.clipboardBtn.disabled = false;
        el.cadBtn.disabled = false;
        el.rdpReconnectBtn.hidden = true;
        setBanner(el.rdpErrorBanner, "");
      } else if (status === "connecting") {
        state.connecting = true;
        const msg = detail || "Connecting…";
        el.rdpStatusText.textContent = msg;
        el.overlayHeading.textContent = "Connecting to desktop";
        el.overlayDesc.textContent = msg;
        el.rdpConnectOverlay.hidden = false;
        el.rdpReconnectBtn.hidden = true;
      } else if (status === "error") {
        state.connecting = false;
        el.rdpStatusText.textContent = "Disconnected";
        el.overlayHeading.textContent = "Connection interrupted";
        el.overlayDesc.textContent = `Signed in as ${state.user?.email || ""} (${state.user?.username || ""}).`;
        el.rdpConnectOverlay.hidden = false;
        el.rdpReconnectBtn.hidden = false;
        el.disconnectBtn.hidden = true;
        el.clipboardBtn.disabled = true;
        el.cadBtn.disabled = true;
        setBanner(el.rdpErrorBanner, detail || "Unable to establish xrdp session.");
      } else {
        state.connecting = false;
        el.rdpStatusText.textContent = detail || "Disconnected";
        el.overlayHeading.textContent = detail === "Moved to new tab" ? "Active in new tab" : "Desktop disconnected";
        el.overlayDesc.textContent = `Linux session user: ${state.user?.username || ""}`;
        el.rdpConnectOverlay.hidden = false;
        el.rdpReconnectBtn.hidden = false;
        el.disconnectBtn.hidden = true;
        el.clipboardBtn.disabled = true;
        el.cadBtn.disabled = true;
      }
    },
    onRemoteClipboard: (text) => {
      el.clipboardTextarea.value = text;
    },
  });
  return state.viewer;
}

async function provisionAndAutoConnect() {
  if (!state.user || state.connecting) return;
  state.connecting = true;
  setBanner(el.rdpErrorBanner, "");
  el.rdpConnectOverlay.hidden = false;
  el.rdpReconnectBtn.hidden = true;
  el.rdpStatusDot.dataset.state = "connecting";
  el.overlayHeading.textContent = "Preparing workstation";
  el.overlayDesc.textContent = `Ensuring Linux user '${state.user.username}' is ready…`;
  el.rdpStatusText.textContent = `Provisioning '${state.user.username}'…`;

  try {
    const ensured = await apiPost("/api/vm-user/ensure", {});
    state.user = ensured.user;
    state.rdpPassword = ensured.rdpPassword;
    el.sidebarVmUser.textContent = state.user.username;
    el.sidebarVmHome.textContent = state.user.homeDir;

    const viewer = ensureRdpViewer();
    await viewer.connect({
      username: state.user.username,
      password: state.rdpPassword,
    });
  } catch (err) {
    state.connecting = false;
    el.rdpStatusDot.dataset.state = "disconnected";
    el.rdpStatusText.textContent = "Disconnected";
    el.overlayHeading.textContent = "Provisioning failed";
    el.overlayDesc.textContent = `Could not prepare Linux user '${state.user.username}'.`;
    el.rdpReconnectBtn.hidden = false;
    setBanner(el.rdpErrorBanner, err.message);
  }
}

function renderAuthenticatedWorkspace() {
  el.topbarUserEmail.textContent = state.user.email;
  el.sidebarVmUser.textContent = state.user.username;
  el.sidebarVmHome.textContent = `/home/${state.user.username}`;
  el.overlayUsername.textContent = state.user.username;
  el.topbarBrandLink.href = withUserQuery("/");
  el.openNewTabLink.href = withUserQuery("/desktop");
  el.logoutBtn.hidden = state.authSource === "iap";

  if (state.isStandaloneTab) {
    el.navRail.hidden = true;
    el.navToggleBtn.hidden = true;
    el.openNewTabLink.hidden = true;
    el.standaloneBadge.hidden = false;
    document.title = `Desktop (${state.user.username}) · Apigee AI Demos`;
    if (handoffChannel) {
      handoffChannel.postMessage({ type: "claimed_standalone_tab", username: state.user.username });
    }
  } else {
    el.standaloneBadge.hidden = true;
    el.openNewTabLink.hidden = false;
  }

  showExclusiveView("workspace");
  ensureRdpViewer();
  void provisionAndAutoConnect();
}

async function bootstrap() {
  setupThemeToggle();
  installDialogLightDismissFallback(el.clipboardDialog);

  if (state.isStandaloneTab) {
    el.userSelectForm.action = "/desktop";
  }

  if (handoffChannel) {
    handoffChannel.addEventListener("message", (event) => {
      const msg = event.data;
      if (!msg || !state.user || msg.username !== state.user.username) return;
      if (msg.type === "claimed_standalone_tab" && !state.isStandaloneTab && state.viewer?.connected) {
        state.viewer.disconnect();
        el.rdpStatusDot.dataset.state = "disconnected";
        el.rdpStatusText.textContent = "Moved to new tab";
        el.overlayHeading.textContent = "Session open in new tab";
        el.overlayDesc.textContent = `Linux desktop for '${state.user.username}' was transferred to the standalone tab.`;
        el.rdpConnectOverlay.hidden = false;
        el.rdpReconnectBtn.hidden = false;
        el.disconnectBtn.hidden = true;
      }
    });
  }

  el.navToggleBtn.addEventListener("click", () => {
    const nextHidden = !el.navRail.hidden;
    el.navRail.hidden = nextHidden;
    el.navToggleBtn.setAttribute("aria-expanded", String(!nextHidden));
  });

  el.rdpReconnectBtn.addEventListener("click", () => {
    void provisionAndAutoConnect();
  });

  el.disconnectBtn.addEventListener("click", () => {
    state.viewer?.disconnect();
    el.rdpStatusDot.dataset.state = "disconnected";
    el.rdpStatusText.textContent = "Disconnected";
    el.overlayHeading.textContent = "Desktop disconnected";
    el.overlayDesc.textContent = `Linux session user: ${state.user?.username || ""}`;
    el.rdpConnectOverlay.hidden = false;
    el.rdpReconnectBtn.hidden = false;
    el.disconnectBtn.hidden = true;
    el.clipboardBtn.disabled = true;
    el.cadBtn.disabled = true;
  });

  el.cadBtn.addEventListener("click", () => {
    state.viewer?.sendCtrlAltDel();
    el.rdpCanvas.focus();
  });

  el.fullscreenBtn.addEventListener("click", () => {
    if (!document.fullscreenElement) {
      el.rdpViewport.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  });

  // Clipboard modal
  el.clipboardBtn.addEventListener("click", () => {
    el.clipboardDialog.showModal();
  });
  el.closeClipboardDialogBtn.addEventListener("click", () => el.clipboardDialog.close());
  el.closeClipboardBtn.addEventListener("click", () => el.clipboardDialog.close());
  el.clipboardForm.addEventListener("submit", (e) => {
    e.preventDefault();
    state.viewer?.sendClipboardText(el.clipboardTextarea.value);
    el.clipboardDialog.close();
    el.rdpCanvas.focus();
  });

  el.logoutBtn.addEventListener("click", async () => {
    state.viewer?.disconnect();
    try {
      await apiPost("/api/auth/logout", {});
    } catch {
      // Ignore
    }
    window.location.href = state.isStandaloneTab ? "/desktop" : "/";
  });

  const resp = await fetch(withUserQuery("/api/me"), { credentials: "same-origin" });
  const data = await resp.json().catch(() => ({}));

  if (!data.authenticated) {
    if (data.error) {
      setBanner(el.unauthAlert, data.error);
    }
    showExclusiveView("unauth");
    return;
  }

  state.csrfToken = data.csrfToken;
  state.authSource = data.authSource;
  state.user = data.user;
  renderAuthenticatedWorkspace();
}

bootstrap();
