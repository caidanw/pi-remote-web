import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir, ProjectTrustStore } from "@earendil-works/pi-coding-agent";

export const DEFAULT_CUSTOMIZATION = Object.freeze({
  version: 1,
  appearance: {
    sidebarWidth: 360,
    rightSidebarWidth: 360,
    density: "comfortable",
  },
  motion: { intensity: "subtle" },
  sound: { enabled: true, volume: 0.2, turnComplete: "" },
  theme: { accent: "", radius: "0.6rem" },
});

const DENSITIES = new Set(["compact", "comfortable", "spacious"]);
const MOTION = new Set(["none", "subtle", "full"]);
const HEX = /^#[0-9a-f]{6}$/i;
const CSS_LEN = /^(?:\d+(?:\.\d+)?)(?:px|rem)$/;

function plainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function warn(warnings, source, path, message) {
  warnings.push({ source, path, message });
}

function numberIn(value, min, max) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function safeRelativeAsset(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  if (/^[a-z]+:/i.test(value) || value.startsWith("//")) return "";
  const cleaned = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (cleaned.startsWith("/") || cleaned.split("/").includes("..")) return "";
  return cleaned;
}

export function validateCustomization(raw, source = "config") {
  const warnings = [];
  const out = {};
  if (!plainObject(raw)) {
    warn(warnings, source, "", "Expected an object");
    return { config: out, warnings };
  }
  for (const key of Object.keys(raw)) {
    if (!["version", "appearance", "motion", "sound", "theme"].includes(key)) {
      warn(warnings, source, key, "Unknown key ignored");
    }
  }
  if (raw.version !== 1) warn(warnings, source, "version", "Only version 1 is supported");
  out.version = 1;

  if (plainObject(raw.appearance)) {
    out.appearance = {};
    const a = raw.appearance;
    for (const key of Object.keys(a)) {
      if (!["sidebarWidth", "rightSidebarWidth", "density"].includes(key)) warn(warnings, source, `appearance.${key}`, "Unknown key ignored");
    }
    if (a.sidebarWidth !== undefined) {
      if (numberIn(a.sidebarWidth, 200, 600)) out.appearance.sidebarWidth = Math.round(a.sidebarWidth);
      else warn(warnings, source, "appearance.sidebarWidth", "Use a number from 200 to 600");
    }
    if (a.rightSidebarWidth !== undefined) {
      if (numberIn(a.rightSidebarWidth, 240, 720)) out.appearance.rightSidebarWidth = Math.round(a.rightSidebarWidth);
      else warn(warnings, source, "appearance.rightSidebarWidth", "Use a number from 240 to 720");
    }
    if (a.density !== undefined) {
      if (DENSITIES.has(a.density)) out.appearance.density = a.density;
      else warn(warnings, source, "appearance.density", "Use compact, comfortable, or spacious");
    }
  }

  if (plainObject(raw.motion)) {
    out.motion = {};
    for (const key of Object.keys(raw.motion)) {
      if (!["intensity"].includes(key)) warn(warnings, source, `motion.${key}`, "Unknown key ignored");
    }
    if (raw.motion.intensity !== undefined) {
      if (MOTION.has(raw.motion.intensity)) out.motion.intensity = raw.motion.intensity;
      else warn(warnings, source, "motion.intensity", "Use none, subtle, or full");
    }
  }

  if (plainObject(raw.sound)) {
    out.sound = {};
    const s = raw.sound;
    for (const key of Object.keys(s)) {
      if (!["enabled", "volume", "turnComplete"].includes(key)) warn(warnings, source, `sound.${key}`, "Unknown key ignored");
    }
    if (s.enabled !== undefined) {
      if (typeof s.enabled === "boolean") out.sound.enabled = s.enabled;
      else warn(warnings, source, "sound.enabled", "Use true or false");
    }
    if (s.volume !== undefined) {
      if (numberIn(s.volume, 0, 1)) out.sound.volume = s.volume;
      else warn(warnings, source, "sound.volume", "Use a number from 0 to 1");
    }
    if (s.turnComplete !== undefined) {
      const asset = safeRelativeAsset(s.turnComplete);
      if (asset || s.turnComplete === "") out.sound.turnComplete = asset;
      else warn(warnings, source, "sound.turnComplete", "Use a relative local path");
    }
  }

  if (plainObject(raw.theme)) {
    out.theme = {};
    const t = raw.theme;
    for (const key of Object.keys(t)) {
      if (!["accent", "radius"].includes(key)) warn(warnings, source, `theme.${key}`, "Unknown key ignored");
    }
    if (t.accent !== undefined) {
      if (typeof t.accent === "string" && (t.accent === "" || HEX.test(t.accent))) out.theme.accent = t.accent;
      else warn(warnings, source, "theme.accent", "Use a #rrggbb color");
    }
    if (t.radius !== undefined) {
      if (typeof t.radius === "string" && CSS_LEN.test(t.radius)) out.theme.radius = t.radius;
      else warn(warnings, source, "theme.radius", "Use px or rem");
    }
  }

  return { config: out, warnings };
}

function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = plainObject(v) && plainObject(out[k]) ? merge(out[k], v) : v;
  }
  return out;
}

async function readConfig(dir, source) {
  const file = path.join(dir, "config.json");
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    const { config, warnings } = validateCustomization(raw, source);
    return { config, warnings, dir };
  } catch (e) {
    if (e && /** @type {{code?: string}} */ (e).code === "ENOENT") return { config: {}, warnings: [], dir };
    return { config: {}, warnings: [{ source, path: "config.json", message: e instanceof Error ? e.message : String(e) }], dir };
  }
}

export function customizationDirs(cwd = process.cwd()) {
  return {
    global: path.join(getAgentDir(), "pi-gui"),
    project: path.join(path.resolve(cwd), ".pi", "pi-gui"),
  };
}

export function isProjectTrusted(cwd = process.cwd()) {
  try {
    return new ProjectTrustStore(getAgentDir()).getEntry(path.resolve(cwd))?.decision === true;
  } catch {
    return false;
  }
}

export async function loadCustomization(cwd = process.cwd()) {
  const dirs = customizationDirs(cwd);
  const global = await readConfig(dirs.global, "global");
  let config = merge(DEFAULT_CUSTOMIZATION, global.config);
  const warnings = [...global.warnings];
  const trusted = isProjectTrusted(cwd);
  if (trusted) {
    const project = await readConfig(dirs.project, "project");
    config = merge(config, project.config);
    warnings.push(...project.warnings);
  }
  return { config, warnings, trustedProject: trusted };
}

export function resolveCustomizationAsset(rel, cwd = process.cwd()) {
  const cleaned = safeRelativeAsset(rel);
  if (!cleaned) return null;
  const dirs = customizationDirs(cwd);
  const roots = isProjectTrusted(cwd) ? [dirs.project, dirs.global] : [dirs.global];
  for (const root of roots) {
    const file = path.resolve(root, cleaned);
    const prefix = path.resolve(root) + path.sep;
    if (!file.startsWith(prefix)) continue;
    if (existsSync(file)) return file;
  }
  return null;
}

export function assetStream(rel, cwd) {
  const file = resolveCustomizationAsset(rel, cwd);
  return file ? createReadStream(file) : null;
}
