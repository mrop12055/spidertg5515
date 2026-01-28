import React, { useRef } from "react";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

interface PageHeaderProps {
  title: string;
  description?: string;
  icon?: LucideIcon;
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

// Simple PageHeader without animations to prevent blinking on re-renders
export const PageHeader: React.FC<PageHeaderProps> = React.memo(({
  title,
  description,
  icon: Icon,
  action,
  children,
  className,
}) => {
  // Track if this is truly the first mount using a ref (survives re-renders)
  const hasMountedRef = useRef(false);
  
  // Only apply CSS fade-in on very first mount
  const shouldAnimate = !hasMountedRef.current;
  if (!hasMountedRef.current) {
    hasMountedRef.current = true;
  }

  return (
    <div
      className={cn(
        "flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8",
        shouldAnimate && "animate-fade-in",
        className
      )}
    >
      <div className="flex items-center gap-4">
        {Icon && (
          <div className="w-14 h-14 rounded-2xl gradient-primary flex items-center justify-center shadow-lg shadow-primary/20">
            <Icon className="w-7 h-7 text-primary-foreground" strokeWidth={1.5} />
          </div>
        )}

        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight">
            {title}
          </h1>

          {description && (
            <p className="text-muted-foreground text-sm mt-0.5">
              {description}
            </p>
          )}
        </div>
      </div>

      {(action || children) && (
        <div className="flex items-center gap-3">
          {action}
          {children}
        </div>
      )}
    </div>
  );
});
