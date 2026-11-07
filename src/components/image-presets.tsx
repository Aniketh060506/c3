import { Cpu, Image, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type ContainerImagePreset = {
  id: string;
  label: string;
  image: string;
  purpose: string;
  details: string;
  icon: LucideIcon;
  gpu?: boolean;
};

export const CONTAINER_IMAGE_PRESETS: ContainerImagePreset[] = [
  { id: "busybox", label: "BusyBox (quick test)", image: "busybox:1.36.1", purpose: "Fast shell and connectivity checks", details: "Tiny image for quickly testing pod placement, terminal commands, DNS, and network access.", icon: Cpu },
  { id: "python", label: "Python 3.12", image: "python:3.12-slim", purpose: "Scripts, data cleanup, CPU work", details: "Small Python image for scripts and preprocessing; no notebook UI or GPU drivers.", icon: Image },
  { id: "pytorch-cuda", label: "PyTorch CUDA 12.4", image: "pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime", purpose: "Deep learning training and inference", details: "PyTorch with CUDA and cuDNN. GPU requests need NVIDIA GPU workers and the Kubernetes NVIDIA device plugin.", icon: Cpu, gpu: true },
  { id: "node", label: "Node.js 22", image: "node:22-bookworm-slim", purpose: "JavaScript tools, builds, and services", details: "Node.js and npm for scripts, build steps, and command-line tools.", icon: Image },
  { id: "ubuntu", label: "Ubuntu 24.04", image: "ubuntu:24.04", purpose: "Linux shell and system utilities", details: "General-purpose Linux base for shell work and installing packages.", icon: Image },
];

export function ImagePresetPicker({ value, onSelect, compact = false }: { value: string; onSelect: (image: string) => void; compact?: boolean }) {
  const selected = CONTAINER_IMAGE_PRESETS.find((preset) => preset.image === value);
  return (
    <div className={cn("space-y-1.5", compact && "space-y-1")}>
      <label className="block text-xs font-semibold" htmlFor={compact ? "container-image-preset" : "workload-image-preset"}>Image preset by purpose</label>
      <select
        id={compact ? "container-image-preset" : "workload-image-preset"}
        value={selected?.image ?? ""}
        onChange={(event) => onSelect(event.target.value)}
        className="field"
      >
        <option value="">Choose an image preset…</option>
        {CONTAINER_IMAGE_PRESETS.map((preset) => <option key={preset.id} value={preset.image}>{preset.label} — {preset.purpose}</option>)}
      </select>
      <p className="text-[11px] leading-4 text-muted-foreground">
        {selected ? <><span className="font-mono">{selected.image}</span> · {selected.details}</> : "Or enter any custom image:tag in the field below."}
      </p>
      {selected?.gpu && <p className="rounded-lg border border-orange-100 bg-orange-50 px-2.5 py-2 text-[11px] leading-4 text-orange-800">CUDA image selected. GPU access still requires NVIDIA-enabled Kubernetes workers and the NVIDIA device plugin.</p>}
    </div>
  );
}
