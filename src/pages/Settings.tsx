import React, { useState, useEffect } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { useToast } from '@/hooks/use-toast';
import { toast } from 'sonner';
import { 
  Settings as SettingsIcon, 
  Bell, 
  Shield, 
  Clock, 
  MessageSquare,
  Save,
  Download,
  Zap,
  RotateCcw
} from 'lucide-react';

const Settings: React.FC = () => {
  const { toast: showToast } = useToast();
  const [settings, setSettings] = useState({
    dailyMessageLimit: 25,
    messageCooldown: 60,
    autoRestartBanned: false,
    notifyOnReply: true,
    notifyOnBan: true,
    maturationAutoRun: false,
    proxyRotation: false,
  });

  // Python script scheduler settings
  const [schedulerSettings, setSchedulerSettings] = useState({
    enabled: true,
    maxMessagesBeforeRotation: 10,
    cooldownDuration: 10,
    prioritizeHighMaturity: true,
    autoSkipRestricted: true,
    balanceLoad: true,
    messagesPerAccount: 10,
    messageInterval: 3,
    accountSwitchDelay: 5,
  });

  // Load scheduler settings from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('python_scheduler_settings');
    if (saved) {
      try {
        setSchedulerSettings(prev => ({ ...prev, ...JSON.parse(saved) }));
      } catch (e) {
        console.error('Failed to load scheduler settings');
      }
    }
  }, []);

  // Save scheduler settings to localStorage when changed
  const updateSchedulerSettings = (updates: Partial<typeof schedulerSettings>) => {
    const newSettings = { ...schedulerSettings, ...updates };
    setSchedulerSettings(newSettings);
    localStorage.setItem('python_scheduler_settings', JSON.stringify(newSettings));
  };

  // Export settings as JSON file for Python script
  const handleExportSettings = () => {
    const exportSettings = {
      enabled: schedulerSettings.enabled,
      maxMessagesBeforeRotation: schedulerSettings.maxMessagesBeforeRotation,
      cooldownDuration: schedulerSettings.cooldownDuration,
      prioritizeHighMaturity: schedulerSettings.prioritizeHighMaturity,
      autoSkipRestricted: schedulerSettings.autoSkipRestricted,
      balanceLoad: schedulerSettings.balanceLoad,
      messagesPerAccount: schedulerSettings.messagesPerAccount,
      messageInterval: schedulerSettings.messageInterval,
      accountSwitchDelay: schedulerSettings.accountSwitchDelay,
    };
    
    const blob = new Blob([JSON.stringify(exportSettings, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'scheduler_settings.json';
    a.click();
    URL.revokeObjectURL(url);
    
    toast.success('Settings exported! Place scheduler_settings.json next to the Python script.');
  };

  const handleSave = () => {
    showToast({
      title: "Settings saved",
      description: "Your settings have been updated successfully.",
    });
  };

  return (
    <DashboardLayout>
      <PageHeader
        title="Settings"
        description="Configure your Telegram Hub preferences"
      />

      <div className="max-w-3xl space-y-6">
        {/* Python Script Speed Settings */}
        <Card className="border-primary/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="w-5 h-5 text-primary" />
              Python Script Speed Settings
            </CardTitle>
            <CardDescription>
              Configure message intervals and account rotation for the Python script
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <Label>Enable Auto-Rotation</Label>
                <p className="text-sm text-muted-foreground">
                  Automatically rotate between accounts while sending
                </p>
              </div>
              <Switch
                checked={schedulerSettings.enabled}
                onCheckedChange={(checked) => updateSchedulerSettings({ enabled: checked })}
              />
            </div>
            
            <Separator />
            
            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label>Message Interval</Label>
                  <span className="text-sm font-medium">{schedulerSettings.messageInterval}s</span>
                </div>
                <Slider
                  value={[schedulerSettings.messageInterval]}
                  onValueChange={([value]) => updateSchedulerSettings({ messageInterval: value })}
                  min={1}
                  max={60}
                  step={1}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Seconds between each message. Lower = faster but riskier.
                </p>
              </div>
              
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label>Account Switch Delay</Label>
                  <span className="text-sm font-medium">{schedulerSettings.accountSwitchDelay}s</span>
                </div>
                <Slider
                  value={[schedulerSettings.accountSwitchDelay]}
                  onValueChange={([value]) => updateSchedulerSettings({ accountSwitchDelay: value })}
                  min={1}
                  max={120}
                  step={1}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Seconds to wait before switching to next account
                </p>
              </div>
              
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label>Messages Per Account</Label>
                  <span className="text-sm font-medium">{schedulerSettings.messagesPerAccount}</span>
                </div>
                <Slider
                  value={[schedulerSettings.messagesPerAccount]}
                  onValueChange={([value]) => updateSchedulerSettings({ messagesPerAccount: value })}
                  min={1}
                  max={50}
                  step={1}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Messages to send before rotating to next account
                </p>
              </div>
              
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label>Cooldown Duration</Label>
                  <span className="text-sm font-medium">{schedulerSettings.cooldownDuration} min</span>
                </div>
                <Slider
                  value={[schedulerSettings.cooldownDuration]}
                  onValueChange={([value]) => updateSchedulerSettings({ cooldownDuration: value })}
                  min={1}
                  max={60}
                  step={1}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Minutes to rest an account after it finishes its turn
                </p>
              </div>
            </div>
            
            <Separator />
            
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm">Prioritize high maturity accounts</Label>
                <Switch
                  checked={schedulerSettings.prioritizeHighMaturity}
                  onCheckedChange={(v) => updateSchedulerSettings({ prioritizeHighMaturity: v })}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-sm">Auto-skip restricted accounts</Label>
                <Switch
                  checked={schedulerSettings.autoSkipRestricted}
                  onCheckedChange={(v) => updateSchedulerSettings({ autoSkipRestricted: v })}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-sm">Balance load across accounts</Label>
                <Switch
                  checked={schedulerSettings.balanceLoad}
                  onCheckedChange={(v) => updateSchedulerSettings({ balanceLoad: v })}
                />
              </div>
            </div>
            
            <Separator />
            
            <div className="space-y-2">
              <Button 
                variant="outline" 
                onClick={handleExportSettings}
                className="w-full"
              >
                <Download className="w-4 h-4 mr-2" />
                Export Settings for Python Script
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                Place <code className="bg-muted px-1 rounded">scheduler_settings.json</code> in the same folder as your Python script
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Messaging Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="w-5 h-5" />
              Account Limits
            </CardTitle>
            <CardDescription>
              Configure default limits for accounts
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label>Daily Message Limit (per account)</Label>
                  <span className="text-sm font-medium">{settings.dailyMessageLimit} messages</span>
                </div>
                <Slider
                  value={[settings.dailyMessageLimit]}
                  onValueChange={([value]) => setSettings(prev => ({ ...prev, dailyMessageLimit: value }))}
                  min={5}
                  max={100}
                  step={5}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Safety Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="w-5 h-5" />
              Safety Settings
            </CardTitle>
            <CardDescription>
              Protect your accounts from bans
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <Label>Auto-restart banned accounts</Label>
                <p className="text-sm text-muted-foreground">
                  Automatically attempt to reconnect banned accounts after 24h
                </p>
              </div>
              <Switch
                checked={settings.autoRestartBanned}
                onCheckedChange={(checked) => setSettings(prev => ({ ...prev, autoRestartBanned: checked }))}
              />
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <Label>Proxy Rotation</Label>
                <p className="text-sm text-muted-foreground">
                  Rotate proxies periodically for better anonymity
                </p>
              </div>
              <Switch
                checked={settings.proxyRotation}
                onCheckedChange={(checked) => setSettings(prev => ({ ...prev, proxyRotation: checked }))}
              />
            </div>
          </CardContent>
        </Card>

        {/* Notification Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bell className="w-5 h-5" />
              Notifications
            </CardTitle>
            <CardDescription>
              Configure alerts and notifications
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <Label>Notify on reply</Label>
                <p className="text-sm text-muted-foreground">
                  Get notified when someone replies to your messages
                </p>
              </div>
              <Switch
                checked={settings.notifyOnReply}
                onCheckedChange={(checked) => setSettings(prev => ({ ...prev, notifyOnReply: checked }))}
              />
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <Label>Notify on ban</Label>
                <p className="text-sm text-muted-foreground">
                  Get notified when an account gets banned or restricted
                </p>
              </div>
              <Switch
                checked={settings.notifyOnBan}
                onCheckedChange={(checked) => setSettings(prev => ({ ...prev, notifyOnBan: checked }))}
              />
            </div>
          </CardContent>
        </Card>

        {/* Maturation Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="w-5 h-5" />
              Maturation
            </CardTitle>
            <CardDescription>
              Automatic account maturation settings
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <Label>Auto-run maturation</Label>
                <p className="text-sm text-muted-foreground">
                  Automatically mature new accounts in the background
                </p>
              </div>
              <Switch
                checked={settings.maturationAutoRun}
                onCheckedChange={(checked) => setSettings(prev => ({ ...prev, maturationAutoRun: checked }))}
              />
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button onClick={handleSave} className="gap-2">
            <Save className="w-4 h-4" />
            Save Settings
          </Button>
        </div>
      </div>
    </DashboardLayout>
  );
};

export default Settings;
