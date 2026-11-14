import indexHtml from "../public/index.html" with { type: "file" };
import stylesCss from "../public/styles.css" with { type: "file" };
import appJs from "../public/app.js" with { type: "file" };
import rdpViewerJs from "../public/rdp-viewer.js" with { type: "file" };
import wallpaperJpg from "../public/wallpaper.jpg" with { type: "file" };
import rdpWasmJs from "../public/wasm/rdp_wasm.js" with { type: "file" };
import rdpWasmBg from "../public/wasm/rdp_wasm_bg.wasm" with { type: "file" };
import onConnectSh from "../scripts/on-connect.sh" with { type: "file" };
import antigravitySettingsJson from "../config/antigravity_settings.json" with { type: "file" };
import anthropicSettingsJson from "../config/anthropic_settings.json" with { type: "file" };

export const EMBEDDED_ON_CONNECT_SCRIPT: string = onConnectSh;
export const EMBEDDED_WALLPAPER_JPG: string = wallpaperJpg;
export const EMBEDDED_ANTIGRAVITY_SETTINGS_JSON: string = antigravitySettingsJson;
export const EMBEDDED_ANTHROPIC_SETTINGS_JSON: string = anthropicSettingsJson;

export const EMBEDDED_PUBLIC_FILES: Record<string, { filePath: string; contentType: string }> = {
  "/index.html": { filePath: indexHtml, contentType: "text/html; charset=utf-8" },
  "/styles.css": { filePath: stylesCss, contentType: "text/css; charset=utf-8" },
  "/app.js": { filePath: appJs, contentType: "application/javascript; charset=utf-8" },
  "/rdp-viewer.js": { filePath: rdpViewerJs, contentType: "application/javascript; charset=utf-8" },
  "/wallpaper.jpg": { filePath: wallpaperJpg, contentType: "image/jpeg" },
  "/wasm/rdp_wasm.js": { filePath: rdpWasmJs, contentType: "application/javascript; charset=utf-8" },
  "/wasm/rdp_wasm_bg.wasm": { filePath: rdpWasmBg, contentType: "application/wasm" },
};
