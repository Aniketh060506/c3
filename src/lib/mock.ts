// Mock data for the prototype. Replace via services in src/lib/platform.ts.
export type Provider = {
  id: string;
  name: string;
  handle: string;
  location: string;
  flag: string;
  online: boolean;
  cpu: string;
  cores: number;
  freeCores: number;
  ram: number;
  freeRam: number;
  gpu: string | null;
  vram: number;
  rate: number; // credits / hour
  rating: number;
  latency: number;
  uptime: number; // %
  onlineHours: number;
  hue: number;
  tags: string[];
  bio: string;
};

export const providers: Provider[] = [
  { id: "alpha", name: "Aarav's Workstation", handle: "aarav.k", location: "Bengaluru", flag: "IN", online: true, cpu: "AMD Ryzen 9 7950X", cores: 16, freeCores: 10, ram: 64, freeRam: 40, gpu: "RTX 4090", vram: 24, rate: 1.8, rating: 4.9, latency: 18, uptime: 99.2, onlineHours: 312, hue: 262, tags: ["ML training", "CUDA 12"], bio: "Gaming rig that sleeps 14h a day. Fibre line, UPS backed." },
  { id: "beta", name: "Lena's Studio Mac-less", handle: "lena.dev", location: "Berlin", flag: "DE", online: true, cpu: "Intel i9-13900K", cores: 24, freeCores: 16, ram: 128, freeRam: 96, gpu: "RTX 3090", vram: 24, rate: 1.4, rating: 4.8, latency: 64, uptime: 98.1, onlineHours: 188, hue: 50, tags: ["Rendering", "Big RAM"], bio: "Render node between client projects. Happy to negotiate long jobs." },
  { id: "gamma", name: "Kofi Home Lab", handle: "kofi", location: "Accra", flag: "GH", online: true, cpu: "AMD Ryzen 7 5800X", cores: 8, freeCores: 6, ram: 32, freeRam: 24, gpu: "RTX 3060", vram: 12, rate: 0.6, rating: 4.6, latency: 92, uptime: 96.4, onlineHours: 74, hue: 158, tags: ["Budget", "Inference"], bio: "Small but steady. Good for inference and CI workloads." },
  { id: "delta", name: "Mei's Laptop Fleet", handle: "mei.w", location: "Taipei", flag: "TW", online: false, cpu: "Intel i7-12700H", cores: 14, freeCores: 8, ram: 32, freeRam: 16, gpu: "RTX 3070 Ti", vram: 8, rate: 0.9, rating: 4.7, latency: 110, uptime: 94.8, onlineHours: 40, hue: 20, tags: ["Batch jobs"], bio: "Two laptops docked at night. Best for overnight batches." },
  { id: "epsilon", name: "Diego CPU Tower", handle: "diego.r", location: "São Paulo", flag: "BR", online: true, cpu: "AMD Threadripper 3970X", cores: 32, freeCores: 24, ram: 256, freeRam: 192, gpu: null, vram: 0, rate: 1.1, rating: 4.9, latency: 140, uptime: 99.6, onlineHours: 520, hue: 80, tags: ["CPU heavy", "Compile farm"], bio: "No GPU, lots of cores. Perfect for builds and simulations." },
  { id: "zeta", name: "Sana AI Box", handle: "sana", location: "Dubai", flag: "AE", online: true, cpu: "AMD Ryzen 9 7900", cores: 12, freeCores: 8, ram: 96, freeRam: 64, gpu: "RTX 4080", vram: 16, rate: 1.5, rating: 4.8, latency: 38, uptime: 98.9, onlineHours: 260, hue: 300, tags: ["Fine-tuning", "Low latency"], bio: "Dedicated AI box, idle on weekdays." },
];

export type DepStatus = "installed" | "missing" | "outdated" | "stopped" | "config";
export type Dep = { id: string; name: string; version: string | null; required: string; status: DepStatus; what: string; why: string; install: string };

export const dependencies: Dep[] = [
  { id: "docker", name: "Docker Engine", version: "26.1.4", required: "≥ 24.0", status: "installed", what: "Runs isolated containers.", why: "Every workload runs sandboxed inside a container.", install: "winget install Docker.DockerDesktop" },
  { id: "containerd", name: "containerd", version: "1.7.18", required: "≥ 1.7", status: "installed", what: "Container runtime used by K3s.", why: "K3s schedules pods through containerd.", install: "Bundled with K3s" },
  { id: "wsl", name: "WSL2", version: "2.1.5", required: "≥ 2.0", status: "installed", what: "Linux kernel on Windows.", why: "K3s and NetBird run inside a Linux VM.", install: "wsl --install" },
  { id: "ubuntu", name: "Ubuntu", version: "22.04", required: "22.04 LTS", status: "installed", what: "Linux distro for WSL2.", why: "Host OS for the node agent.", install: "wsl --install -d Ubuntu-22.04" },
  { id: "k3s", name: "K3s", version: null, required: "v1.30", status: "missing", what: "Lightweight Kubernetes.", why: "Joins your machine to a compute cluster.", install: "curl -sfL https://get.k3s.io | sh -" },
  { id: "kubectl", name: "kubectl", version: "1.28.2", required: "≥ 1.30", status: "outdated", what: "Kubernetes CLI.", why: "Used by the terminal and workload views.", install: "winget install Kubernetes.kubectl" },
  { id: "helm", name: "Helm", version: "3.15.2", required: "≥ 3.12", status: "installed", what: "Kubernetes package manager.", why: "Installs monitoring and GPU operators.", install: "winget install Helm.Helm" },
  { id: "netbird", name: "NetBird", version: "0.28.4", required: "≥ 0.27", status: "stopped", what: "WireGuard mesh VPN.", why: "Creates private peer-to-peer links between nodes.", install: "netbird up" },
  { id: "nvidia", name: "NVIDIA drivers", version: "552.22", required: "≥ 535", status: "installed", what: "GPU driver.", why: "Exposes your GPU to workloads.", install: "Install from nvidia.com" },
  { id: "nvct", name: "NVIDIA Container Toolkit", version: null, required: "≥ 1.15", status: "config", what: "GPU passthrough for containers.", why: "Lets containers use CUDA.", install: "sudo apt install nvidia-container-toolkit" },
];

