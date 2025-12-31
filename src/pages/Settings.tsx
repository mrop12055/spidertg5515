import React, { useState } from 'react';
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
import { 
  Settings as SettingsIcon, 
  Bell, 
  Shield, 
  Clock, 
  MessageSquare,
  Save
} from 'lucide-react';

const Settings: React.FC = () => {
  const { toast } = useToast();
  const [settings, setSettings] = useState({
    dailyMessageLimit: 25,
    messageCooldown: 60,
    autoRestartBanned: false,
    notifyOnReply: true,
    notifyOnBan: true,
    maturationAutoRun: false,
    proxyRotation: false,
  });

  const handleSave = () => {
    toast({
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
        {/* Messaging Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="w-5 h-5" />
              Messaging Settings
            </CardTitle>
            <CardDescription>
              Configure message limits and timing
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
              <Separator />
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label>Message Cooldown</Label>
                  <span className="text-sm font-medium">{settings.messageCooldown} seconds</span>
                </div>
                <Slider
                  value={[settings.messageCooldown]}
                  onValueChange={([value]) => setSettings(prev => ({ ...prev, messageCooldown: value }))}
                  min={10}
                  max={300}
                  step={10}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Time between messages to avoid rate limiting
                </p>
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
