import { cn } from "@/lib/utils";

export function BrandLogo({ className, alt = "ComputePool bird and Kubernetes logo" }: { className?: string; alt?: string }) {
  return <img src="/assets/computepool-logo.png" alt={alt} className={cn("object-cover", className)} />;
}
