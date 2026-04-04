let _syncTimer: ReturnType<typeof setTimeout> | null = null;

const GRAPH_ACCEL_URL = process.env.GRAPH_ACCEL_URL ?? "http://graph-accelerator:3902";
const GRAPH_SYNC_DEBOUNCE_SECONDS = Number(process.env.GRAPH_SYNC_DEBOUNCE_SECONDS ?? "300");

export async function _triggerGraphSync(): Promise<void> {
  try {
    const res = await fetch(`${GRAPH_ACCEL_URL}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(180_000),
    });
    const text = await res.text();
    console.log(`[msam.sync-hook] Graph sync completed: ${text.slice(0, 200)}`);
  } catch (err) {
    console.warn(`[msam.sync-hook] Graph sync failed: ${err}`);
  }
}

export function scheduleGraphSync(): void {
  if (_syncTimer !== null) {
    clearTimeout(_syncTimer);
  }
  _syncTimer = setTimeout(() => {
    _syncTimer = null;
    _triggerGraphSync();
  }, GRAPH_SYNC_DEBOUNCE_SECONDS * 1000);
}

export function cancelGraphSync(): void {
  if (_syncTimer !== null) {
    clearTimeout(_syncTimer);
    _syncTimer = null;
  }
}
