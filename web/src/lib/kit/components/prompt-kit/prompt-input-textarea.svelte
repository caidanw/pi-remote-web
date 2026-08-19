<script lang="ts">
	import { cn } from "$lib/utils";
	import { autosizeHeight } from "../../../autosize";
	import { getPromptInputContext } from "./prompt-input-context.js";

	type Props = {
		class?: string;
		maxRows?: number;
		disableAutosize?: boolean;
		onkeydown?: (e: KeyboardEvent) => void;
		placeholder?: string;
		[key: string]: unknown;
	};

	let {
		class: className,
		onkeydown,
		maxRows = 3,
		disableAutosize = false,
		...rest
	}: Props = $props();

	const ctx = getPromptInputContext();
	let textareaEl = $state<HTMLTextAreaElement | null>(null);

	function resize(el: HTMLTextAreaElement) {
		const styles = getComputedStyle(el);
		const lineHeight = parseFloat(styles.lineHeight) || parseFloat(styles.fontSize) * 1.4;
		const chrome =
			styles.boxSizing === "border-box"
				? parseFloat(styles.paddingTop) +
					parseFloat(styles.paddingBottom) +
					parseFloat(styles.borderTopWidth) +
					parseFloat(styles.borderBottomWidth)
				: 0;
		// Collapse to 0 first: "auto" keeps a stretched height in Safari, which
		// otherwise reports a scrollHeight of the whole composer.
		el.style.height = "0px";
		const { height, scrollable } = autosizeHeight({
			scrollHeight: el.scrollHeight,
			lineHeight,
			chrome,
			maxRows,
			maxHeight: ctx.maxHeight,
		});
		el.style.height = `${height}px`;
		el.style.overflowY = scrollable ? "auto" : "hidden";
	}

	$effect(() => {
		if (disableAutosize) return;
		const el = textareaEl;
		if (!el) return;
		// track value for resize
		void ctx.value;
		resize(el);
		// Rotation, keyboard, and container changes must re-measure too.
		const observer = new ResizeObserver(() => resize(el));
		observer.observe(el.parentElement ?? el);
		return () => observer.disconnect();
	});

	function handleKeyDown(e: KeyboardEvent) {
		// Alt+Enter reserved for follow-up (pi-tui); Shift+Enter = newline
		if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
			e.preventDefault();
			ctx.onSubmit?.();
		}
		onkeydown?.(e);
	}
</script>

<textarea
	bind:this={textareaEl}
	data-slot="textarea"
	value={ctx.value}
	oninput={(e) => ctx.setValue((e.currentTarget as HTMLTextAreaElement).value)}
	onkeydown={handleKeyDown}
	class={cn(
		"border-input placeholder:text-muted-foreground ring-ring/10 dark:ring-ring/20 dark:outline-ring/40 outline-ring/50 aria-invalid:outline-destructive/60 dark:aria-invalid:outline-destructive dark:aria-invalid:ring-destructive/40 aria-invalid:ring-destructive/20 aria-invalid:border-destructive/60 dark:aria-invalid:border-destructive dark:aria-invalid:ring-destructive/50 flex w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] focus-visible:ring-4 focus-visible:outline-1 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:focus-visible:ring-[3px] aria-invalid:focus-visible:outline-none md:text-sm dark:aria-invalid:focus-visible:ring-4",
		"text-primary min-h-[44px] w-full resize-none border-none bg-transparent shadow-none outline-none focus-visible:ring-0 focus-visible:ring-offset-0",
		className
	)}
	rows={1}
	disabled={ctx.disabled}
	{...rest}
></textarea>
