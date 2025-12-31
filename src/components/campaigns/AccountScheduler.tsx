import React, { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { 
  RotateCcw, 
  Clock, 
  Zap, 
  AlertCircle, 
  CheckCircle2, 
  XCircle,
  Timer,
  TrendingUp,
  Users,
  Pause
} from 'lucide-react';
import { TelegramAccount } from '@/types/telegram';
import { toast } from 'sonner';

interface SchedulerSettings {
  enabled: boolean;
  maxMessagesBeforeRotation: number;
  cooldownDuration: number; // minutes
  prioritizeHighMaturity: boolean;
  autoSkipRestricted: boolean;
  balanceLoad: boolean;
}

interface AccountSchedulerProps {
  accounts: TelegramAccount[];
  selectedAccountIds: string[];
  onAccountRotation: (accountId: string) => void;
  onSettingsChange: (settings: SchedulerSettings) => void;
}

interface AccountScheduleInfo {
  account: TelegramAccount;
  priority: number;
  availableIn: number; // seconds until available
  messagesRemaining: number;
  status: 'ready' | 'cooldown' | 'exhausted' | 'restricted' | 'offline';
  reason?: string;
}

const AccountScheduler: React.FC<AccountSchedulerProps> = ({
  accounts,
  selectedAccountIds,
  onAccountRotation,
  onSettingsChange
}) => {
  const [settings, setSettings] = useState<SchedulerSettings>({
    enabled: true,
    maxMessagesBeforeRotation: 5,
    cooldownDuration: 30,
    prioritizeHighMaturity: true,
    autoSkipRestricted: true,
    balanceLoad: true
  });

  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [accountCooldowns, setAccountCooldowns] = useState<Map<string, number>>(new Map());
  const [rotationCount, setRotationCount] = useState(0);

  // Calculate schedule info for each account
  const scheduleInfo = useMemo((): AccountScheduleInfo[] => {
    const selectedAccounts = accounts.filter(a => selectedAccountIds.includes(a.id));
    
    return selectedAccounts.map(account => {
      const cooldownEnd = accountCooldowns.get(account.id) || 0;
      const now = Date.now();
      const availableIn = Math.max(0, Math.ceil((cooldownEnd - now) / 1000));
      const messagesRemaining = account.dailyLimit - account.messagesSentToday;
      
      let status: AccountScheduleInfo['status'] = 'ready';
      let reason: string | undefined;
      
      if (account.status === 'banned') {
        status = 'restricted';
        reason = 'Account is banned';
      } else if (account.status === 'restricted') {
        status = 'restricted';
        reason = account.restrictedUntil 
          ? `Restricted until ${new Date(account.restrictedUntil).toLocaleTimeString()}`
          : 'Account is restricted';
      } else if (account.status === 'cooldown') {
        status = 'cooldown';
        reason = 'Account is in cooldown';
      } else if (account.status === 'disconnected') {
        status = 'offline';
        reason = 'Account is disconnected';
      } else if (messagesRemaining <= 0) {
        status = 'exhausted';
        reason = 'Daily limit reached';
      } else if (availableIn > 0) {
        status = 'cooldown';
        reason = `Available in ${availableIn}s`;
      }
      
      // Calculate priority score
      let priority = 0;
      if (status === 'ready') {
        priority = 100;
        
        // Higher maturity = higher priority
        if (settings.prioritizeHighMaturity) {
          priority += account.maturityScore * 0.5;
        }
        
        // More messages remaining = higher priority
        priority += messagesRemaining * 2;
        
        // Balance load - lower usage today = higher priority
        if (settings.balanceLoad) {
          priority += (account.dailyLimit - account.messagesSentToday) * 3;
        }
      }
      
      return {
        account,
        priority,
        availableIn,
        messagesRemaining,
        status,
        reason
      };
    }).sort((a, b) => b.priority - a.priority);
  }, [accounts, selectedAccountIds, accountCooldowns, settings]);

  // Get next available account
  const getNextAccount = (): AccountScheduleInfo | null => {
    const available = scheduleInfo.filter(info => {
      if (settings.autoSkipRestricted && ['restricted', 'offline', 'exhausted'].includes(info.status)) {
        return false;
      }
      return info.status === 'ready';
    });
    
    return available[0] || null;
  };

  // Handle account rotation
  const rotateToNextAccount = () => {
    const next = getNextAccount();
    if (next) {
      setActiveAccountId(next.account.id);
      onAccountRotation(next.account.id);
      setRotationCount(prev => prev + 1);
      toast.success(`Rotated to ${next.account.firstName || next.account.phoneNumber}`);
    } else {
      toast.error('No available accounts for rotation');
    }
  };

  // Put account on cooldown
  const putAccountOnCooldown = (accountId: string) => {
    const cooldownEnd = Date.now() + (settings.cooldownDuration * 60 * 1000);
    setAccountCooldowns(prev => new Map(prev).set(accountId, cooldownEnd));
  };

  // Update settings and notify parent
  const updateSettings = (updates: Partial<SchedulerSettings>) => {
    const newSettings = { ...settings, ...updates };
    setSettings(newSettings);
    onSettingsChange(newSettings);
    
    // Save to localStorage
    localStorage.setItem('account_scheduler_settings', JSON.stringify(newSettings));
  };

  // Load settings from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('account_scheduler_settings');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setSettings(prev => ({ ...prev, ...parsed }));
      } catch (e) {
        console.error('Failed to load scheduler settings');
      }
    }
  }, []);

  // Update cooldowns every second
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setAccountCooldowns(prev => {
        const updated = new Map(prev);
        for (const [id, endTime] of updated) {
          if (endTime <= now) {
            updated.delete(id);
          }
        }
        return updated;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const readyCount = scheduleInfo.filter(i => i.status === 'ready').length;
  const cooldownCount = scheduleInfo.filter(i => i.status === 'cooldown').length;
  const exhaustedCount = scheduleInfo.filter(i => i.status === 'exhausted').length;
  const restrictedCount = scheduleInfo.filter(i => i.status === 'restricted' || i.status === 'offline').length;

  const getStatusIcon = (status: AccountScheduleInfo['status']) => {
    switch (status) {
      case 'ready': return <CheckCircle2 className="w-4 h-4 text-green-500" />;
      case 'cooldown': return <Timer className="w-4 h-4 text-yellow-500" />;
      case 'exhausted': return <XCircle className="w-4 h-4 text-orange-500" />;
      case 'restricted': return <AlertCircle className="w-4 h-4 text-destructive" />;
      case 'offline': return <Pause className="w-4 h-4 text-muted-foreground" />;
    }
  };

  const getStatusBadge = (status: AccountScheduleInfo['status']) => {
    const variants: Record<string, string> = {
      ready: 'bg-green-500/10 text-green-600 border-green-500/20',
      cooldown: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20',
      exhausted: 'bg-orange-500/10 text-orange-600 border-orange-500/20',
      restricted: 'bg-destructive/10 text-destructive border-destructive/20',
      offline: 'bg-muted text-muted-foreground border-border'
    };
    return variants[status] || variants.offline;
  };

  return (
    <div className="space-y-4">
      {/* Header with Toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <RotateCcw className="w-5 h-5 text-primary" />
          <h3 className="font-semibold">Account Scheduler</h3>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="scheduler-toggle" className="text-sm">Auto-Rotate</Label>
          <Switch
            id="scheduler-toggle"
            checked={settings.enabled}
            onCheckedChange={(enabled) => updateSettings({ enabled })}
          />
        </div>
      </div>

      {/* Stats Overview */}
      <div className="grid grid-cols-4 gap-2">
        <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-center">
          <p className="text-xl font-bold text-green-600">{readyCount}</p>
          <p className="text-xs text-muted-foreground">Ready</p>
        </div>
        <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-center">
          <p className="text-xl font-bold text-yellow-600">{cooldownCount}</p>
          <p className="text-xs text-muted-foreground">Cooldown</p>
        </div>
        <div className="p-3 rounded-lg bg-orange-500/10 border border-orange-500/20 text-center">
          <p className="text-xl font-bold text-orange-600">{exhaustedCount}</p>
          <p className="text-xs text-muted-foreground">Exhausted</p>
        </div>
        <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-center">
          <p className="text-xl font-bold text-destructive">{restrictedCount}</p>
          <p className="text-xs text-muted-foreground">Unavailable</p>
        </div>
      </div>

      {/* Settings */}
      <Card className="bg-accent/30">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Zap className="w-4 h-4" />
            Rotation Settings
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <Label>Messages before rotation</Label>
              <span className="font-medium">{settings.maxMessagesBeforeRotation}</span>
            </div>
            <Slider
              value={[settings.maxMessagesBeforeRotation]}
              onValueChange={([v]) => updateSettings({ maxMessagesBeforeRotation: v })}
              min={1}
              max={25}
              step={1}
            />
          </div>

          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <Label>Cooldown duration (minutes)</Label>
              <span className="font-medium">{settings.cooldownDuration}m</span>
            </div>
            <Slider
              value={[settings.cooldownDuration]}
              onValueChange={([v]) => updateSettings({ cooldownDuration: v })}
              min={5}
              max={120}
              step={5}
            />
          </div>

          <Separator />

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label htmlFor="priority-maturity" className="text-sm">Prioritize high maturity accounts</Label>
              <Switch
                id="priority-maturity"
                checked={settings.prioritizeHighMaturity}
                onCheckedChange={(v) => updateSettings({ prioritizeHighMaturity: v })}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="auto-skip" className="text-sm">Auto-skip restricted accounts</Label>
              <Switch
                id="auto-skip"
                checked={settings.autoSkipRestricted}
                onCheckedChange={(v) => updateSettings({ autoSkipRestricted: v })}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="balance-load" className="text-sm">Balance load across accounts</Label>
              <Switch
                id="balance-load"
                checked={settings.balanceLoad}
                onCheckedChange={(v) => updateSettings({ balanceLoad: v })}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Account Queue */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Users className="w-4 h-4" />
              Account Queue
            </CardTitle>
            <Button 
              size="sm" 
              variant="outline" 
              onClick={rotateToNextAccount}
              disabled={readyCount === 0}
            >
              <RotateCcw className="w-3 h-3 mr-1" />
              Rotate Now
            </Button>
          </div>
          <CardDescription className="text-xs">
            {rotationCount} rotations performed
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-60">
            <div className="space-y-2">
              {scheduleInfo.map((info, index) => (
                <div 
                  key={info.account.id}
                  className={`flex items-center justify-between p-3 rounded-lg border ${
                    activeAccountId === info.account.id 
                      ? 'bg-primary/10 border-primary' 
                      : 'bg-accent/30 border-border'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="flex items-center justify-center w-6 h-6 rounded-full bg-muted text-xs font-medium">
                      {index + 1}
                    </div>
                    {getStatusIcon(info.status)}
                    <div>
                      <p className="text-sm font-medium">
                        {info.account.firstName || info.account.phoneNumber}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {info.reason || `${info.messagesRemaining} messages left`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className={getStatusBadge(info.status)}>
                      {info.status}
                    </Badge>
                    {info.status === 'ready' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          putAccountOnCooldown(info.account.id);
                          rotateToNextAccount();
                        }}
                        className="h-7 px-2"
                      >
                        Skip
                      </Button>
                    )}
                  </div>
                </div>
              ))}
              
              {scheduleInfo.length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                  <Users className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">No accounts selected</p>
                </div>
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Active Account Indicator */}
      {activeAccountId && (
        <div className="p-4 rounded-lg bg-primary/10 border border-primary/30">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-primary" />
            <div>
              <p className="text-sm font-medium">Currently Active</p>
              <p className="text-xs text-muted-foreground">
                {scheduleInfo.find(i => i.account.id === activeAccountId)?.account.firstName || 
                 scheduleInfo.find(i => i.account.id === activeAccountId)?.account.phoneNumber}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AccountScheduler;
