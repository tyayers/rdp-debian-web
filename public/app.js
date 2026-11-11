import { RdpViewer } from "./rdp-viewer.js";

const AUTH_ERROR_MESSAGES = {
  domain_not_allowed: "Access denied: only @google.com Google accounts are permitted.",
  oauth_not_configured:
    "Google OAuth credentials (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) are not configured on the server.",
  access_denied: "Google sign-in was cancelled.",
  expired_state: "Sign-in session expired. Please try again.",
  state_mismatch: "Sign-in state verification failed. Please try again.",
  token_exchange_failed: "Could not verify Google authorization code.",
  unverified_email: "Your Google account email address is not verified.",
  invalid_username: "Could not map your Google email to a valid Linux VM username.",
};

const state = {
  csrfToken: "",
  user: null,
  vmUser: null,
  ephemeralVmPassword: "", // Kept strictly in tab memory for seamless connect/handoff
  viewer: null,
  isStandaloneTab:
    window.location.pathname === "/desktop" ||
    new URLSearchParams(window.location.search).get("view") === "desktop",
};

// Cross-tab ephemeral session handoff when clicking "Open in new tab"
const handoffChannel =
  typeof BroadcastChannel === "function" ? new BroadcastChannel("apigee_ai_demos_rdp") : null;

const el = {
  loginView: document.getElementById("login-view"),
  loginAlert: document.getElementById("login-alert"),
  googleLoginLink: document.getElementById("google-login-link"),
  devLoginForm: document.getElementById("dev-login-form"),
  devEmailInput: document.getElementById("dev-email"),
  devLoginSubmit: document.getElementById("dev-login-submit"),

  setupView: document.getElementById("setup-view"),
  setupEmailDisplay: document.getElementById("setup-email-display"),
  setupUsernameInput: document.getElementById("setup-username"),
  setupPasswordInput: document.getElementById("new-password"),
  toggleSetupPasswordBtn: document.getElementById("toggle-setup-password"),
  setupForm: document.getElementById("setup-form"),
  setupSubmitBtn: document.getElementById("setup-submit-btn"),
  setupAlert: document.getElementById("setup-alert"),
  setupLogoutBtn: document.getElementById("setup-logout-btn"),

  workspaceView: document.getElementById("workspace-view"),
  navToggleBtn: document.getElementById("nav-toggle-btn"),
  navRail: document.getElementById("nav-rail"),
  standaloneBadge: document.getElementById("standalone-badge"),
  openNewTabLink: document.getElementById("open-new-tab-link"),
  openPasswordModalBtn: document.getElementById("open-password-modal-btn"),
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
  rdpErrorBanner: document.getElementById("rdp-error-banner"),
  rdpConnectForm: document.getElementById("rdp-connect-form"),
  rdpUsernameInput: document.getElementById("rdp-username"),
  rdpPasswordInput: document.getElementById("current-password"),
  toggleRdpPasswordBtn: document.getElementById("toggle-rdp-password"),
  rdpConnectBtn: document.getElementById("rdp-connect-btn"),
  resetRdpPasswordBtn: document.getElementById("reset-rdp-password-btn"),

  passwordDialog: document.getElementById("password-dialog"),
  closePasswordDialogBtn: document.getElementById("close-password-dialog-btn"),
  cancelPasswordDialogBtn: document.getElementById("cancel-password-dialog-btn"),
  modalVmUsername: document.getElementById("modal-vm-username"),
  modalUsernameInput: document.getElementById("modal-username-input"),
  modalNewPasswordInput: document.getElementById("modal-new-password"),
  toggleModalPasswordBtn: document.getElementById("toggle-modal-password"),
  changePasswordForm: document.getElementById("change-password-form"),
  savePasswordBtn: document.getElementById("save-password-btn"),
  passwordModalAlert: document.getElementById("password-modal-alert"),

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

function wirePasswordVisibilityToggle(buttonEl, inputEl) {
  buttonEl.addEventListener("click", () => {
    const showing = inputEl.type === "text";
    inputEl.type = showing ? "password" : "text";
    buttonEl.setAttribute("aria-pressed", String(!showing));
    const labelSpan = buttonEl.querySelector(".toggle-text");
    if (labelSpan) {
      labelSpan.textContent = showing ? "Show" : "Hide";
    }
  });
}

// Mandatory fallback for <dialog closedby="any"> on browsers without HTMLDialogElement.prototype.closedBy
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

// Validate on blur, clear custom validity on input
function wireBlurValidation(inputEl) {
  inputEl.addEventListener("input", () => {
    inputEl.setCustomValidity("");
  });
  inputEl.addEventListener("blur", () => {
    if (inputEl.value.length > 0 && inputEl.minLength > 0 && inputEl.value.length < inputEl.minLength) {
      inputEl.setCustomValidity(`Please enter at least ${inputEl.minLength} characters.`);
      inputEl.reportValidity();
    }
  });
}

// Two-state color-scheme toggle (system setting vs pinned opposite)
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

async function apiPost(path, payload) {
  const headers = { "Content-Type": "application/json" };
  if (state.csrfToken) {
    headers["X-CSRF-Token"] = state.csrfToken;
  }
  const resp = await fetch(path, {
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
  el.loginView.hidden = target !== "login";
  el.setupView.hidden = target !== "setup";
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
        el.rdpStatusText.textContent = detail ? `Connected · ${detail}` : "Connected";
        el.rdpConnectOverlay.hidden = true;
        el.disconnectBtn.hidden = false;
        el.clipboardBtn.disabled = false;
        el.cadBtn.disabled = false;
        el.rdpConnectBtn.disabled = false;
        setBanner(el.rdpErrorBanner, "");
      } else if (status === "connecting") {
        el.rdpStatusText.textContent = detail || "Connecting…";
        el.rdpConnectBtn.disabled = true;
      } else if (status === "error") {
        el.rdpStatusText.textContent = "Disconnected";
        el.rdpConnectOverlay.hidden = false;
        el.disconnectBtn.hidden = true;
        el.clipboardBtn.disabled = true;
        el.cadBtn.disabled = true;
        el.rdpConnectBtn.disabled = false;
        setBanner(el.rdpErrorBanner, detail || "Unable to establish xrdp session.");
      } else {
        el.rdpStatusText.textContent = detail || "Disconnected";
        el.rdpConnectOverlay.hidden = false;
        el.disconnectBtn.hidden = true;
        el.clipboardBtn.disabled = true;
        el.cadBtn.disabled = true;
        el.rdpConnectBtn.disabled = false;
      }
    },
    onRemoteClipboard: (text) => {
      el.clipboardTextarea.value = text;
    },
  });
  return state.viewer;
}

