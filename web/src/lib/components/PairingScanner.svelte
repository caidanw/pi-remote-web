<script lang="ts">
  import { onMount } from "svelte";
  import jsQR from "jsqr";
  import { pairingTokenFromQr } from "$lib/pairing-token";

  let {
    onPair,
    onClose,
  }: {
    onPair: (token: string) => Promise<void>;
    onClose: () => void;
  } = $props();

  let video: HTMLVideoElement;
  let canvas: HTMLCanvasElement;
  let stream = $state<MediaStream | null>(null);
  let frame = 0;
  let mounted = false;
  let lastScan = 0;
  let lastValue = "";
  let starting = $state(true);
  let paused = $state(false);
  let processing = $state(false);
  let error = $state("");

  function stopCamera() {
    cancelAnimationFrame(frame);
    frame = 0;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    if (video) video.srcObject = null;
  }

  async function scan(now: number) {
    if (!stream) return;
    frame = requestAnimationFrame(scan);
    if (processing || now - lastScan < 125 || !video.videoWidth) return;
    lastScan = now;

    const scale = Math.min(1, 640 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const result = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
    if (!result || result.data === lastValue) return;
    lastValue = result.data;

    const token = pairingTokenFromQr(result.data, location.origin);
    if (!token) {
      error = "That is not a pairing QR code for this app.";
      return;
    }

    processing = true;
    error = "";
    try {
      await onPair(token);
      stopCamera();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      processing = false;
    }
  }

  async function startCamera() {
    stopCamera();
    starting = true;
    paused = false;
    error = "";
    lastValue = "";
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access is unavailable in this browser.");
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      });
      if (!mounted || document.visibilityState === "hidden") {
        acquired.getTracks().forEach((track) => track.stop());
        starting = false;
        paused = mounted;
        return;
      }
      stream = acquired;
      video.srcObject = stream;
      await video.play();
      starting = false;
      frame = requestAnimationFrame(scan);
    } catch (cause) {
      stopCamera();
      starting = false;
      error = cause instanceof Error && cause.name === "NotAllowedError"
        ? "Camera access was denied. Allow camera access in Settings, then try again."
        : cause instanceof Error ? cause.message : String(cause);
    }
  }

  function visibilityChanged() {
    if (document.visibilityState !== "hidden" || !stream) return;
    stopCamera();
    paused = true;
  }

  onMount(() => {
    mounted = true;
    document.addEventListener("visibilitychange", visibilityChanged);
    void startCamera();
    return () => {
      mounted = false;
      document.removeEventListener("visibilitychange", visibilityChanged);
      stopCamera();
    };
  });
</script>

<div class="fixed inset-0 z-[110] flex flex-col bg-black text-white" role="dialog" aria-modal="true" aria-labelledby="scanner-title">
  <header class="flex items-center justify-between p-4 pt-[max(1rem,env(safe-area-inset-top))]">
    <h1 id="scanner-title" class="text-base font-semibold">Scan pairing QR code</h1>
    <button type="button" class="rounded-full bg-white/15 px-4 py-2 text-sm" onclick={onClose}>Cancel</button>
  </header>

  <div class="relative min-h-0 flex-1 overflow-hidden">
    <video bind:this={video} class="size-full object-cover" muted playsinline aria-label="Camera preview"></video>
    <canvas bind:this={canvas} class="hidden"></canvas>
    <div class="pointer-events-none absolute inset-0 grid place-items-center p-12">
      <div class="aspect-square w-full max-w-72 rounded-3xl border-2 border-white/90 shadow-[0_0_0_999px_rgba(0,0,0,0.35)]"></div>
    </div>
  </div>

  <div class="space-y-3 bg-black p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-center">
    {#if processing}
      <p role="status">Pairing…</p>
    {:else if starting}
      <p role="status">Starting camera…</p>
    {:else if paused}
      <button type="button" class="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black" onclick={startCamera}>Restart camera</button>
    {:else}
      <p class="text-sm text-white/75">Point the camera at the QR code shown on your Mac.</p>
    {/if}
    {#if error}
      <p class="text-sm text-red-300" role="alert">{error}</p>
      {#if !stream}
        <button type="button" class="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black" onclick={startCamera}>Try again</button>
      {/if}
    {/if}
  </div>
</div>
