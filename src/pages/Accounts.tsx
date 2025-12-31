import React, { useState } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatusBadge } from '@/components/ui/status-badge';
import { FileUploadZone } from '@/components/ui/file-upload-zone';
import { useTelegram } from '@/context/TelegramContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Users, Search, Upload, Server, FileArchive, AlertCircle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription } from '@/components/ui/alert';

const Accounts: React.FC = () => {
  const { accounts, proxies, uploadAccounts, uploadProgress, assignProxy, isLoading } = useTelegram();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [uploadOpen, setUploadOpen] = useState(false);

  const filteredAccounts = accounts.filter(acc => {
    const matchesSearch = acc.phoneNumber.includes(search) || 
                         acc.username?.toLowerCase().includes(search.toLowerCase()) ||
                         acc.firstName?.toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === 'all' || acc.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <DashboardLayout>
      <PageHeader 
        title="Account Management" 
        description={`Managing ${accounts.length} Telegram accounts`}
        icon={Users}
      >
        <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
          <DialogTrigger asChild>
            <Button className="gradient-primary">
              <Upload className="w-4 h-4 mr-2" />
              Bulk Upload
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Upload Telegram Accounts</DialogTitle>
            </DialogHeader>
            
            <div className="space-y-4">
              {/* Format Instructions */}
              <Alert>
                <FileArchive className="h-4 w-4" />
                <AlertDescription className="text-sm">
                  <strong>Supported formats:</strong>
                  <ul className="mt-2 space-y-1 list-disc list-inside text-muted-foreground">
                    <li><strong>ZIP file</strong> containing .session files + .json files (same name)</li>
                    <li><strong>JSON file</strong> with session_string and phone_number</li>
                    <li><strong>Single .session file</strong> (filename used as phone number)</li>
                  </ul>
                </AlertDescription>
              </Alert>

              {/* JSON Format Example */}
              <div className="p-4 rounded-lg bg-accent/30 border border-border">
                <p className="text-xs font-semibold text-muted-foreground mb-2">JSON Format Example:</p>
                <pre className="text-xs font-mono text-foreground overflow-x-auto">
{`{
  "phone_number": "+14155551234",
  "first_name": "John",
  "last_name": "Doe",
  "username": "johndoe",
  "session_string": "base64_encoded_session...",
  "api_id": "12345678",
  "api_hash": "abcdef123456..."
}`}
                </pre>
              </div>

              <FileUploadZone
                onFilesSelected={(files) => uploadAccounts(files)}
                label="Drop your files here"
                description="ZIP, JSON, or SESSION files"
                isUploading={uploadProgress.status === 'processing' || uploadProgress.status === 'uploading'}
                progress={uploadProgress}
              />

              {/* Error Display */}
              {uploadProgress.errors.length > 0 && (
                <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/30">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertCircle className="w-4 h-4 text-destructive" />
                    <span className="text-sm font-medium text-destructive">Upload Errors</span>
                  </div>
                  <ul className="text-xs text-muted-foreground space-y-1 max-h-32 overflow-y-auto">
                    {uploadProgress.errors.map((error, i) => (
                      <li key={i}>• {error}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>
      </PageHeader>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-6">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input 
            placeholder="Search accounts..." 
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex gap-2">
          {['all', 'active', 'banned', 'restricted', 'disconnected'].map(status => (
            <Button
              key={status}
              variant={statusFilter === status ? 'default' : 'outline'}
              size="sm"
              onClick={() => setStatusFilter(status)}
              className={cn(statusFilter === status && 'gradient-primary')}
            >
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </Button>
          ))}
        </div>
      </div>

      {/* Loading State */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : accounts.length === 0 ? (
        <div className="text-center py-12">
          <Users className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
          <h3 className="text-lg font-medium mb-2">No Accounts Yet</h3>
          <p className="text-muted-foreground mb-4">
            Upload your Telegram session files to get started
          </p>
          <Button onClick={() => setUploadOpen(true)} className="gradient-primary">
            <Upload className="w-4 h-4 mr-2" />
            Upload Accounts
          </Button>
        </div>
      ) : (
        <>
          {/* Accounts Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredAccounts.slice(0, 30).map(account => (
              <div 
                key={account.id}
                className={cn(
                  "p-4 rounded-xl bg-card border transition-all duration-200 hover-lift",
                  account.status === 'restricted' && "border-status-restricted/50 bg-status-restricted/5",
                  account.status === 'banned' && "border-status-banned/50 bg-status-banned/5",
                  account.status === 'active' && "border-border"
                )}
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full gradient-primary flex items-center justify-center text-primary-foreground font-semibold">
                      {account.firstName?.charAt(0) || account.phoneNumber.slice(-2)}
                    </div>
                    <div>
                      <p className="font-medium text-foreground">
                        {account.firstName || account.phoneNumber}
                      </p>
                      <p className="text-xs text-muted-foreground">{account.phoneNumber}</p>
                    </div>
                  </div>
                  <StatusBadge status={account.status} size="sm" />
                </div>

                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Messages Today</span>
                    <span className="font-medium">{account.messagesSentToday}/{account.dailyLimit}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Maturity</span>
                    <span className="font-medium">{account.maturityDays} days ({account.maturityScore}%)</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Proxy</span>
                    {account.proxyId ? (
                      <span className="flex items-center gap-1 text-status-active">
                        <Server className="w-3 h-3" /> Assigned
                      </span>
                    ) : (
                      <span className="text-status-restricted">None</span>
                    )}
                  </div>
                </div>

                {account.status === 'restricted' && (
                  <div className="mt-3 p-2 rounded-lg bg-status-restricted/10 border border-status-restricted/30">
                    <p className="text-xs text-status-restricted font-medium">
                      ⚠️ Account restricted - Auto-paused for 24 hours
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>

          {filteredAccounts.length > 30 && (
            <p className="text-center text-muted-foreground mt-6">
              Showing 30 of {filteredAccounts.length} accounts
            </p>
          )}
        </>
      )}
    </DashboardLayout>
  );
};

export default Accounts;
