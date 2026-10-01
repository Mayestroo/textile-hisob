/**
 * Scope/Key-aware debounced save manager.
 * Prevents worker, ticket, patta batch, and model saves from cancelling each other's timers.
 */

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingTasks = new Map<string, () => void>();

export function triggerDebouncedSave(
  saveFn: () => void,
  delayMs = 1200,
  key = 'default',
  isCurrent: () => boolean = () => true
): void {
  pendingTasks.set(key, () => {
    if (isCurrent()) saveFn();
  });
  const existing = timers.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    timers.delete(key);
    const task = pendingTasks.get(key);
    pendingTasks.delete(key);
    if (task) {
      try {
        task();
      } catch (err) {
        console.error(`[DebounceSave] Task error for key "${key}":`, err);
      }
    }
  }, delayMs);
  timers.set(key, timer);
}

export function flushDebouncedSave(key?: string): void {
  if (key) {
    const timer = timers.get(key);
    if (timer) clearTimeout(timer);
    timers.delete(key);
    const task = pendingTasks.get(key);
    pendingTasks.delete(key);
    if (task) {
      try {
        task();
      } catch (err) {
        console.error(`[DebounceSave] Flush error for key "${key}":`, err);
      }
    }
  } else {
    for (const [k, timer] of Array.from(timers.entries())) {
      clearTimeout(timer);
      const task = pendingTasks.get(k);
      timers.delete(k);
      pendingTasks.delete(k);
      if (task) {
        try {
          task();
        } catch (err) {
          console.error(`[DebounceSave] Flush error for key "${k}":`, err);
        }
      }
    }
  }
}

export function cancelDebouncedSave(key?: string): void {
  if (key) {
    const timer = timers.get(key);
    if (timer) clearTimeout(timer);
    timers.delete(key);
    pendingTasks.delete(key);
  } else {
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
    pendingTasks.clear();
  }
}