function startRdpSession(password) {
  if (!state.user || !password) return;
  state.ephemeralVmPassword = password;
  el.rdpPasswordInput.value = password;
  setBanner(el.rdpErrorBanner, "");
  const viewer = ensureRdpViewer();
  viewer.connect({
    username: state.user.username,
    password,
  });
}

function renderAuthenticatedApp() {
  if (!state.vmUser?.provisioned) {
    el.setupEmailDisplay.textContent = state.user.email;
    el.setupUsernameInput.value = state.user.username;
    el.setupPasswordInput.value = "";
    showExclusiveView("setup");
    return;
  }

  el.topbarUserEmail.textContent = state.user.email;
  el.sidebarVmUser.textContent = state.user.username;
  el.sidebarVmHome.textContent = state.vmUser.homeDir;
  el.rdpUsernameInput.value = state.user.username;
  el.modalVmUsername.textContent = state.user.username;
  el.modalUsernameInput.value = state.user.username;

  if (state.isStandaloneTab) {
    el.navRail.hidden = true;
    el.navToggleBtn.hidden = true;
    el.openNewTabLink.hidden = true;
    el.standaloneBadge.hidden = false;
    document.title = `Desktop (${state.user.username}) · Apigee AI Demos`;
  } else {
    el.standaloneBadge.hidden = true;
    el.openNewTabLink.hidden = false;
  }

  showExclusiveView("workspace");
  ensureRdpViewer();

  if (state.ephemeralVmPassword) {
    startRdpSession(state.ephemeralVmPassword);
  } else if (state.isStandaloneTab && handoffChannel) {
    handoffChannel.postMessage({ type: "request_handoff", username: state.user.username });
  }
}

