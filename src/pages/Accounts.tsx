import React, { useState } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatusBadge } from '@/components/ui/status-badge';
import { FileUploadZone } from '@/components/ui/file-upload-zone';
import { useTelegram } from '@/context/TelegramContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Users, Plus, Search, Upload, MoreVertical, Server } from 'lucide-react';
import { cn } from '@/lib/utils';

const Accounts: React.FC = () => {
  const { accounts, proxies, uploadAccounts, uploadProgress, assignProxy } = useTelegram();
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
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Upload Accounts</DialogTitle>
            </DialogHeader>
            <FileUploadZone
              onFilesSelected={(files) => uploadAccounts(files)}
              label="Drop your ZIP file here"
              description="Contains session files and JSON configs"
              isUploading={uploadProgress.status === 'processing' || uploadProgress.status === 'uploading'}
              progress={uploadProgress}
            />
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
    </DashboardLayout>
  );
};

export default Accounts;
