import React from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { 
  Filter, Tag, Globe, RefreshCw, UserCircle, AlertTriangle, 
  MessageSquare, X, Link2, Unlink, CheckCircle2, AlertCircle,
  ChevronDown
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface FilterOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
  color?: string;
}

interface AccountFiltersProps {
  tagFilter: string;
  setTagFilter: (value: string) => void;
  proxyFilter: string;
  setProxyFilter: (value: string) => void;
  profileFilter: string;
  setProfileFilter: (value: string) => void;
  avatarFilter: string;
  setAvatarFilter: (value: string) => void;
  proxyErrorFilter: string;
  setProxyErrorFilter: (value: string) => void;
  messagesTodayFilter: string;
  setMessagesTodayFilter: (value: string) => void;
  availableTags: string[];
}

const FilterGroup: React.FC<{
  label: string;
  icon: React.ReactNode;
  options: FilterOption[];
  value: string;
  onChange: (value: string) => void;
}> = ({ label, icon, options, value, onChange }) => {
  const selectedOption = options.find(o => o.value === value);
  const isActive = value !== 'all';

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <button
            key={option.value}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md transition-all",
              "border hover:bg-accent/50",
              value === option.value
                ? "bg-primary/10 border-primary/30 text-primary"
                : "bg-background border-border text-muted-foreground hover:text-foreground"
            )}
          >
            {option.icon}
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
};

export const AccountFilters: React.FC<AccountFiltersProps> = ({
  tagFilter,
  setTagFilter,
  proxyFilter,
  setProxyFilter,
  profileFilter,
  setProfileFilter,
  avatarFilter,
  setAvatarFilter,
  proxyErrorFilter,
  setProxyErrorFilter,
  messagesTodayFilter,
  setMessagesTodayFilter,
  availableTags,
}) => {
  const activeFiltersCount = [
    tagFilter !== 'all',
    proxyFilter !== 'all',
    profileFilter !== 'all',
    avatarFilter !== 'all',
    proxyErrorFilter !== 'all',
    messagesTodayFilter !== 'all',
  ].filter(Boolean).length;

  const clearAllFilters = () => {
    setTagFilter('all');
    setProxyFilter('all');
    setProfileFilter('all');
    setAvatarFilter('all');
    setProxyErrorFilter('all');
    setMessagesTodayFilter('all');
  };

  const proxyOptions: FilterOption[] = [
    { value: 'all', label: 'All' },
    { value: 'with_proxy', label: 'With Proxy', icon: <Link2 className="w-3 h-3 text-green-500" /> },
    { value: 'without_proxy', label: 'No Proxy', icon: <Unlink className="w-3 h-3 text-red-500" /> },
  ];

  const profileOptions: FilterOption[] = [
    { value: 'all', label: 'All' },
    { value: 'synced', label: 'Synced', icon: <CheckCircle2 className="w-3 h-3 text-green-500" /> },
    { value: 'not_synced', label: 'Not Synced', icon: <AlertCircle className="w-3 h-3 text-orange-500" /> },
  ];

  const avatarOptions: FilterOption[] = [
    { value: 'all', label: 'All' },
    { value: 'with_avatar', label: 'Has Picture', icon: <CheckCircle2 className="w-3 h-3 text-green-500" /> },
    { value: 'without_avatar', label: 'No Picture', icon: <X className="w-3 h-3 text-red-500" /> },
  ];

  const proxyErrorOptions: FilterOption[] = [
    { value: 'all', label: 'All' },
    { value: 'with_error', label: 'Has Errors', icon: <AlertTriangle className="w-3 h-3 text-destructive" /> },
    { value: 'no_error', label: 'No Errors', icon: <CheckCircle2 className="w-3 h-3 text-green-500" /> },
  ];

  const messagesOptions: FilterOption[] = [
    { value: 'all', label: 'All' },
    { value: 'zero_messages', label: '0 Messages', icon: <MessageSquare className="w-3 h-3 text-muted-foreground" /> },
    { value: 'has_messages', label: 'Has Messages', icon: <MessageSquare className="w-3 h-3 text-green-500" /> },
  ];

  const tagOptions: FilterOption[] = [
    { value: 'all', label: 'All' },
    { value: 'no_tags', label: 'No Tags', icon: <X className="w-3 h-3" /> },
    ...availableTags.map(tag => ({
      value: tag,
      label: tag,
      icon: <Tag className="w-3 h-3" />,
    })),
  ];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 gap-2">
          <Filter className="w-4 h-4" />
          Filters
          {activeFiltersCount > 0 && (
            <Badge variant="default" className="ml-1 h-5 px-1.5 text-xs bg-primary">
              {activeFiltersCount}
            </Badge>
          )}
          <ChevronDown className="w-3 h-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[360px] p-0">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30">
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-muted-foreground" />
            <span className="font-medium text-sm">Filters</span>
            {activeFiltersCount > 0 && (
              <Badge variant="secondary" className="h-5 px-1.5 text-xs">
                {activeFiltersCount} active
              </Badge>
            )}
          </div>
          {activeFiltersCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={clearAllFilters}
            >
              Clear all
            </Button>
          )}
        </div>

        {/* Filter Groups */}
        <div className="p-4 space-y-4 max-h-[400px] overflow-y-auto">
          {/* Proxy */}
          <FilterGroup
            label="Proxy"
            icon={<Globe className="w-3.5 h-3.5" />}
            options={proxyOptions}
            value={proxyFilter}
            onChange={setProxyFilter}
          />

          <Separator />

          {/* Profile Sync */}
          <FilterGroup
            label="Profile Sync"
            icon={<RefreshCw className="w-3.5 h-3.5" />}
            options={profileOptions}
            value={profileFilter}
            onChange={setProfileFilter}
          />

          <Separator />

          {/* Profile Picture */}
          <FilterGroup
            label="Profile Picture"
            icon={<UserCircle className="w-3.5 h-3.5" />}
            options={avatarOptions}
            value={avatarFilter}
            onChange={setAvatarFilter}
          />

          <Separator />

          {/* Proxy Status */}
          <FilterGroup
            label="Proxy Status"
            icon={<AlertTriangle className="w-3.5 h-3.5" />}
            options={proxyErrorOptions}
            value={proxyErrorFilter}
            onChange={setProxyErrorFilter}
          />

          <Separator />

          {/* Messages Today */}
          <FilterGroup
            label="Messages Today"
            icon={<MessageSquare className="w-3.5 h-3.5" />}
            options={messagesOptions}
            value={messagesTodayFilter}
            onChange={setMessagesTodayFilter}
          />

          {availableTags.length > 0 && (
            <>
              <Separator />
              {/* Tags */}
              <FilterGroup
                label="Tags"
                icon={<Tag className="w-3.5 h-3.5" />}
                options={tagOptions}
                value={tagFilter}
                onChange={setTagFilter}
              />
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};
