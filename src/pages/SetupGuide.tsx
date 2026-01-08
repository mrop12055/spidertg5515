import React from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Download, Loader2, Server, Monitor, Upload, CheckCircle2, BookOpen } from 'lucide-react';
import { toast } from 'sonner';
import JSZip from 'jszip';
import { supabase } from '@/integrations/supabase/client';
import { VPSControlPanel } from '@/components/setup/VPSControlPanel';

// Import actual Python files as raw strings (single source of truth!)
import campaignRunnerPy from '../../python/campaign_runner.py?raw';
import livechatRunnerPy from '../../python/live_chat_listener.py?raw';
import accountRunnerPy from '../../python/account_manager.py?raw';
import warmupRunnerPy from '../../python/warmup_runner.py?raw';
import clientManagerPy from '../../python/client_manager.py?raw';
import fingerprintGeneratorPy from '../../python/fingerprint_generator.py?raw';
import requirementsTxt from '../../python/requirements.txt?raw';
import vpsAgentPy from '../../python/vps_agent.py?raw';

const SetupGuide: React.FC = () => {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const [isSyncing, setIsSyncing] = React.useState(false);
  const [lastSyncTime, setLastSyncTime] = React.useState<Date | null>(null);

  // Only config.py needs dynamic values - generate it here
  const configPy = `"""
TelegramCRM - Configuration
"""

BACKEND_URL = "${supabaseUrl}/functions/v1"
SUPABASE_URL = "${supabaseUrl}"
SUPABASE_KEY = "${supabaseKey}"
TELEGRAM_API_ID = "31812270"
TELEGRAM_API_HASH = "4cce3baadfdb22bd5930f9d8f5063f98"
`;

  // RUN.bat for PC version
  const runBat = `@echo off
title TelegramCRM - All Runners
echo ============================================
echo       TelegramCRM - Starting All Runners
echo ============================================
echo.
echo Starting 4 runners in separate windows...
echo.

start "Campaign Runner" cmd /k "python campaign_runner.py"
start "LiveChat Runner" cmd /k "python live_chat_listener.py"
start "Account Manager" cmd /k "python account_manager.py"
start "Warmup Runner" cmd /k "python warmup_runner.py"

echo.
echo All runners started!
echo Close this window when done.
pause
`;

  const generateVpsApiKey = () => {
    return 'vps_' + Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  };

  const downloadZip = async () => {
    const zip = new JSZip();
    const folder = zip.folder("telegram_crm");
    
    // Generate build timestamp
    const buildTime = new Date();
    const buildTimestamp = buildTime.toISOString();
    const buildInfo = `TelegramCRM Build Info
========================
Generated: ${buildTimestamp}
Version: ${buildTime.getTime()}

If you see IndentationError, make sure you:
1. Downloaded this ZIP AFTER doing a hard refresh (Ctrl+F5) on the Setup page
2. Extracted to a NEW folder (delete old telegram_crm folders first)
3. Are running from the newly extracted folder
`;
    
    // Core files
    folder?.file("BUILD_INFO.txt", buildInfo);
    folder?.file("config.py", configPy);
    folder?.file("client_manager.py", clientManagerPy);
    folder?.file("fingerprint_generator.py", fingerprintGeneratorPy);
    folder?.file("requirements.txt", requirementsTxt);
    
    // Individual runners
    folder?.file("campaign_runner.py", campaignRunnerPy);
    folder?.file("live_chat_listener.py", livechatRunnerPy);
    folder?.file("account_manager.py", accountRunnerPy);
    folder?.file("warmup_runner.py", warmupRunnerPy);
    
    // BAT file to run all
    folder?.file("RUN.bat", runBat);
    
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    
    // Unique filename with timestamp to prevent confusion
    const dateStr = buildTime.toISOString().slice(0,16).replace(/[-:T]/g, '');
    a.download = `telegram_crm_${dateStr}.zip`;
    a.click();
    URL.revokeObjectURL(url);
    
    toast.success("ZIP downloaded! 10 files included (check BUILD_INFO.txt for version).");
  };

  const downloadVpsZip = async () => {
    const vpsApiKey = generateVpsApiKey();
    
    // Inject credentials into vps_agent.py
    const vpsAgentWithKey = vpsAgentPy
      .replace('SUPABASE_URL = "YOUR_SUPABASE_URL"', `SUPABASE_URL = "${supabaseUrl}"`)
      .replace('SUPABASE_KEY = "YOUR_SUPABASE_KEY"', `SUPABASE_KEY = "${supabaseKey}"`)
      .replace('VPS_API_KEY = "YOUR_VPS_API_KEY"', `VPS_API_KEY = "${vpsApiKey}"`);
    
    const zip = new JSZip();
    const folder = zip.folder("telegram_crm_vps");
    
    // Core files
    folder?.file("config.py", configPy);
    folder?.file("client_manager.py", clientManagerPy);
    folder?.file("fingerprint_generator.py", fingerprintGeneratorPy);
    folder?.file("requirements.txt", requirementsTxt);
    
    // Individual runners
    folder?.file("campaign_runner.py", campaignRunnerPy);
    folder?.file("live_chat_listener.py", livechatRunnerPy);
    folder?.file("account_manager.py", accountRunnerPy);
    folder?.file("warmup_runner.py", warmupRunnerPy);
    
    // VPS Agent with injected credentials
    folder?.file("vps_agent.py", vpsAgentWithKey);
    
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "telegram_crm_vps.zip";
    a.click();
    URL.revokeObjectURL(url);
    
    toast.success("VPS ZIP downloaded! Run vps_agent.py on your server.");
  };

  // Sync scripts to storage for VPS updates
  const syncScriptsToStorage = async (showToast = true) => {
    setIsSyncing(true);
    try {
      const zip = new JSZip();
      zip.file("campaign_runner.py", campaignRunnerPy);
      zip.file("live_chat_listener.py", livechatRunnerPy);
      zip.file("account_manager.py", accountRunnerPy);
      zip.file("warmup_runner.py", warmupRunnerPy);
      zip.file("client_manager.py", clientManagerPy);
      zip.file("fingerprint_generator.py", fingerprintGeneratorPy);
      zip.file("config.py", configPy);
      zip.file("requirements.txt", requirementsTxt);
      zip.file("RUN.bat", runBat);

      const blob = await zip.generateAsync({ type: "blob" });
      
      const { error } = await supabase.storage
        .from('python-scripts')
        .upload('runners.zip', blob, { 
          upsert: true,
          contentType: 'application/zip'
        });
      
      if (error) throw error;
      
      setLastSyncTime(new Date());
      console.log('[Sync] Scripts synced to storage');
      if (showToast) {
        toast.success("Scripts synced to VPS storage! Click 'Update All' in VPS controls to apply.");
      }
    } catch (error) {
      console.error('[Sync] Failed to sync scripts:', error);
      if (showToast) {
        toast.error("Failed to sync scripts to storage");
      }
    } finally {
      setIsSyncing(false);
    }
  };

  // Auto-sync scripts to storage on page load
  React.useEffect(() => {
    syncScriptsToStorage(false);
  }, []);

  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-3xl mx-auto">
        <PageHeader
          title="Setup"
          description="Download Python files for your PC or VPS"
          icon={BookOpen}
        />

        <Tabs defaultValue="pc" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="pc" className="gap-2">
              <Monitor className="h-4 w-4" />
              Run on PC
            </TabsTrigger>
            <TabsTrigger value="vps" className="gap-2">
              <Server className="h-4 w-4" />
              Run on VPS
              <Badge variant="secondary" className="ml-1 text-xs">Remote Control</Badge>
            </TabsTrigger>
          </TabsList>

          {/* PC Mode */}
          <TabsContent value="pc">
            <Card>
              <CardContent className="p-8 text-center space-y-6">
                <div className="space-y-2">
                  <h2 className="text-2xl font-bold">Download for PC</h2>
                  <p className="text-muted-foreground">
                    4 separate runners + 1 BAT file to run them all
                  </p>
                </div>

                <Button size="lg" onClick={downloadZip} className="gap-2 text-lg px-8 py-6">
                  <Download className="h-6 w-6" />
                  Download ZIP
                </Button>

                <div className="text-left bg-muted rounded-lg p-4 space-y-3">
                  <p className="font-medium">📁 Files included (9 total):</p>
                  <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1">
                    <li><code className="text-green-600 dark:text-green-400">RUN.bat</code> - <strong>Double-click to START all 4 runners</strong></li>
                    <li><code className="text-blue-500">campaign_runner.py</code> - Send messages + batch reporting</li>
                    <li><code className="text-purple-500">live_chat_listener.py</code> - Incoming messages + replies</li>
                    <li><code className="text-yellow-500">account_manager.py</code> - SpamBot, name, photo, privacy</li>
                    <li><code className="text-orange-500">warmup_runner.py</code> - Warmup chat (pairs) + join/view/react/bio</li>
                    <li><code>config.py</code> - Backend settings</li>
                    <li><code>client_manager.py</code> - Shared Telegram logic + batch reporting</li>
                    <li><code>fingerprint_generator.py</code> - Device fingerprints</li>
                    <li><code>requirements.txt</code> - Dependencies</li>
                  </ul>
                </div>

                <div className="text-left bg-muted rounded-lg p-4 space-y-3">
                  <p className="font-medium">🚀 How to use:</p>
                  <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground">
                    <li>Extract ZIP folder</li>
                    <li>Double-click <code className="bg-green-100 dark:bg-green-900 px-2 py-0.5 rounded">RUN.bat</code></li>
                    <li>4 colored windows will open (one for each runner)</li>
                    <li>To stop: Close all windows or press <kbd className="bg-background px-2 py-0.5 rounded border">Ctrl+C</kbd></li>
                  </ol>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* VPS Mode */}
          <TabsContent value="vps">
            <div className="space-y-4">
              {/* VPS Control Panel */}
              <VPSControlPanel />

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Server className="h-5 w-5 text-primary" />
                    VPS Setup
                    <Badge variant="outline" className="ml-2">Recommended</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="text-sm text-muted-foreground">
                    Control your runners remotely. Start, stop, restart, view logs, and auto-update scripts - all from your browser!
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Step 1: Download */}
                    <div className="p-4 rounded-lg border bg-muted/30 space-y-3">
                      <div className="flex items-center gap-2 font-medium">
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs">1</span>
                        Download VPS Package
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Includes VPS Agent for remote control + all runners
                      </p>
                      <Button onClick={downloadVpsZip} className="w-full gap-2">
                        <Download className="h-4 w-4" />
                        Download VPS ZIP
                      </Button>
                    </div>

                    {/* Step 2: Setup */}
                    <div className="p-4 rounded-lg border bg-muted/30 space-y-3">
                      <div className="flex items-center gap-2 font-medium">
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs">2</span>
                        Setup on VPS
                      </div>
                      <div className="text-xs text-muted-foreground space-y-1">
                        <p><code>pip install -r requirements.txt</code></p>
                        <p><code>python vps_agent.py</code></p>
                      </div>
                    </div>
                  </div>

                  <div className="p-4 rounded-lg border border-green-500/30 bg-green-500/5 space-y-2">
                    <div className="flex items-center gap-2 font-medium text-green-600">
                      <CheckCircle2 className="h-4 w-4" />
                      What you get with VPS mode
                    </div>
                    <ul className="text-sm text-muted-foreground space-y-1 ml-6">
                      <li>• Start/stop individual runners remotely</li>
                      <li>• View real-time logs in your browser</li>
                      <li>• Auto-restart on crash</li>
                      <li>• One-click script updates (auto-sync)</li>
                    </ul>
                  </div>
                </CardContent>
              </Card>

              {/* Manual Sync Button */}
              <Card className="border-blue-500/30 bg-blue-500/5">
                <CardContent className="py-4">
                  <div className="flex items-start gap-3">
                    <Upload className="h-5 w-5 text-blue-500 mt-0.5" />
                    <div className="flex-1 space-y-2">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-medium text-blue-600 dark:text-blue-400">Sync Scripts to VPS Storage</p>
                        {lastSyncTime && (
                          <span className="text-xs text-muted-foreground">
                            Last synced: {lastSyncTime.toLocaleTimeString()}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Upload latest scripts to storage. Then click "Update All" in VPS controls above to apply on your VPS.
                      </p>
                      <Button 
                        onClick={() => syncScriptsToStorage(true)} 
                        disabled={isSyncing}
                        variant="outline"
                        size="sm"
                        className="gap-2"
                      >
                        {isSyncing ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Syncing...
                          </>
                        ) : (
                          <>
                            <Upload className="h-4 w-4" />
                            Sync Scripts Now
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>

      </div>
    </DashboardLayout>
  );
};

export default SetupGuide;
