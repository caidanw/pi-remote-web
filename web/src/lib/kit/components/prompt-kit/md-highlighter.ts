/**
 * Sync Shiki highlighter for chat markdown (dual light/dark themes).
 * Grammars load in the background (md-langs.ts); until then code renders
 * plain and consumers re-highlight via highlight-ready.svelte.ts.
 */
import {
	escapeHtml,
	type ShikiHighlighter,
} from "@humanspeak/svelte-markdown/extensions/shiki";
import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";


import githubDark from "shiki/themes/github-dark.mjs";
import githubLight from "shiki/themes/github-light.mjs";

const core = createHighlighterCoreSync({
	engine: createJavaScriptRegexEngine(),
	langs: [],
	themes: [githubLight, githubDark],
});

const loadedLangs = new Set<string>();
let ready = false;
const readyListeners = new Set<() => void>();

/** Starts at import time so grammars download alongside app startup, not before it. */
export const highlighterReady: Promise<void> = import("./md-langs.js")
	.then(({ langs }) => {
		core.loadLanguageSync(...langs);
		for (const lang of core.getLoadedLanguages()) loadedLangs.add(lang);
		ready = true;
		for (const listener of readyListeners) listener();
		readyListeners.clear();
	})
	.catch(() => {
		/* stay on plain-text fallback */
	});

export const isHighlighterReady = () => ready;

/** Call `listener` once grammars are loaded; returns an unsubscribe. */
export function whenHighlighterReady(listener: () => void): () => void {
	if (ready) return () => {};
	readyListeners.add(listener);
	return () => readyListeners.delete(listener);
}

function fallback(code: string, lang: string): string {
	const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
	return `<pre class="shiki-fallback"${langAttr}><code>${escapeHtml(code)}</code></pre>`;
}

/** Dual-theme highlighter (CSS vars; see markdown.svelte). */
export const mdHighlighter: ShikiHighlighter = {
	hasLang: (lang) => loadedLangs.has(lang),
	highlight(code, lang) {
		if (!lang || !loadedLangs.has(lang)) return fallback(code, lang);
		try {
			return core.codeToHtml(code, {
				lang,
				themes: { light: "github-light", dark: "github-dark" },
				defaultColor: false,
			});
		} catch {
			return fallback(code, lang);
		}
	},
};

/**
 * Highlight a single line → inner HTML (no &lt;pre&gt;).
 * For diff rows / inline use. Falls back to escaped plain text.
 */
export function highlightInline(code: string, lang: string): string {
	if (!code) return "";
	if (!lang || !loadedLangs.has(lang)) return escapeHtml(code);
	try {
		const html = core.codeToHtml(code, {
			lang,
			themes: { light: "github-light", dark: "github-dark" },
			defaultColor: false,
		});
		const m = html.match(/<code[^>]*>([\s\S]*)<\/code>/);
		return m ? m[1] : escapeHtml(code);
	} catch {
		return escapeHtml(code);
	}
}

/** Map file path → shiki lang id (only langs we load). */
export function langFromPath(path: string): string {
	const base = path.split(/[/\\]/).pop() ?? path;
	const lower = base.toLowerCase();
	if (lower === "dockerfile") return "bash";
	const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
	const map: Record<string, string> = {
		ts: "typescript",
		mts: "typescript",
		cts: "typescript",
		tsx: "tsx",
		js: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		jsx: "jsx",
		json: "json",
		jsonc: "json",
		css: "css",
		html: "html",
		htm: "html",
		svelte: "svelte",
		py: "python",
		rs: "rust",
		go: "go",
		java: "java",
		md: "markdown",
		markdown: "markdown",
		yml: "yaml",
		yaml: "yaml",
		toml: "toml",
		sql: "sql",
		sh: "shellscript",
		bash: "bash",
		zsh: "shellscript",
		diff: "diff",
		patch: "diff",
	};
	// highlight() falls back to plain text until grammars load.
	return map[ext] ?? "";
}
