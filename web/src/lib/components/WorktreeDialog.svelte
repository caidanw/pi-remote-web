<script lang="ts">
  import {
    createWorktree,
    launchWorktree,
    listWorktrees,
    type SessionRow,
    type WorktreeList,
  } from "$lib/api";
  import X from "@lucide/svelte/icons/x";

  type Props = {
    open: boolean;
    cwd?: string;
    onClose: () => void;
    onLaunch: (session: SessionRow) => void;
  };

  let { open, cwd = "", onClose, onLaunch }: Props = $props();
  let repository = $state("");
  let branch = $state("worktree");
  let base = $state("HEAD");
  let destination = $state("");
  let listed = $state<WorktreeList | null>(null);
  let loading = $state(false);
  let error = $state("");
  let loadedFor = "";

  async function refresh() {
    if (!repository.trim()) return;
    loading = true;
    error = "";
    try {
      listed = await listWorktrees(repository.trim(), branch.trim() || "worktree");
      destination = listed.suggestedDestination;
    } catch (e) {
      listed = null;
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function create() {
    if (!repository.trim() || !branch.trim()) {
      error = "Repository and branch are required";
      return;
    }
    loading = true;
    error = "";
    try {
      const result = await createWorktree({
        repository: repository.trim(),
        branch: branch.trim(),
        base: base.trim() || "HEAD",
        ...(destination.trim() ? { destination: destination.trim() } : {}),
      });
      onLaunch(result.session);
      onClose();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  async function launch(path: string) {
    loading = true;
    error = "";
    try {
      const result = await launchWorktree(repository.trim(), path);
      onLaunch(result.session);
      onClose();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (!open) {
      loadedFor = "";
      return;
    }
    const next = cwd || repository;
    if (!next || loadedFor === next) return;
    loadedFor = next;
    repository = next;
    void refresh();
  });
</script>

{#if open}
  <div class="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-4" role="presentation" onclick={(event) => event.currentTarget === event.target && !loading && onClose()}>
    <div class="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl" role="dialog" aria-modal="true" aria-labelledby="worktree-title">
      <header class="flex items-center gap-3 border-b border-border px-4 py-3">
        <div class="min-w-0 flex-1">
          <h2 id="worktree-title" class="text-sm font-semibold">Git worktrees</h2>
          <p class="text-xs text-muted-foreground">Open an existing worktree or create one with native Git.</p>
        </div>
        <button type="button" class="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted" aria-label="Close worktree dialog" disabled={loading} onclick={onClose}>
          <X class="size-4" />
        </button>
      </header>

      <div class="min-h-0 space-y-4 overflow-y-auto p-4">
        <div class="grid gap-2 sm:grid-cols-[1fr_auto]">
          <label class="grid gap-1 text-xs">
            <span class="font-medium">Repository</span>
            <input class="rounded-md border border-border bg-background px-3 py-2 text-sm" bind:value={repository} placeholder="/Users/me/Projects/repository" />
          </label>
          <button type="button" class="self-end rounded-md border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50" disabled={loading || !repository.trim()} onclick={refresh}>
            {loading ? "Loading…" : "List"}
          </button>
        </div>

        {#if listed}
          <div class="space-y-2">
            <div class="text-xs font-medium">Existing worktrees</div>
            <ul class="space-y-1">
              {#each listed.worktrees as worktree (worktree.path)}
                <li class="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs">
                  <div class="min-w-0 flex-1">
                    <div class="truncate font-medium" title={worktree.path}>{worktree.path}</div>
                    <div class="text-muted-foreground">{worktree.bare ? "bare repository" : worktree.detached ? "detached HEAD" : worktree.branch || "unknown branch"}</div>
                  </div>
                  {#if !worktree.bare}
                    <button type="button" class="rounded border border-border px-2 py-1 hover:bg-muted disabled:opacity-50" disabled={loading || Boolean(worktree.locked)} onclick={() => launch(worktree.path)}>Launch</button>
                  {/if}
                </li>
              {/each}
            </ul>
          </div>
        {/if}

        <div class="space-y-3 border-t border-border pt-4">
          <div class="text-xs font-medium">New worktree</div>
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="grid gap-1 text-xs">
              <span>Branch</span>
              <input class="rounded-md border border-border bg-background px-3 py-2 text-sm" bind:value={branch} oninput={() => (destination = "")} />
            </label>
            <label class="grid gap-1 text-xs">
              <span>Base revision</span>
              <input class="rounded-md border border-border bg-background px-3 py-2 text-sm" bind:value={base} />
            </label>
          </div>
          <label class="grid gap-1 text-xs">
            <span>Destination override</span>
            <input class="rounded-md border border-border bg-background px-3 py-2 text-sm" bind:value={destination} placeholder="Leave blank to use the suggested location" />
          </label>
          {#if listed?.roots.length}
            <p class="text-[11px] text-muted-foreground">Allowed roots: {listed.roots.join(", ")}</p>
          {/if}
          {#if error}
            <p class="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">{error}</p>
          {/if}
          <div class="flex justify-end">
            <button type="button" class="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50" disabled={loading || !repository.trim() || !branch.trim()} onclick={create}>
              {loading ? "Working…" : "Create and launch"}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}
