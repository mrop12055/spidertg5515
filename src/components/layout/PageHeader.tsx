import React, { forwardRef } from 'react';
import { cn } from '@/lib/utils';
import { LucideIcon } from 'lucide-react';

interface PageHeaderProps {
  title: string;
  description?: string;
  icon?: LucideIcon;
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

export const PageHeader = forwardRef<HTMLDivElement, PageHeaderProps>(
  ({ title, description, icon: Icon, action, children, className }, ref) => {
    return (
      <div ref={ref} className={cn("flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6", className)}>
        <div className="flex items-center gap-4">
          {Icon && (
            <div className="w-12 h-12 rounded-xl gradient-primary flex items-center justify-center shadow-glow animate-pulse-glow">
              <Icon className="w-6 h-6 text-primary-foreground" />
            </div>
          )}
          <div>
            <h1 className="text-2xl font-bold text-foreground">{title}</h1>
            {description && (
              <p className="text-muted-foreground mt-0.5">{description}</p>
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
  }
);

PageHeader.displayName = 'PageHeader';
