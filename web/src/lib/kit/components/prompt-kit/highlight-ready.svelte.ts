import { isHighlighterReady, whenHighlighterReady } from "./md-highlighter.js";

/** Reactive "grammars loaded" flag; read it in a $derived to re-highlight once. */
export const highlightState = $state({ ready: isHighlighterReady() });
whenHighlighterReady(() => (highlightState.ready = true));
