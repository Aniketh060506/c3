// Platform bridge. In the Tauri 2 desktop build, these call Rust commands via
// `@tauri-apps/api/core` invoke(). In the browser preview they return mock data.
import { dependencies, myHardware, providers, type Dep } from "./mock";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauri()) return null;
  const mod = "@tauri-apps/api/core";
  const m = (await import(/* @vite-ignore */ mod)) as { invoke: (c: string, a?: unknown) => Promise<T> };
  return m.invoke(cmd, args);
}

export const hardwareService = {
  async get() {
    return (await invoke<typeof myHardware>("get_hardware")) ?? myHardware;
  },
};

export const dependencyService = {
  async list(): Promise<Dep[]> {
    return (await invoke<Dep[]>("check_dependencies")) ?? dependencies;
  },
  /** Never installs automatically; only runs when the user clicks Install. */
  async install(id: string, onProgress: (p: number) => void) {
    const real = await invoke<boolean>("install_dependency", { id });
    if (real !== null) return real;
    for (let p = 0; p <= 100; p += 4) {
      onProgress(p);
      await new Promise((r) => setTimeout(r, 60));
    }
    return true;
  },
};

export const marketplaceService = {
  async list() {
    return providers;
  },
};