export const myHardware = {
  cpu: { model: "AMD Ryzen 7 7800X3D", vendor: "AMD", physical: 8, logical: 16, ghz: 4.2 },
  ram: { total: 32 },
  gpu: { model: "NVIDIA RTX 4070 Super", vram: 12, driver: "552.22" },
  storage: { total: 2000, free: 1240 },
  net: { iface: "Ethernet 2 · 1 Gbps", peerIp: "100.84.12.7", netbird: "Stopped" },
};

export const nodes = [
  { id: "cp", name: "you-control-plane", role: "Control plane", provider: "You", cpu: 4, ram: 8, gpu: null as string | null, status: "Ready", hue: 262 },
  { id: "alpha", name: "alpha-worker", role: "Worker", provider: "Aarav's Workstation", cpu: 8, ram: 24, gpu: "RTX 4090", status: "Ready", hue: 262 },
  { id: "beta", name: "beta-worker", role: "Worker", provider: "Lena's Studio", cpu: 12, ram: 48, gpu: "RTX 3090", status: "Ready", hue: 50 },
  { id: "gamma", name: "gamma-worker", role: "Worker", provider: "Kofi Home Lab", cpu: 4, ram: 16, gpu: "RTX 3060", status: "NotReady", hue: 158 },
];

export const pods = [
  { name: "trainer-7f9c-0", ns: "ml", node: "alpha-worker", status: "Running", cpu: 72, age: "1h 12m" },
  { name: "trainer-7f9c-1", ns: "ml", node: "beta-worker", status: "Running", cpu: 64, age: "1h 12m" },
  { name: "tokenizer-job-x2", ns: "batch", node: "beta-worker", status: "Completed", cpu: 0, age: "34m" },
  { name: "jupyter-0", ns: "default", node: "alpha-worker", status: "Running", cpu: 12, age: "2h 03m" },
  { name: "eval-sweep-4", ns: "batch", node: "gamma-worker", status: "Pending", cpu: 0, age: "3m" },
];

export type Msg = { id: string; from: "me" | "them"; text?: string; time: string; proposal?: { cpu: number; ram: number; gpu: number; hours: number; price: number; state: "open" | "accepted" | "rejected" } };

export const threads: { providerId: string; unread: number; messages: Msg[] }[] = [
  { providerId: "alpha", unread: 2, messages: [
    { id: "1", from: "me", text: "Hey! Looking to fine-tune a 7B model tonight. Is your 4090 free?", time: "18:02" },
    { id: "2", from: "them", text: "Yep, free until 7am. I can give you 8 cores and 24 GB too.", time: "18:04" },
    { id: "3", from: "them", time: "18:05", proposal: { cpu: 8, ram: 24, gpu: 1, hours: 4, price: 6.4, state: "open" } },
  ] },
  { providerId: "beta", unread: 0, messages: [
    { id: "1", from: "them", text: "Render job finished, thanks for the smooth session!", time: "Yesterday" },
  ] },
  { providerId: "epsilon", unread: 1, messages: [
    { id: "1", from: "them", text: "32 cores open for your compile farm, interested?", time: "Mon" },
  ] },
];

export const incomingRequests = [
  { id: "r1", who: "nora.ml", cpu: 6, ram: 16, gpu: 1, hours: 3, offer: 4.2, workload: "PyTorch training", trust: 4.9 },
  { id: "r2", who: "build-bot", cpu: 4, ram: 8, gpu: 0, hours: 1, offer: 0.8, workload: "CI pipeline", trust: 4.6 },
  { id: "r3", who: "studio.vfx", cpu: 8, ram: 24, gpu: 1, hours: 6, offer: 9.0, workload: "Blender render", trust: 4.8 },
];

export const earnings = [
  { d: "Mon", v: 3.2 }, { d: "Tue", v: 5.1 }, { d: "Wed", v: 2.4 }, { d: "Thu", v: 7.8 },
  { d: "Fri", v: 6.2 }, { d: "Sat", v: 9.4 }, { d: "Sun", v: 8.1 },
];
