<script lang="ts" module>
  import type { ModelInfo } from "$lib/api";
  /** Shared across ModelPicker instances for the page lifetime. */
  const ModelPicker_cache = new Map<string, ModelInfo[]>();

  /** Bust after scoped-models Apply so the select reflects the new set. */
  export function clearModelPickerCache(sessionId?: string) {
    if (sessionId) {
      ModelPicker_cache.delete(`s:${sessionId}`);
      ModelPicker_cache.delete("full");
    } else {
      ModelPicker_cache.clear();
    }
  }
</script>

<script lang="ts">
  import { untrack } from "svelte";
  import { formatModelLabel, listModels, setModel } from "$lib/api";
  import Button from "agentic-ui-kit/components/ui/button.svelte";

  type Props = {
    /** When set, selection is applied via API. When empty, selection is local-only (home). */
    sessionId?: string;
    model?: { provider?: string; id?: string; name?: string };
    disabled?: boolean;
    onChange?: (model: { provider?: string; id?: string; name?: string }) => void;
    onError?: (msg: string) => void;
  };

  let { sessionId = "", model, disabled = false, onChange, onError }: Props = $props();

  let models = $state<ModelInfo[]>([]);
  let loading = $state(false);
  let busy = $state(false);

  // Module-level cache so remounts / home↔chat don't re-hit /api/models
  // ponytail: global cache, invalidate when providers change (rare)
  const cache = ModelPicker_cache;

  const value = $derived(
    model?.provider && model?.id ? `${model.provider}::${model.id}` : "",
  );

  const label = $derived(formatModelLabel(model) || "Model");

  /** Always include the active model so <select> has a matching option. */
  const options = $derived.by(() => {
    const list = models.slice();
    if (model?.provider && model?.id) {
      if (!list.some((m) => m.provider === model!.provider && m.id === model!.id)) {
        list.unshift({
          provider: model.provider,
          id: model.id,
          name: model.name || model.id,
        });
      }
    }
    return list;
  });

  async function load(id: string) {
    // Don't reuse "full" unscoped cache for a session — scope may filter the list.
    const key = id ? `s:${id}` : "home";
    const hit = cache.get(key);
    if (hit?.length) {
      models = hit;
      loading = false;
      return;
    }
    models = [];
    loading = true;
    try {
      const res = await listModels(id || undefined);
      if (sessionId !== id) return;
      models = res.models ?? [];
      if (models.length) cache.set(key, models);
      else cache.delete(key);
    } catch {
      /* leave empty; retry when the session changes or the picker remounts */
    } finally {
      if (sessionId === id) loading = false;
    }
  }

  $effect(() => {
    const id = sessionId;
    // Loading/models are outputs, not triggers (an empty/error response otherwise retries forever).
    untrack(() => void load(id));
  });

  async function onSelectChange(e: Event) {
    const el = e.currentTarget as HTMLSelectElement;
    const v = el.value;
    if (!v) return;
    const [provider, ...rest] = v.split("::");
    const id = rest.join("::");
    if (!provider || !id) return;
    const picked = options.find((m) => m.provider === provider && m.id === id);
    const local = { provider, id, name: picked?.name || id };
    // Home / no session: local pick only — applied after open
    if (!sessionId) {
      onChange?.(local);
      return;
    }
    busy = true;
    try {
      const res = await setModel(sessionId, { provider, id });
      onChange?.(res.model ?? local);
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err));
      el.value = value;
    } finally {
      busy = false;
    }
  }

  async function cycle() {
    if (busy) return;
    if (!sessionId) {
      if (!options.length) return;
      const i = options.findIndex(
        (m) => m.provider === model?.provider && m.id === model?.id,
      );
      const next = options[(i + 1) % options.length];
      onChange?.({ provider: next.provider, id: next.id, name: next.name });
      return;
    }
    busy = true;
    try {
      const res = await setModel(sessionId, { cycle: "forward" });
      onChange?.(res.model ?? model ?? {});
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err));
    } finally {
      busy = false;
    }
  }
</script>

{#if options.length > 0}
  <!-- no truncate: overflow:hidden on <select> blanks the selected label in WebKit -->
  <select
    class="h-10 w-full min-w-0 max-w-[18rem] rounded-full border-0 bg-muted/70 px-2.5 text-xs font-medium text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:h-7 sm:text-[11px] dark:bg-muted/40"
    value={value}
    disabled={disabled || busy || loading}
    onchange={onSelectChange}
    title={model?.provider && model?.id ? `${model.provider}/${model.id}` : "Model"}
  >
    {#if !value}
      <option value="" disabled>Model</option>
    {/if}
    {#each options as m (`${m.provider}/${m.id}`)}
      <option value={`${m.provider}::${m.id}`}>
        {formatModelLabel(m)}
      </option>
    {/each}
  </select>
{:else}
  <Button
    variant="ghost"
    size="sm"
    class="h-10 w-full max-w-[18rem] justify-start truncate rounded-full bg-muted/70 px-2.5 text-xs font-medium sm:h-7 sm:text-[11px] dark:bg-muted/40"
    onclick={cycle}
    disabled={disabled || busy}
    title={model?.provider && model?.id ? `${model.provider}/${model.id}` : "Cycle model"}
  >
    {busy ? "…" : label}
  </Button>
{/if}
