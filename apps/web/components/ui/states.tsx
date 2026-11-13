import * as React from "react";
import { AlertCircle, CheckCircle2, Info, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "./button";

export function EmptyState({ icon: Icon, title, description, action, className }: { icon?: React.ComponentType<{ className?: string }>; title: string; description?: string; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-12 text-center", className)}>
      {Icon && <Icon className="mb-3 size-5 text-fg-subtle" />}
      <h3 className="text-base font-semibold text-fg">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-fg-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ title = "Something went wrong", description, onRetry }: { title?: string; description?: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center px-6 py-12 text-center">
      <AlertCircle className="mb-3 size-5 text-danger" aria-hidden />
      <h3 className="text-base font-semibold text-fg">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-fg-muted">{description}</p>}
      {onRetry && <Button className="mt-4" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

const ALERTS = {
  info: { icon: Info, cls: "bg-accent-subtle text-accent-fg" },
  success: { icon: CheckCircle2, cls: "bg-success-bg text-success-fg" },
  warning: { icon: TriangleAlert, cls: "bg-warning-bg text-warning-fg" },
  error: { icon: AlertCircle, cls: "bg-danger-bg text-danger-fg" },
} as const;

export function Alert({ tone = "info", children, className }: { tone?: keyof typeof ALERTS; children: React.ReactNode; className?: string }) {
  const { icon: Icon, cls } = ALERTS[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cn("flex items-start gap-2 rounded-md px-3 py-2 text-sm", cls, className)}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div>{children}</div>
    </div>
  );
}
