<script lang="ts">
  /** Bell: subscribe this browser to "turn finished" push notifications. */
  import Bell from "@lucide/svelte/icons/bell";
  import BellOff from "@lucide/svelte/icons/bell-off";
  import { deletePushSubscription, getPushConfig, savePushSubscription } from "$lib/api";

  // iOS only exposes Web Push to home-screen apps, so hide the bell elsewhere there.
  const supported =
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;

  let enabled = $state(false);
  let busy = $state(false);
  let problem = $state("");

  $effect(() => {
    if (!supported) return;
    void navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => (enabled = Boolean(subscription) && Notification.permission === "granted"))
      .catch(() => {});
  });

  function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
    const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  async function toggle() {
    busy = true;
    problem = "";
    try {
      const registration = await navigator.serviceWorker.ready;
      const current = await registration.pushManager.getSubscription();
      if (enabled && current) {
        await deletePushSubscription(current.endpoint).catch(() => {});
        await current.unsubscribe();
        enabled = false;
        return;
      }
      if ((await Notification.requestPermission()) !== "granted") {
        problem = "Notifications are blocked in this browser's settings.";
        return;
      }
      const config = await getPushConfig();
      if (!config.enabled || !config.publicKey) {
        problem = "This server can't send notifications.";
        return;
      }
      const subscription =
        current ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(config.publicKey),
        }));
      await savePushSubscription(subscription.toJSON());
      enabled = true;
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }
</script>

{#if supported}
  <button
    type="button"
    class="pi-tactile relative inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
    aria-label={enabled ? "Turn off notifications" : "Notify me when a turn finishes"}
    aria-pressed={enabled}
    title={problem || (enabled ? "Notifications on" : "Notify me when a turn finishes")}
    disabled={busy}
    onclick={toggle}
  >
    {#if enabled}
      <Bell class="size-4 text-foreground" aria-hidden="true" />
    {:else}
      <BellOff class="size-4" aria-hidden="true" />
    {/if}
    {#if problem}
      <span class="absolute right-1 top-1 size-1.5 rounded-full bg-destructive" aria-hidden="true"></span>
    {/if}
  </button>
{/if}
