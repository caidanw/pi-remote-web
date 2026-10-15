<script lang="ts">
  import Markdown from "agentic-ui-kit/components/prompt-kit/markdown.svelte";

  let { body }: { body: string } = $props();
  let open = $state(false);
  const title = $derived(body.match(/^\s*\*\*(.+?)\*\*/)?.[1]?.trim() || "Thinking");
</script>

<details class="group/think min-w-0" bind:open>
  <summary
    class="flex w-fit max-w-full cursor-pointer list-none items-center gap-1.5 text-[12px] text-muted-foreground select-none hover:text-foreground [&::-webkit-details-marker]:hidden"
  >
    <span class="truncate">{title}</span>
    <span class="shrink-0 transition-transform group-open/think:rotate-90" aria-hidden="true">▸</span>
  </summary>
  {#if open}
    <div class="mt-1.5 border-l-2 border-border/70 pl-3 text-[13px] text-muted-foreground">
      <Markdown content={body} compact={true} />
    </div>
  {/if}
</details>
