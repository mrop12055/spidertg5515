import React from 'react';
import { cn } from '@/lib/utils';
import { LucideIcon } from 'lucide-react';
import { TrendingUp, TrendingDown } from 'lucide-react';

interface StatCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  trend?: {
    value: number;
    isPositive: boolean;
  };
  variant?: 'default' | 'primary' | 'success' | 'warning' | 'danger';
  className?: string;
  index?: number;
}

const variantStyles = {
  default: {
    container: 'bg-card border-border',
    icon: 'bg-secondary text-foreground',
    value: 'text-foreground'
  },
  primary: {
    container: 'bg-card border-primary/20',
    icon: 'gradient-primary text-primary-foreground shadow-lg shadow-primary/20',
    value: 'text-foreground'
  },
  success: {
    container: 'bg-card border-status-active/20',
    icon: 'gradient-success text-primary-foreground shadow-lg shadow-green-500/20',
    value: 'text-status-active'
  },
  warning: {
    container: 'bg-card border-status-restricted/20',
    icon: 'gradient-warning text-primary-foreground shadow-lg shadow-orange-500/20',
    value: 'text-status-restricted'
  },
  danger: {
    container: 'bg-card border-status-banned/20',
    icon: 'gradient-danger text-primary-foreground shadow-lg shadow-red-500/20',
    value: 'text-status-banned'
  }
};

export const StatCard: React.FC<StatCardProps> = ({
  title,
  value,
  icon: Icon,
  trend,
  variant = 'default',
  className,
  index = 0
}) => {
  const styles = variantStyles[variant];

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border p-5 transition-all duration-200 hover:shadow-lg hover:-translate-y-1",
        styles.container,
        className
      )}
    >
      {/* Background decoration */}
      <div className="absolute top-0 right-0 w-32 h-32 opacity-[0.03]">
        <Icon className="w-full h-full" />
      </div>
      
      <div className="relative flex items-start justify-between">
        <div className="flex-1">
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <p
            className={cn(
              "text-3xl font-bold mt-2 tracking-tight",
              styles.value
            )}
          >
            {typeof value === 'number' ? value.toLocaleString() : value}
          </p>
          
          {trend && (
            <div className="flex items-center gap-1 mt-2">
              {trend.isPositive ? (
                <TrendingUp className="w-4 h-4 text-status-active" />
              ) : (
                <TrendingDown className="w-4 h-4 text-status-banned" />
              )}
              <span className={cn(
                "text-sm font-medium",
                trend.isPositive ? "text-status-active" : "text-status-banned"
              )}>
                {trend.isPositive ? '+' : ''}{trend.value}%
              </span>
              <span className="text-xs text-muted-foreground">vs yesterday</span>
            </div>
          )}
        </div>
        
        <div
          className={cn(
            "w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0",
            styles.icon
          )}
        >
          <Icon className="w-6 h-6" strokeWidth={1.5} />
        </div>
      </div>
    </div>
  );
};
