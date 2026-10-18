<script lang="ts">
  /** pi-subagents traffic: notices to the parent, and the user-role wake that follows them. */
  import type { MessageRendererProps } from "$lib/plugins/registry";
  import SpecialMessageCard from "$lib/components/SpecialMessageCard.svelte";
  import { isSubagentWake } from "$lib/work-section";
  import Message from "agentic-ui-kit/components/prompt-kit/message.svelte";

  let { message, text }: MessageRendererProps = $props();

  const details = $derived((message.details ?? {}) as { agent?: unknown; requestBody?: unknown });
  // A supervisor request's own text says what is being asked; its first line is boilerplate.
  const ask = $derived(typeof details.requestBody === "string" ? details.requestBody.trim() : "");
  const lines = $derived(text.trim().split("\n"));
  const title = $derived(
    (ask.split("\n")[0] || lines[0] || "Subagent update").replaceAll("**", "").trim(),
  );
  const body = $derived(ask ? text.trim() : lines.slice(1).join("\n").trim());
  // Requests and control notices wait on the parent (or you); results are informational.
  const needsAnswer = $derived(
    message.customType === "subagent_supervisor_request" ||
      message.customType === "subagent_control_notice",
  );
</script>

{#if isSubagentWake(message)}
  <!-- Not typed by the user: pi-subagents sends it to wake the parent for the notices above. -->
  <div class="flex items-center gap-1.5 px-0.5 text-[12px] text-muted-foreground" title={text}>
    <span aria-hidden="true">↻</span>
    <span>Pi picked up subagent updates</span>
  </div>
{:else}
  <Message class="justify-start">
    <SpecialMessageCard
      kind="subagent"
      {title}
      {body}
      meta={typeof details.agent === "string" ? details.agent : ""}
      status={needsAnswer ? "warning" : "done"}
    />
  </Message>
{/if}
