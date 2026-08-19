import { getCustomization, type CustomizationConfig } from "$lib/api";
import { setFeedbackConfig } from "$lib/feedback";

function hexToHsl(hex: string) {
  const n = Number.parseInt(hex.slice(1), 16);
  let r = ((n >> 16) & 255) / 255;
  let g = ((n >> 8) & 255) / 255;
  let b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

export function applyCustomization(config: CustomizationConfig, cwd?: string) {
  const root = document.documentElement;
  const accent = config.theme?.accent;
  if (accent) {
    root.style.setProperty("--accent", `hsl(${hexToHsl(accent)})`);
    root.style.setProperty("--ring", `hsl(${hexToHsl(accent)})`);
  }
  if (config.theme?.radius) root.style.setProperty("--radius", config.theme.radius);
  if (config.appearance?.sidebarWidth) root.style.setProperty("--pi-sidebar-width", `${config.appearance.sidebarWidth}px`);
  if (config.appearance?.rightSidebarWidth) root.style.setProperty("--pi-right-sidebar-width", `${config.appearance.rightSidebarWidth}px`);
  root.dataset.piDensity = config.appearance?.density ?? "comfortable";
  root.dataset.piMotion = matchMedia("(prefers-reduced-motion: reduce)").matches ? "none" : (config.motion?.intensity ?? "subtle");
  const sound = { ...(config.sound ?? {}) };
  if (sound.turnComplete) {
    sound.turnComplete = `/api/customization/asset?path=${encodeURIComponent(sound.turnComplete)}${cwd ? `&cwd=${encodeURIComponent(cwd)}` : ""}`;
  }
  setFeedbackConfig(sound);
  window.dispatchEvent(new CustomEvent("pi-remote-web:customization", { detail: config }));
}

export async function loadAndApplyCustomization(cwd?: string) {
  const res = await getCustomization(cwd);
  applyCustomization(res.config, cwd);
  return res;
}
