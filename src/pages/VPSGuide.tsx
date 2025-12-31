import React, { useState } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  Server, 
  Terminal, 
  Key, 
  Play, 
  CheckCircle2,
  Copy,
  ExternalLink,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface StepProps {
  number: number;
  title: string;
  description: string;
  completed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

const Step: React.FC<StepProps> = ({ number, title, description, completed, onToggle, children, defaultOpen = false }) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  
  return (
    <Card className={completed ? 'border-primary/50 bg-primary/5' : ''}>
      <CardHeader 
        className="cursor-pointer"
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className="flex items-start gap-4">
          <div className="flex items-center gap-3">
            <Checkbox 
              checked={completed} 
              onCheckedChange={onToggle}
              onClick={(e) => e.stopPropagation()}
            />
            <Badge variant={completed ? "default" : "secondary"} className="w-8 h-8 rounded-full flex items-center justify-center p-0">
              {completed ? <CheckCircle2 className="w-4 h-4" /> : number}
            </Badge>
          </div>
          <div className="flex-1">
            <CardTitle className="text-lg flex items-center justify-between">
              {title}
              {isOpen ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
            </CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      {isOpen && (
        <CardContent className="pt-0 pl-16">
          {children}
        </CardContent>
      )}
    </Card>
  );
};

const CodeBlock: React.FC<{ code: string; language?: string }> = ({ code, language = 'bash' }) => {
  const { toast } = useToast();
  
  const copyToClipboard = () => {
    navigator.clipboard.writeText(code);
    toast({
      title: "Copied!",
      description: "Code copied to clipboard",
    });
  };
  
  return (
    <div className="relative group">
      <pre className="bg-muted p-4 rounded-lg overflow-x-auto text-sm">
        <code>{code}</code>
      </pre>
      <Button 
        size="icon" 
        variant="ghost" 
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={copyToClipboard}
      >
        <Copy className="w-4 h-4" />
      </Button>
    </div>
  );
};

const VPSGuide: React.FC = () => {
  const { toast } = useToast();
  const [completedSteps, setCompletedSteps] = useState<number[]>([]);
  
  const toggleStep = (step: number) => {
    setCompletedSteps(prev => 
      prev.includes(step) 
        ? prev.filter(s => s !== step)
        : [...prev, step]
    );
  };
  
  const progress = Math.round((completedSteps.length / 9) * 100);

  return (
    <DashboardLayout>
      <PageHeader
        title="VPS Setup Guide"
        description="Step-by-step guide to set up your Telegram backend server"
      />

      <div className="max-w-4xl space-y-6">
        {/* Progress Card */}
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">Setup Progress</span>
              <span className="text-sm text-muted-foreground">{completedSteps.length}/9 steps completed</span>
            </div>
            <div className="w-full bg-muted rounded-full h-2">
              <div 
                className="bg-primary h-2 rounded-full transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </CardContent>
        </Card>

        <ScrollArea className="h-[calc(100vh-280px)]">
          <div className="space-y-4 pr-4">
            {/* Step 1: Create VPS */}
            <Step
              number={1}
              title="Create a VPS"
              description="Get a server from DigitalOcean, Linode, or COIN.HOST (crypto)"
              completed={completedSteps.includes(1)}
              onToggle={() => toggleStep(1)}
              defaultOpen={true}
            >
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Card className="p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Server className="w-5 h-5 text-primary" />
                      <span className="font-medium">DigitalOcean</span>
                      <Badge variant="outline">$6/mo</Badge>
                    </div>
                    <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
                      <li>Go to digitalocean.com</li>
                      <li>Create → Droplets</li>
                      <li>Select Ubuntu 22.04 LTS</li>
                      <li>Choose Basic $6/mo plan</li>
                      <li>Set a password</li>
                      <li>Create Droplet</li>
                    </ol>
                    <Button variant="outline" size="sm" className="mt-3 gap-2" asChild>
                      <a href="https://digitalocean.com" target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="w-4 h-4" />
                        Open DigitalOcean
                      </a>
                    </Button>
                  </Card>
                  
                  <Card className="p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Server className="w-5 h-5 text-primary" />
                      <span className="font-medium">Linode</span>
                      <Badge variant="outline">$5/mo</Badge>
                    </div>
                    <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
                      <li>Go to linode.com</li>
                      <li>Click Create Linode</li>
                      <li>Select Ubuntu 22.04 LTS</li>
                      <li>Choose Nanode 1GB plan</li>
                      <li>Set root password</li>
                      <li>Create Linode</li>
                    </ol>
                    <Button variant="outline" size="sm" className="mt-3 gap-2" asChild>
                      <a href="https://linode.com" target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="w-4 h-4" />
                        Open Linode
                      </a>
                    </Button>
                  </Card>

                  <Card className="p-4 border-primary/50 bg-primary/5">
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      <Server className="w-5 h-5 text-primary" />
                      <span className="font-medium">COIN.HOST</span>
                      <Badge variant="outline">€4.50/mo</Badge>
                      <Badge className="bg-amber-500/20 text-amber-600 border-amber-500/30">Crypto</Badge>
                    </div>
                    <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
                      <li>Go to coin.host</li>
                      <li>Click Cloud VPS</li>
                      <li>Select Ubuntu 22.04 LTS</li>
                      <li>Choose SSD-1 plan (1GB RAM)</li>
                      <li>Pay with BTC, ETH, LTC, XMR</li>
                      <li>Copy your IP address</li>
                    </ol>
                    <Button variant="outline" size="sm" className="mt-3 gap-2" asChild>
                      <a href="https://coin.host" target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="w-4 h-4" />
                        Open COIN.HOST
                      </a>
                    </Button>
                  </Card>
                </div>
                <p className="text-sm text-muted-foreground">
                  After creating, copy your server's <strong>IP Address</strong> (e.g., 165.232.xxx.xxx)
                </p>
              </div>
            </Step>

            {/* Step 2: Connect to VPS */}
            <Step
              number={2}
              title="Connect to Your VPS"
              description="Use SSH to access your server"
              completed={completedSteps.includes(2)}
              onToggle={() => toggleStep(2)}
            >
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Open Terminal (Mac/Linux) or PowerShell (Windows) and run:
                </p>
                <CodeBlock code="ssh root@YOUR_IP_ADDRESS" />
                <p className="text-sm text-muted-foreground">
                  Replace YOUR_IP_ADDRESS with your actual VPS IP. Enter your password when prompted.
                </p>
              </div>
            </Step>

            {/* Step 3: Install Dependencies */}
            <Step
              number={3}
              title="Install Dependencies"
              description="Set up Python and required packages"
              completed={completedSteps.includes(3)}
              onToggle={() => toggleStep(3)}
            >
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Run these commands one by one:
                </p>
                <CodeBlock code={`# Update system
apt update && apt upgrade -y

# Install required packages
apt install -y python3 python3-pip python3-venv git screen

# Create bot directory
mkdir -p /opt/telegram-hub
cd /opt/telegram-hub

# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install Python packages
pip install telethon aiohttp python-socks aiosqlite cryptography`} />
              </div>
            </Step>

            {/* Step 4: Get Telegram API Credentials */}
            <Step
              number={4}
              title="Get Telegram API Credentials"
              description="Register your application with Telegram"
              completed={completedSteps.includes(4)}
              onToggle={() => toggleStep(4)}
            >
              <div className="space-y-4">
                <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
                  <li>Go to <a href="https://my.telegram.org" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">my.telegram.org</a></li>
                  <li>Log in with your phone number</li>
                  <li>Click "API Development Tools"</li>
                  <li>Create a new application:
                    <ul className="ml-6 mt-1 list-disc">
                      <li>App title: Telegram Hub</li>
                      <li>Short name: tghub</li>
                      <li>Platform: Desktop</li>
                    </ul>
                  </li>
                  <li>Save your <strong>API ID</strong> and <strong>API Hash</strong></li>
                </ol>
                <Button variant="outline" size="sm" className="gap-2" asChild>
                  <a href="https://my.telegram.org" target="_blank" rel="noopener noreferrer">
                    <Key className="w-4 h-4" />
                    Open my.telegram.org
                  </a>
                </Button>
              </div>
            </Step>

            {/* Step 5: Create Config */}
            <Step
              number={5}
              title="Create Configuration File"
              description="Set up your config.py with credentials"
              completed={completedSteps.includes(5)}
              onToggle={() => toggleStep(5)}
            >
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Create the config file:
                </p>
                <CodeBlock code="nano /opt/telegram-hub/config.py" />
                <p className="text-sm text-muted-foreground">
                  Paste this content (replace with your values):
                </p>
                <CodeBlock code={`# Supabase Configuration
SUPABASE_URL = "https://ismtbdcnbxyyvsacbeld.supabase.co"
SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlzbXRiZGNuYnh5eXZzYWNiZWxkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcxMjM5NzksImV4cCI6MjA4MjY5OTk3OX0.j0PjzGtgTtyhRvuG_IqsCHzrNBB_tni67q2_3SVXwL0"

# VPS API Key (generate at uuidgenerator.net)
VPS_API_KEY = "YOUR_RANDOM_API_KEY_HERE"

# Telegram API Credentials
TELEGRAM_API_ID = 12345678  # Your API ID
TELEGRAM_API_HASH = "your_api_hash_here"

# Settings
MESSAGE_DELAY_MIN = 30
MESSAGE_DELAY_MAX = 60
MAX_MESSAGES_PER_DAY = 50
HEARTBEAT_INTERVAL = 30`} />
                <p className="text-sm text-muted-foreground">
                  Press <kbd className="px-2 py-1 bg-muted rounded">Ctrl+X</kbd>, then <kbd className="px-2 py-1 bg-muted rounded">Y</kbd>, then <kbd className="px-2 py-1 bg-muted rounded">Enter</kbd> to save.
                </p>
              </div>
            </Step>

            {/* Step 6: Create Main Script */}
            <Step
              number={6}
              title="Create Main Backend Script"
              description="Set up the Python backend"
              completed={completedSteps.includes(6)}
              onToggle={() => toggleStep(6)}
            >
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Create the main script:
                </p>
                <CodeBlock code="nano /opt/telegram-hub/main.py" />
                <p className="text-sm text-muted-foreground">
                  The full script is available in the docs folder of your project. Copy the contents of <code className="px-2 py-1 bg-muted rounded">docs/VPS_STEP_BY_STEP_GUIDE.md</code> (Step 5 section).
                </p>
                <Button variant="outline" size="sm" className="gap-2" onClick={() => {
                  toast({
                    title: "Script location",
                    description: "Check docs/VPS_STEP_BY_STEP_GUIDE.md in your project files for the full main.py code",
                  });
                }}>
                  <Terminal className="w-4 h-4" />
                  View Full Script
                </Button>
              </div>
            </Step>

            {/* Step 7: Create Session Generator */}
            <Step
              number={7}
              title="Create Session Generator"
              description="Script to generate Telegram session strings"
              completed={completedSteps.includes(7)}
              onToggle={() => toggleStep(7)}
            >
              <div className="space-y-4">
                <CodeBlock code="nano /opt/telegram-hub/generate_session.py" />
                <CodeBlock code={`#!/usr/bin/env python3
import asyncio
from telethon import TelegramClient
from telethon.sessions import StringSession
from config import TELEGRAM_API_ID, TELEGRAM_API_HASH

async def generate_session():
    print("\\n=== Telegram Session Generator ===\\n")
    phone = input("Enter phone number (e.g., +1234567890): ")
    
    client = TelegramClient(StringSession(), TELEGRAM_API_ID, TELEGRAM_API_HASH)
    await client.connect()
    
    await client.send_code_request(phone)
    code = input("Enter the code you received: ")
    
    try:
        await client.sign_in(phone, code)
    except Exception as e:
        if "password" in str(e).lower():
            password = input("Enter your 2FA password: ")
            await client.sign_in(password=password)
    
    session_string = client.session.save()
    print("\\n" + "="*50)
    print("YOUR SESSION STRING:")
    print("="*50)
    print(session_string)
    print("="*50)
    
    await client.disconnect()

if __name__ == "__main__":
    asyncio.run(generate_session())`} />
              </div>
            </Step>

            {/* Step 8: Generate Sessions */}
            <Step
              number={8}
              title="Generate Session Strings"
              description="Create sessions for your Telegram accounts"
              completed={completedSteps.includes(8)}
              onToggle={() => toggleStep(8)}
            >
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  For each Telegram account you want to use:
                </p>
                <CodeBlock code={`cd /opt/telegram-hub
source venv/bin/activate
python generate_session.py`} />
                <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
                  <li>Enter the phone number</li>
                  <li>Enter the verification code from Telegram</li>
                  <li>Copy the session string that's printed</li>
                  <li>Add this session string to the account in your dashboard</li>
                </ol>
              </div>
            </Step>

            {/* Step 9: Run the Backend */}
            <Step
              number={9}
              title="Start the Backend"
              description="Run the Telegram Hub backend service"
              completed={completedSteps.includes(9)}
              onToggle={() => toggleStep(9)}
            >
              <div className="space-y-4">
                <p className="text-sm font-medium">Option A: Using Screen (recommended)</p>
                <CodeBlock code={`cd /opt/telegram-hub
source venv/bin/activate
screen -S telegram-hub
python main.py`} />
                <p className="text-sm text-muted-foreground">
                  To detach: <kbd className="px-2 py-1 bg-muted rounded">Ctrl+A</kbd> then <kbd className="px-2 py-1 bg-muted rounded">D</kbd><br />
                  To reattach: <code className="px-2 py-1 bg-muted rounded">screen -r telegram-hub</code>
                </p>
                
                <Separator />
                
                <p className="text-sm font-medium">Option B: Using Systemd (auto-start on reboot)</p>
                <CodeBlock code={`# Create service file
nano /etc/systemd/system/telegram-hub.service`} />
                <CodeBlock code={`[Unit]
Description=Telegram Hub Backend
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/telegram-hub
ExecStart=/opt/telegram-hub/venv/bin/python main.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target`} />
                <CodeBlock code={`# Enable and start service
systemctl daemon-reload
systemctl enable telegram-hub
systemctl start telegram-hub

# Check status
systemctl status telegram-hub`} />
              </div>
            </Step>
          </div>
        </ScrollArea>

        {/* Quick Reference */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Terminal className="w-5 h-5" />
              Quick Reference Commands
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground mb-1">Start bot:</p>
                <code className="px-2 py-1 bg-muted rounded text-xs">systemctl start telegram-hub</code>
              </div>
              <div>
                <p className="text-muted-foreground mb-1">Stop bot:</p>
                <code className="px-2 py-1 bg-muted rounded text-xs">systemctl stop telegram-hub</code>
              </div>
              <div>
                <p className="text-muted-foreground mb-1">View logs:</p>
                <code className="px-2 py-1 bg-muted rounded text-xs">journalctl -u telegram-hub -f</code>
              </div>
              <div>
                <p className="text-muted-foreground mb-1">Generate session:</p>
                <code className="px-2 py-1 bg-muted rounded text-xs">python generate_session.py</code>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
};

export default VPSGuide;