async function bootstrap() {
  setupThemeToggle();
  installDialogLightDismissFallback(el.passwordDialog);
  installDialogLightDismissFallback(el.clipboardDialog);

  wirePasswordVisibilityToggle(el.toggleSetupPasswordBtn, el.setupPasswordInput);
  wirePasswordVisibilityToggle(el.toggleRdpPasswordBtn, el.rdpPasswordInput);
  wirePasswordVisibilityToggle(el.toggleModalPasswordBtn, el.modalNewPasswordInput);

  wireBlurValidation(el.setupPasswordInput);
  wireBlurValidation(el.modalNewPasswordInput);

  // Check URL for OAuth callback errors
  const params = new URLSearchParams(window.location.search);
  const authError = params.get("auth_error");
  if (authError) {
    setBanner(
      el.loginAlert,
      AUTH_ERROR_MESSAGES[authError] || `Authentication failed (${authError}).`
    );
    window.history.replaceState({}, "", window.location.pathname);
  }

  if (state.isStandaloneTab) {
    el.googleLoginLink.href = "/api/auth/google/login?return_to=%2Fdesktop";
  }

  // Listen for cross-tab handoff when user clicks "Open in new tab"
  if (handoffChannel) {
    handoffChannel.addEventListener("message", (event) => {
      const msg = event.data;
      if (!msg || !state.user || msg.username !== state.user.username) return;

      if (msg.type === "request_handoff" && !state.isStandaloneTab && state.ephemeralVmPassword) {
        // Disconnect embedded viewer cleanly so the new tab claims the xrdp session seamlessly
        if (state.viewer?.connected) {
          state.viewer.disconnect();
          el.rdpStatusText.textContent = "Moved to new tab";
          el.rdpConnectOverlay.hidden = false;
          el.disconnectBtn.hidden = true;
        }
        handoffChannel.postMessage({
          type: "handoff_credentials",
          username: state.user.username,
          password: state.ephemeralVmPassword,
        });
      } else if (
        msg.type === "handoff_credentials" &&
        state.isStandaloneTab &&
        !state.viewer?.connected &&
        msg.password
      ) {
        startRdpSession(msg.password);
      }
    });
  }

  // Sidebar collapse
  el.navToggleBtn.addEventListener("click", () => {
    const nextHidden = !el.navRail.hidden;
    el.navRail.hidden = nextHidden;
    el.navToggleBtn.setAttribute("aria-expanded", String(!nextHidden));
  });

  // Dev login form (only visible when ALLOW_DEV_AUTH=true)
  el.devLoginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    setBanner(el.loginAlert, "");
    el.devLoginSubmit.disabled = true;
    try {
      await apiPost("/api/auth/dev-login", { email: el.devEmailInput.value });
      await refreshSession();
    } catch (err) {
      setBanner(el.loginAlert, err.message);
    } finally {
      el.devLoginSubmit.disabled = false;
    }
  });

  // First-time VM user creation + password setup
  el.setupForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    setBanner(el.setupAlert, "");
    if (!el.setupForm.reportValidity()) return;

    const chosenPassword = el.setupPasswordInput.value;
    el.setupSubmitBtn.disabled = true;
    try {
      const res = await apiPost("/api/vm-user/password", { password: chosenPassword });
      state.vmUser = res.vmUser;
      state.ephemeralVmPassword = chosenPassword;
      renderAuthenticatedApp();
    } catch (err) {
      setBanner(el.setupAlert, err.message);
    } finally {
      el.setupSubmitBtn.disabled = false;
    }
  });

  // Connect to xrdp form
  el.rdpConnectForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!el.rdpConnectForm.reportValidity()) return;
    startRdpSession(el.rdpPasswordInput.value);
  });

  // Session toolbar controls
  el.disconnectBtn.addEventListener("click", () => {
    state.viewer?.disconnect();
    el.rdpStatusDot.dataset.state = "disconnected";
    el.rdpStatusText.textContent = "Disconnected";
    el.rdpConnectOverlay.hidden = false;
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

  // Change / reset VM password modal (from top bar or connect card)
  const openPasswordDialog = () => {
    setBanner(el.passwordModalAlert, "");
    el.modalNewPasswordInput.value = "";
    el.passwordDialog.showModal();
  };
  el.openPasswordModalBtn.addEventListener("click", openPasswordDialog);
  el.resetRdpPasswordBtn.addEventListener("click", openPasswordDialog);
  el.closePasswordDialogBtn.addEventListener("click", () => el.passwordDialog.close());
  el.cancelPasswordDialogBtn.addEventListener("click", () => el.passwordDialog.close());

  el.changePasswordForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    setBanner(el.passwordModalAlert, "");
    if (!el.changePasswordForm.reportValidity()) return;

    const newPassword = el.modalNewPasswordInput.value;
    el.savePasswordBtn.disabled = true;
    try {
      const res = await apiPost("/api/vm-user/password", { password: newPassword });
      state.vmUser = res.vmUser;
      state.ephemeralVmPassword = newPassword;
      el.rdpPasswordInput.value = newPassword;
      el.passwordDialog.close();
      if (!state.viewer?.connected) {
        setBanner(
          el.rdpErrorBanner,
          `Linux password updated for '${state.user.username}'. Click Connect to desktop to sign in.`
        );
      }
    } catch (err) {
      setBanner(el.passwordModalAlert, err.message);
    } finally {
      el.savePasswordBtn.disabled = false;
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

  // Logout buttons
  const doLogout = async () => {
    state.viewer?.disconnect();
    state.ephemeralVmPassword = "";
    try {
      await apiPost("/api/auth/logout", {});
    } catch {
      // Ignore
    }
    window.location.href = "/";
  };
  el.logoutBtn.addEventListener("click", doLogout);
  el.setupLogoutBtn.addEventListener("click", doLogout);

  await refreshSession();
}

async function refreshSession() {
  const resp = await fetch("/api/me", { credentials: "same-origin" });
  const data = await resp.json();

  if (!data.authenticated) {
    el.devLoginForm.hidden = !data.devAuthEnabled;
    if (!data.oauthConfigured && !data.devAuthEnabled && el.loginAlert.hidden) {
      setBanner(
        el.loginAlert,
        "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (or ALLOW_DEV_AUTH=true for local testing) to sign in."
      );
    }
    showExclusiveView("login");
    return;
  }

  state.csrfToken = data.csrfToken;
  state.user = data.user;
  state.vmUser = data.vmUser;
  renderAuthenticatedApp();
}

bootstrap();
