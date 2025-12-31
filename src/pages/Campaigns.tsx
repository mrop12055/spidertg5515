import React, { useState, useCallback } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { useTelegram } from '@/context/TelegramContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Plus, Play, Pause, Trash2, Edit, Send, Users, CheckCircle, XCircle, Upload, FileText, Loader2 } from 'lucide-react';
import { format } from 'date-fns';
import { Campaign } from '@/types/telegram';
import { toast } from 'sonner';

const Campaigns: React.FC = () => {
  const { campaigns, accounts, createCampaign, updateCampaign, deleteCampaign, uploadRecipients, startCampaign, isLoading } = useTelegram();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [recipientText, setRecipientText] = useState('');
  const [isStarting, setIsStarting] = useState<string | null>(null);
  
  const [newCampaign, setNewCampaign] = useState({
    name: '',
    messageTemplate: '',
    recipientCount: 0,
    accountIds: [] as string[]
  });

  const handleCreateCampaign = () => {
    if (!newCampaign.name || !newCampaign.messageTemplate) return;
    
    createCampaign({
      name: newCampaign.name,
      messageTemplate: newCampaign.messageTemplate,
      recipientCount: newCampaign.recipientCount,
      accountIds: newCampaign.accountIds
    });
    
    setNewCampaign({ name: '', messageTemplate: '', recipientCount: 0, accountIds: [] });
    setIsCreateOpen(false);
  };

  const handleUploadRecipients = useCallback(async () => {
    if (!selectedCampaignId || !recipientText.trim()) {
      toast.error('Please enter recipient phone numbers');
      return;
    }

    const lines = recipientText.split('\n').filter(l => l.trim());
    const recipients = lines.map(line => {
      const parts = line.split(',').map(p => p.trim());
      return {
        phone_number: parts[0],
        name: parts[1] || undefined
      };
    }).filter(r => r.phone_number);

    if (recipients.length === 0) {
      toast.error('No valid phone numbers found');
      return;
    }

    await uploadRecipients(selectedCampaignId, recipients);
    setRecipientText('');
    setIsUploadOpen(false);
  }, [selectedCampaignId, recipientText, uploadRecipients]);

  const handleStartCampaign = async (campaignId: string) => {
    setIsStarting(campaignId);
    await startCampaign(campaignId);
    setIsStarting(null);
  };

  const getStatusColor = (status: Campaign['status']) => {
    switch (status) {
      case 'running': return 'bg-status-active text-status-active-foreground';
      case 'paused': return 'bg-status-warning text-status-warning-foreground';
      case 'completed': return 'bg-primary/20 text-primary';
      case 'draft': return 'bg-muted text-muted-foreground';
      default: return 'bg-muted text-muted-foreground';
    }
  };

  const handleStatusToggle = (campaign: Campaign) => {
    if (campaign.status === 'running') {
      updateCampaign(campaign.id, { status: 'paused' });
    } else if (campaign.status === 'paused' || campaign.status === 'draft') {
      handleStartCampaign(campaign.id);
    }
  };

  const handleAccountToggle = (accountId: string) => {
    setNewCampaign(prev => ({
      ...prev,
      accountIds: prev.accountIds.includes(accountId)
        ? prev.accountIds.filter(id => id !== accountId)
        : [...prev.accountIds, accountId]
    }));
  };

  const activeAccounts = accounts.filter(a => a.status === 'active');

  return (
    <DashboardLayout>
      <PageHeader
        title="Campaigns"
        description="Manage bulk messaging campaigns"
        action={
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2">
                <Plus className="w-4 h-4" />
                New Campaign
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>Create Campaign</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 pt-4">
                <div className="space-y-2">
                  <Label>Campaign Name</Label>
                  <Input
                    placeholder="Enter campaign name"
                    value={newCampaign.name}
                    onChange={(e) => setNewCampaign(prev => ({ ...prev, name: e.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Message Template</Label>
                  <Textarea
                    placeholder="Hi {name}! Your message here..."
                    value={newCampaign.messageTemplate}
                    onChange={(e) => setNewCampaign(prev => ({ ...prev, messageTemplate: e.target.value }))}
                    rows={4}
                  />
                  <p className="text-xs text-muted-foreground">
                    Use {'{name}'} and {'{phone}'} for personalization
                  </p>
                </div>
                
                {/* Account Selection */}
                <div className="space-y-2">
                  <Label>Select Accounts ({newCampaign.accountIds.length} selected)</Label>
                  {activeAccounts.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No active accounts available. Upload accounts first.</p>
                  ) : (
                    <div className="max-h-40 overflow-y-auto space-y-2 p-2 border rounded-lg bg-accent/30">
                      {activeAccounts.map(account => (
                        <div key={account.id} className="flex items-center gap-2">
                          <Checkbox
                            id={account.id}
                            checked={newCampaign.accountIds.includes(account.id)}
                            onCheckedChange={() => handleAccountToggle(account.id)}
                          />
                          <label htmlFor={account.id} className="text-sm cursor-pointer flex-1">
                            {account.firstName || account.phoneNumber} 
                            <span className="text-muted-foreground ml-1">({account.phoneNumber})</span>
                          </label>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex justify-end gap-2 pt-4">
                  <Button variant="outline" onClick={() => setIsCreateOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={handleCreateCampaign} disabled={!newCampaign.name || !newCampaign.messageTemplate}>
                    Create Campaign
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        }
      />

      {/* Upload Recipients Dialog */}
      <Dialog open={isUploadOpen} onOpenChange={setIsUploadOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Upload Recipients</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <div className="p-4 rounded-lg bg-accent/30 border border-border">
              <p className="text-xs font-semibold text-muted-foreground mb-2">Format (one per line):</p>
              <pre className="text-xs font-mono text-foreground">
{`+14155551234,John Doe
+14155559876,Jane Smith
+14155550000`}
              </pre>
            </div>

            <div className="space-y-2">
              <Label>Phone Numbers</Label>
              <Textarea
                placeholder="+14155551234,Name (optional)&#10;+14155559876,Another Name&#10;..."
                value={recipientText}
                onChange={(e) => setRecipientText(e.target.value)}
                rows={8}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                {recipientText.split('\n').filter(l => l.trim()).length} recipients
              </p>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsUploadOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleUploadRecipients}>
                <Upload className="w-4 h-4 mr-2" />
                Upload Recipients
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : (
        <div className="grid gap-4">
          {campaigns.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Send className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
                <h3 className="text-lg font-medium mb-2">No Campaigns Yet</h3>
                <p className="text-muted-foreground mb-4">
                  Create your first campaign to start bulk messaging
                </p>
                <Button onClick={() => setIsCreateOpen(true)}>
                  <Plus className="w-4 h-4 mr-2" />
                  Create Campaign
                </Button>
              </CardContent>
            </Card>
          ) : (
            campaigns.map((campaign) => (
              <Card key={campaign.id} className="hover:border-primary/30 transition-colors">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle className="text-lg flex items-center gap-2">
                        {campaign.name}
                        <Badge className={getStatusColor(campaign.status)}>
                          {campaign.status}
                        </Badge>
                      </CardTitle>
                      <p className="text-sm text-muted-foreground mt-1">
                        Created {format(campaign.createdAt, 'MMM d, yyyy')}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      {/* Upload Recipients Button */}
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => {
                          setSelectedCampaignId(campaign.id);
                          setIsUploadOpen(true);
                        }}
                        title="Upload Recipients"
                      >
                        <FileText className="w-4 h-4" />
                      </Button>
                      
                      {/* Start/Pause Button */}
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => handleStatusToggle(campaign)}
                        disabled={campaign.status === 'completed' || isStarting === campaign.id}
                      >
                        {isStarting === campaign.id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : campaign.status === 'running' ? (
                          <Pause className="w-4 h-4" />
                        ) : (
                          <Play className="w-4 h-4" />
                        )}
                      </Button>
                      <Button variant="outline" size="icon">
                        <Edit className="w-4 h-4" />
                      </Button>
                      <Button 
                        variant="outline" 
                        size="icon"
                        onClick={() => deleteCampaign(campaign.id)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="bg-accent/50 p-3 rounded-lg mb-4">
                    <p className="text-sm font-mono">{campaign.messageTemplate}</p>
                  </div>
                  <div className="grid grid-cols-4 gap-4">
                    <div className="flex items-center gap-2">
                      <Users className="w-4 h-4 text-muted-foreground" />
                      <div>
                        <p className="text-sm font-medium">{campaign.recipientCount}</p>
                        <p className="text-xs text-muted-foreground">Recipients</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Send className="w-4 h-4 text-primary" />
                      <div>
                        <p className="text-sm font-medium">{campaign.sentCount}</p>
                        <p className="text-xs text-muted-foreground">Sent</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <XCircle className="w-4 h-4 text-destructive" />
                      <div>
                        <p className="text-sm font-medium">{campaign.failedCount}</p>
                        <p className="text-xs text-muted-foreground">Failed</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <CheckCircle className="w-4 h-4 text-status-active" />
                      <div>
                        <p className="text-sm font-medium">{campaign.replyCount}</p>
                        <p className="text-xs text-muted-foreground">Replies</p>
                      </div>
                    </div>
                  </div>
                  
                  {/* Assigned Accounts */}
                  {campaign.accountIds.length > 0 && (
                    <div className="mt-4 pt-4 border-t border-border">
                      <p className="text-xs text-muted-foreground mb-2">
                        Assigned Accounts: {campaign.accountIds.length}
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </div>
      )}
    </DashboardLayout>
  );
};

export default Campaigns;
