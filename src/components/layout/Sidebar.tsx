import React, { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { 
  LayoutDashboard, 
  Users, 
  MessageSquare, 
  Settings, 
  Send,
  LogOut,
  ChevronLeft,
  ChevronRight,
  Phone,
  BookOpen,
  Globe,
  Flame,
  Package,
  ClipboardList
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useTelegram } from '@/context/TelegramContext';
import { useRunnerStatus } from '@/hooks/useRunnerStatus';

interface NavItem {
  icon: React.ElementType;
  label: string;
  path: string;
  superAdminOnly?: boolean;
}

const navItems: NavItem[] = [
  { icon: LayoutDashboard, label: 'Dashboard', path: '/dashboard' },
  { icon: Phone, label: 'Accounts', path: '/accounts' },
  { icon: Globe, label: 'Proxy Management', path: '/proxies' },
  { icon: MessageSquare, label: 'Chat', path: '/conversations' },
  { icon: Send, label: 'Campaigns', path: '/campaigns' },
  { icon: Flame, label: 'Warmup', path: '/warmup' },
  { icon: Users, label: 'Seats', path: '/seats' },
  { icon: Package, label: 'Material', path: '/material' },
  { icon: ClipboardList, label: 'Logs', path: '/logs' },
  { icon: BookOpen, label: 'Setup Guide', path: '/setup' },
  { icon: Settings, label: 'Settings', path: '/settings' },
];

export const Sidebar: React.FC = () => {
  const { logout } = useAuth();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const { conversations } = useTelegram();
  const { anyOfflineConfirmed } = useRunnerStatus();

  // Calculate count of unread *visible* chats (campaign/user-initiated only)
  const totalUnread = conversations.filter(c => (c.firstMessageSent ?? false) && (c.unreadCount || 0) > 0).length;

  const filteredNavItems = navItems.filter(item => !item.superAdminOnly);

  return (
    <aside 
      className={cn(
        "fixed left-0 top-0 h-screen bg-sidebar border-r border-sidebar-border flex flex-col transition-all duration-300 z-50",
        collapsed ? "w-[72px]" : "w-64"
      )}
    >
      {/* Logo */}
      <div className="h-16 flex items-center px-4 border-b border-sidebar-border">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl gradient-primary flex items-center justify-center shadow-lg shadow-primary/25">
            <Send className="w-5 h-5 text-primary-foreground" strokeWidth={1.5} />
          </div>
          {!collapsed && (
            <div className="flex items-center gap-2">
              <div>
                <h1 className="font-bold text-lg text-sidebar-foreground tracking-tight">TGxOP</h1>
                <p className="text-xs text-muted-foreground">Dashboard</p>
              </div>
              {anyOfflineConfirmed && (
                <span className="w-2.5 h-2.5 rounded-full bg-destructive animate-pulse" title="Some runners are offline" />
              )}
            </div>
          )}
          {collapsed && anyOfflineConfirmed && (
            <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-destructive animate-pulse" title="Some runners are offline" />
          )}
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-4 px-3 space-y-1 overflow-y-auto scrollbar-thin">
        {filteredNavItems.map((item) => {
          const isActive = location.pathname === item.path || 
                          (item.path !== '/dashboard' && item.path !== '/data' && item.path !== '/database' && location.pathname.startsWith(item.path));
          
          const showBadge = item.path === '/conversations' && totalUnread > 0;
          
          return (
            <NavLink
              key={item.path}
              to={item.path}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-200 group relative",
                isActive 
                  ? "bg-primary/10 text-primary font-medium" 
                  : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                collapsed && "justify-center px-2"
              )}
            >
              <div className={cn(
                "relative flex items-center justify-center",
                isActive && "text-primary"
              )}>
                <item.icon className={cn(
                  "w-5 h-5 flex-shrink-0 transition-transform duration-200",
                  !isActive && "group-hover:scale-105",
                  isActive && "text-primary"
                )} strokeWidth={isActive ? 2 : 1.5} />
                {showBadge && collapsed && (
                  <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center justify-center animate-pulse">
                    {totalUnread > 99 ? '99+' : totalUnread}
                  </span>
                )}
              </div>
              {!collapsed && (
                <span className="text-sm">{item.label}</span>
              )}
              {showBadge && !collapsed && (
                <span className="ml-auto min-w-[20px] h-[20px] rounded-full bg-destructive text-destructive-foreground text-xs font-bold flex items-center justify-center animate-pulse">
                  {totalUnread > 99 ? '99+' : totalUnread}
                </span>
              )}
              {isActive && !collapsed && !showBadge && (
                <div className="ml-auto w-1.5 h-1.5 rounded-full bg-primary" />
              )}
            </NavLink>
          );
        })}
      </nav>

      {/* User Section */}
      <div className="p-3 border-t border-sidebar-border space-y-2">
        {/* Theme Toggle */}
        <div className={cn(
          "flex items-center justify-center",
          !collapsed && "justify-end px-2"
        )}>
          <ThemeToggle />
        </div>

        <div className={cn(
          "flex items-center gap-3 p-2 rounded-lg bg-sidebar-accent/50",
          collapsed && "justify-center"
        )}>
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-primary to-telegram-light flex items-center justify-center text-primary-foreground font-semibold text-sm">
            A
          </div>
          {!collapsed && (
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-sidebar-foreground truncate">Admin</p>
            </div>
          )}
          {!collapsed && (
            <Button 
              variant="ghost" 
              size="icon" 
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              onClick={logout}
            >
              <LogOut className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Collapse Toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="absolute -right-3 top-20 w-6 h-6 rounded-full bg-sidebar-accent border border-sidebar-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      >
        {collapsed ? (
          <ChevronRight className="w-3 h-3" />
        ) : (
          <ChevronLeft className="w-3 h-3" />
        )}
      </button>
    </aside>
  );
};
