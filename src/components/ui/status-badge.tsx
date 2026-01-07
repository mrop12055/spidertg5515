import React from 'react';
import { AccountStatus } from '@/types/telegram';
import { cn } from '@/lib/utils';
import { 
  CheckCircle2, 
  XCircle, 
  AlertTriangle, 
  WifiOff, 
  Clock,
  AlertOctagon
} from 'lucide-react';

interface StatusBadgeProps {
  status: AccountStatus;
  showLabel?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const statusConfig: Record<AccountStatus, {
  label: string;
  icon: React.ElementType;
  className: string;
  dotColor: string;
}> = {
  active: {
    label: 'Active',
    icon: CheckCircle2,
    className: 'bg-status-active/10 text-status-active border-status-active/30',
    dotColor: 'bg-status-active'
  },
  banned: {
    label: 'Banned',
    icon: XCircle,
    className: 'bg-status-banned/10 text-status-banned border-status-banned/30',
    dotColor: 'bg-status-banned'
  },
  restricted: {
    label: 'Restricted',
    icon: AlertOctagon,
    className: 'bg-status-restricted/10 text-status-restricted border-status-restricted/30 animate-pulse',
    dotColor: 'bg-status-restricted'
  },
  disconnected: {
    label: 'Disconnected',
    icon: WifiOff,
    className: 'bg-status-disconnected/10 text-status-disconnected border-status-disconnected/30',
    dotColor: 'bg-status-disconnected'
  },
  cooldown: {
    label: 'Cooldown (24h)',
    icon: Clock,
    className: 'bg-status-cooldown/10 text-status-cooldown border-status-cooldown/30',
    dotColor: 'bg-status-cooldown animate-pulse'
  },
  frozen: {
    label: 'Frozen',
    icon: AlertTriangle,
    className: 'bg-blue-500/10 text-blue-500 border-blue-500/30',
    dotColor: 'bg-blue-500'
  }
};

const sizeStyles = {
  sm: 'px-2 py-0.5 text-xs gap-1',
  md: 'px-2.5 py-1 text-xs gap-1.5',
  lg: 'px-3 py-1.5 text-sm gap-2'
};

const iconSizes = {
  sm: 'w-3 h-3',
  md: 'w-3.5 h-3.5',
  lg: 'w-4 h-4'
};

export const StatusBadge: React.FC<StatusBadgeProps> = ({
  status,
  showLabel = true,
  size = 'md',
  className
}) => {
  const config = statusConfig[status];
  const Icon = config.icon;

  return (
    <div className={cn(
      "inline-flex items-center rounded-full border font-medium",
      config.className,
      sizeStyles[size],
      className
    )}>
      <Icon className={iconSizes[size]} />
      {showLabel && <span>{config.label}</span>}
    </div>
  );
};

interface StatusDotProps {
  status: AccountStatus;
  className?: string;
}

export const StatusDot: React.FC<StatusDotProps> = ({ status, className }) => {
  const config = statusConfig[status];
  
  return (
    <span className={cn(
      "w-2 h-2 rounded-full inline-block",
      config.dotColor,
      className
    )} />
  );
};
