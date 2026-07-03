import React from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Download, Terminal, Package, PlayCircle, Copy, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';

const CodeBlock: React.FC<{ code: string; label?: string }> = ({ code, label }) => {
  const [copied, setCopied] = React.useState(false);
  const onCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    toast.success('Copied');
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="relative group">
      {label && <div className="text-xs text-muted-foreground mb-1 font-mono">{label}</div>}
      <pre className="bg-[#0b0f19] text-slate-100 border rounded-md p-3 text-xs font-mono overflow-x-auto">
        {code}
      </pre>
      <Button
        size="sm"
        variant="ghost"
        className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity h-7 px-2"
        onClick={onCopy}
      >
        {copied ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
      </Button>
    </div>
  );
};

const Step: React.FC<{ n: number; title: string; icon: React.ReactNode; children: React.ReactNode }> = ({
  n, title, icon, children,
}) => (
  <Card>
    <CardHeader>
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold">
          {n}
        </div>
        <div className="flex items-center gap-2">
          {icon}
          <CardTitle className="text-lg">{title}</CardTitle>
        </div>
      </div>
    </CardHeader>
    <CardContent className="space-y-3">{children}</CardContent>
  </Card>
);

const SetupGuide: React.FC = () => {
  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-4xl">
        <PageHeader
          title="Runner Setup Guide"
          description="Download the Python runner and run it separately on your machine or VPS."
        />

        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="p-5 flex items-center justify-between gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Download className="w-5 h-5 text-primary" />
                <h3 className="font-semibold">Unified Runner Package</h3>
                <Badge variant="secondary">v1</Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                This is the Python worker that logs into your Telegram accounts and processes
                campaigns, replies, and account tasks. Includes{' '}
                <code className="text-xs">unified_runner.py</code>,{' '}
                <code className="text-xs">tasks.py</code>, and{' '}
                <code className="text-xs">requirements.txt</code>.
              </p>
            </div>
            <a href="/unified-runner.zip" download>
              <Button size="lg" className="gap-2">
                <Download className="w-4 h-4" />
                Download ZIP
              </Button>
            </a>
          </CardContent>
        </Card>

        <Step n={1} title="Install Python 3.10 or newer" icon={<Package className="w-4 h-4" />}>
          <p className="text-sm text-muted-foreground">
            Windows users: install from{' '}
            <a href="https://www.python.org/downloads/" target="_blank" rel="noreferrer" className="text-primary underline">
              python.org
            </a>{' '}
            and enable <b>"Add python.exe to PATH"</b> during setup. Verify with:
          </p>
          <CodeBlock code={`python --version`} />
        </Step>

        <Step n={2} title="Extract the ZIP" icon={<Package className="w-4 h-4" />}>
          <p className="text-sm text-muted-foreground">
            Unzip <code>unified-runner.zip</code> to a folder you can easily reach, for example:
          </p>
          <CodeBlock code={`C:\\telegram-runner\\`} />
        </Step>

        <Step n={3} title="Install dependencies" icon={<Terminal className="w-4 h-4" />}>
          <p className="text-sm text-muted-foreground">
            Open a terminal (Command Prompt / PowerShell / Terminal) in the extracted folder and run:
          </p>
          <CodeBlock code={`pip install -r requirements.txt`} />
        </Step>

        <Step n={4} title="Point the runner at your app data" icon={<Terminal className="w-4 h-4" />}>
          <p className="text-sm text-muted-foreground">
            The runner reads the same local database the desktop app writes to. Tell it where that
            folder is. On a normal install:
          </p>
          <CodeBlock
            label="Windows"
            code={`%APPDATA%\\TelegramCRM`}
          />
          <CodeBlock
            label="macOS"
            code={`~/Library/Application Support/TelegramCRM`}
          />
          <CodeBlock
            label="Linux"
            code={`~/.config/TelegramCRM`}
          />
          <p className="text-sm text-muted-foreground">
            That folder contains <code>data.db</code>, a <code>sessions/</code> folder, and a{' '}
            <code>files/</code> folder. Set these three environment variables to point at them.
          </p>
        </Step>

        <Step n={5} title="Run the runner" icon={<PlayCircle className="w-4 h-4" />}>
          <p className="text-sm text-muted-foreground">
            Open a terminal in the extracted folder and run the commands below. Keep the window
            open — the runner needs to stay running to process Telegram tasks.
          </p>
          <CodeBlock
            label="Windows (PowerShell)"
            code={`$env:TCRM_DB_PATH = "$env:APPDATA\\TelegramCRM\\data.db"
$env:TCRM_SESSIONS_DIR = "$env:APPDATA\\TelegramCRM\\sessions"
$env:TCRM_FILES_DIR = "$env:APPDATA\\TelegramCRM\\files"
python unified_runner.py`}
          />
          <CodeBlock
            label="macOS / Linux"
            code={`export TCRM_DB_PATH="$HOME/Library/Application Support/TelegramCRM/data.db"
export TCRM_SESSIONS_DIR="$HOME/Library/Application Support/TelegramCRM/sessions"
export TCRM_FILES_DIR="$HOME/Library/Application Support/TelegramCRM/files"
python3 unified_runner.py`}
          />
          <p className="text-xs text-muted-foreground">
            To stop it, press <kbd className="px-1.5 py-0.5 rounded border bg-muted">Ctrl</kbd> +{' '}
            <kbd className="px-1.5 py-0.5 rounded border bg-muted">C</kbd>. On Linux, swap the paths
            above for <code>~/.config/TelegramCRM/…</code>.
          </p>
        </Step>


        <Card>
          <CardHeader>
            <CardTitle className="text-base">Troubleshooting</CardTitle>
            <CardDescription>Common issues and how to fix them.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <b>"python is not recognized"</b> — Python is not on your PATH. Reinstall Python and tick
              "Add python.exe to PATH", or use the full path to <code>python.exe</code>.
            </div>
            <div>
              <b>"ModuleNotFoundError: telethon"</b> — dependency install did not run. Re-run{' '}
              <code>pip install -r requirements.txt</code> from inside the runner folder.
            </div>
            <div>
              <b>Runner shows offline in the dashboard</b> — make sure it is running and can reach the
              internet. Restart it after changing your network or proxy.
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
};

export default SetupGuide;
