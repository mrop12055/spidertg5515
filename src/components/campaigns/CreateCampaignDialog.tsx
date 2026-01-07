import React, { useState, useMemo, useCallback, memo } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { CountdownTimer } from '@/components/ui/countdown-timer';
import { 
  Plus, Trash2, Users, Database, AlertCircle, 
  MessageSquare, UserCheck, Send
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { TelegramAccount } from '@/types/telegram';

interface Seat {
  id: string;
  name: string;
  is_active: boolean;
}

interface BulkMessageTemplate {
  id: string;
  message: string;
  accountCount: number;
}

interface CreateCampaignDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seats: Seat[];
  accounts: TelegramAccount[];
  dataStats: { total: number; unused: number };
  accountUniqueRecipients: Map<string, number>;
  onOpenDataSelect: () => void;
  onCreateCampaign: (data: {
    name: string;
    recipientsText: string;
    batchSize: number;
    accountIds: string[];
    messageTemplates: BulkMessageTemplate[];
    selectedSeatIds: string[];
  }) => Promise<void>;
}

// Memoized account item to prevent re-renders
const AccountItem = memo(({ 
  account, 
  isSelected, 
  onToggle, 
  uniqueRecipientsToday,
  daysSinceCreation
}: { 
  account: TelegramAccount; 
  isSelected: boolean; 
  onToggle: () => void;
  uniqueRecipientsToday: number;
  daysSinceCreation: number;
}) => (
  <div 
    className={cn(
      "flex items-center gap-3 p-2.5 rounded-lg cursor-pointer transition-all",
      isSelected 
        ? "bg-primary/10 border border-primary/30" 
        : "hover:bg-accent border border-transparent"
    )}
    onClick={onToggle}
  >
    <Checkbox checked={isSelected} onCheckedChange={onToggle} />
    <div className="flex-1 min-w-0">
      <p className="text-sm font-medium truncate">
        {account.firstName || account.phoneNumber}
      </p>
      <p className="text-xs text-muted-foreground truncate">
        {account.phoneNumber} • {uniqueRecipientsToday}/{account.dailyLimit} today • {daysSinceCreation}d
        {account.tags && account.tags.length > 0 && (
          <span className="text-primary/70"> • {account.tags.join(', ')}</span>
        )}
      </p>
    </div>
  </div>
));
AccountItem.displayName = 'AccountItem';

// Memoized seat item
const SeatItem = memo(({ 
  seat, 
  isSelected, 
  onToggle 
}: { 
  seat: Seat; 
  isSelected: boolean; 
  onToggle: () => void;
}) => (
  <div 
    className={cn(
      "flex items-center gap-3 p-2.5 rounded-lg cursor-pointer transition-all",
      isSelected 
        ? "bg-primary/10 border border-primary/30" 
        : "hover:bg-accent border border-transparent"
    )}
    onClick={onToggle}
  >
    <Checkbox checked={isSelected} onCheckedChange={onToggle} />
    <span className="text-sm font-medium">{seat.name}</span>
  </div>
));
SeatItem.displayName = 'SeatItem';

export const CreateCampaignDialog: React.FC<CreateCampaignDialogProps> = memo(({
  open,
  onOpenChange,
  seats,
  accounts,
  dataStats,
  accountUniqueRecipients,
  onOpenDataSelect,
  onCreateCampaign
}) => {
  const [name, setName] = useState('');
  const [recipientsText, setRecipientsText] = useState('');
  const [batchSize] = useState(50);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [selectedSeatIds, setSelectedSeatIds] = useState<string[]>([]);
  const [selectedAccountTagFilter, setSelectedAccountTagFilter] = useState<string>('all');
  const [messageTemplates, setMessageTemplates] = useState<BulkMessageTemplate[]>([
    { id: '1', message: '', accountCount: 10 }
  ]);
  const [isCreating, setIsCreating] = useState(false);

  const now = useMemo(() => new Date(), []);

  // Filter eligible accounts (active, not restricted, not spambot limited)
  const eligibleAccounts = useMemo(() => {
    return accounts.filter(a => {
      if (a.status !== 'active') return false;
      if (a.restrictedUntil && new Date(a.restrictedUntil) > now) return false;
      if (a.spambotStatus === 'limited' || a.spambotStatus === 'restricted') return false;
      return true;
    });
  }, [accounts, now]);

  // Restricted accounts
  const restrictedAccounts = useMemo(() => {
    return accounts.filter(a => {
      const isTemporarilyRestricted = a.restrictedUntil && new Date(a.restrictedUntil) > now;
      const isSpambotLimited = a.spambotStatus === 'limited' || a.spambotStatus === 'restricted';
      return (
        (a.status === 'active' && isTemporarilyRestricted) ||
        (a.status === 'active' && isSpambotLimited) ||
        a.status === 'restricted' ||
        a.status === 'cooldown'
      );
    });
  }, [accounts, now]);

  // Get unique tags from eligible accounts
  const accountTags = useMemo(() => {
    const tags = new Set<string>();
    eligibleAccounts.forEach(acc => {
      acc.tags?.forEach(tag => tags.add(tag));
    });
    return Array.from(tags).sort();
  }, [eligibleAccounts]);

  // Filter accounts by selected tag
  const filteredAccounts = useMemo(() => {
    if (selectedAccountTagFilter === 'all') return eligibleAccounts;
    return eligibleAccounts.filter(a => a.tags?.includes(selectedAccountTagFilter));
  }, [eligibleAccounts, selectedAccountTagFilter]);

  // Recipient count
  const recipientCount = useMemo(() => {
    return recipientsText.split('\n').filter(l => l.trim()).length;
  }, [recipientsText]);

  // Distribution preview for multiple seats
  const distributionPreview = useMemo(() => {
    if (selectedSeatIds.length <= 1 || recipientCount === 0) return null;
    
    const perSeat = Math.ceil(recipientCount / selectedSeatIds.length);
    const distribution: { seatName: string; count: number }[] = [];
    let remaining = recipientCount;
    
    selectedSeatIds.forEach((seatId, index) => {
      const seatName = seats.find(s => s.id === seatId)?.name || `Seat ${index + 1}`;
      const count = Math.min(perSeat, remaining);
      if (count > 0) {
        distribution.push({ seatName, count });
        remaining -= count;
      }
    });
    
    return distribution;
  }, [selectedSeatIds, recipientCount, seats]);

  const handleAccountToggle = useCallback((accountId: string) => {
    setSelectedAccountIds(prev => 
      prev.includes(accountId) 
        ? prev.filter(id => id !== accountId)
        : [...prev, accountId]
    );
  }, []);

  const handleSeatToggle = useCallback((seatId: string) => {
    setSelectedSeatIds(prev => 
      prev.includes(seatId) 
        ? prev.filter(id => id !== seatId)
        : [...prev, seatId]
    );
  }, []);

  const handleSelectAllAccounts = useCallback((checked: boolean) => {
    if (checked) {
      const filteredIds = filteredAccounts.map(a => a.id);
      setSelectedAccountIds(prev => [...new Set([...prev, ...filteredIds])]);
    } else {
      const filteredIds = new Set(filteredAccounts.map(a => a.id));
      setSelectedAccountIds(prev => prev.filter(id => !filteredIds.has(id)));
    }
  }, [filteredAccounts]);

  const addMessageTemplate = useCallback(() => {
    if (messageTemplates.length >= 10) return;
    setMessageTemplates(prev => [
      ...prev,
      { id: String(Date.now()), message: '', accountCount: 10 }
    ]);
  }, [messageTemplates.length]);

  const removeMessageTemplate = useCallback((id: string) => {
    if (messageTemplates.length <= 1) return;
    setMessageTemplates(prev => prev.filter(t => t.id !== id));
  }, [messageTemplates.length]);

  const updateMessageTemplate = useCallback((id: string, field: 'message' | 'accountCount', value: string | number) => {
    setMessageTemplates(prev => prev.map(t => 
      t.id === id ? { ...t, [field]: value } : t
    ));
  }, []);

  const handleCreate = useCallback(async () => {
    setIsCreating(true);
    try {
      await onCreateCampaign({
        name,
        recipientsText,
        batchSize,
        accountIds: selectedAccountIds,
        messageTemplates,
        selectedSeatIds
      });
      // Reset form
      setName('');
      setRecipientsText('');
      setSelectedAccountIds([]);
      setSelectedSeatIds([]);
      setMessageTemplates([{ id: '1', message: '', accountCount: 10 }]);
      onOpenChange(false);
    } finally {
      setIsCreating(false);
    }
  }, [name, recipientsText, batchSize, selectedAccountIds, messageTemplates, selectedSeatIds, onCreateCampaign, onOpenChange]);

  const isValid = name.trim() && recipientsText.trim() && messageTemplates.some(t => t.message.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-4 border-b bg-gradient-to-r from-primary/5 to-transparent">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/15 flex items-center justify-center">
              <Send className="w-5 h-5 text-primary" />
            </div>
            <div>
              <DialogTitle className="text-xl">Create Campaign</DialogTitle>
              <DialogDescription className="text-sm">
                Set up recipients, messages, and accounts for bulk messaging
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        
        <Tabs defaultValue="recipients" className="flex-1 flex flex-col overflow-hidden">
          <TabsList className="grid w-full grid-cols-3 mx-6 mt-4 max-w-[calc(100%-3rem)]">
            <TabsTrigger value="recipients" className="gap-2">
              <Users className="w-4 h-4" />
              <span className="hidden sm:inline">Recipients</span>
            </TabsTrigger>
            <TabsTrigger value="messages" className="gap-2">
              <MessageSquare className="w-4 h-4" />
              <span className="hidden sm:inline">Messages</span>
            </TabsTrigger>
            <TabsTrigger value="accounts" className="gap-2">
              <UserCheck className="w-4 h-4" />
              <span className="hidden sm:inline">Accounts</span>
            </TabsTrigger>
          </TabsList>

          <ScrollArea className="flex-1 px-6">
            {/* STEP 1: Recipients */}
            <TabsContent value="recipients" className="space-y-4 mt-4 pb-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Campaign Name</Label>
                  <Input
                    placeholder="Enter campaign name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="h-10"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-sm font-medium">
                    Assign to Seats {selectedSeatIds.length > 0 && (
                      <Badge variant="secondary" className="ml-2">{selectedSeatIds.length}</Badge>
                    )}
                  </Label>
                  <div className="border rounded-lg p-2 max-h-32 overflow-y-auto bg-card">
                    <div 
                      className={cn(
                        "flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-all",
                        selectedSeatIds.length === 0 
                          ? "bg-primary/10 border border-primary/30" 
                          : "hover:bg-accent border border-transparent"
                      )}
                      onClick={() => setSelectedSeatIds([])}
                    >
                      <Checkbox checked={selectedSeatIds.length === 0} onCheckedChange={() => setSelectedSeatIds([])} />
                      <span className="text-sm">No seat (admin only)</span>
                    </div>
                    {seats.map(seat => (
                      <SeatItem
                        key={seat.id}
                        seat={seat}
                        isSelected={selectedSeatIds.includes(seat.id)}
                        onToggle={() => handleSeatToggle(seat.id)}
                      />
                    ))}
                  </div>
                </div>
              </div>

              <Card className="p-4 bg-muted/50">
                <p className="text-xs font-semibold text-muted-foreground mb-2">Format (one per line):</p>
                <pre className="text-xs font-mono text-foreground bg-background/50 p-2 rounded">
{`+14155551234,John Doe
@telegram_user,Jane Smith
username123`}
                </pre>
              </Card>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">Recipients</Label>
                  <Button variant="outline" size="sm" onClick={onOpenDataSelect} className="h-8">
                    <Database className="w-4 h-4 mr-2" />
                    From Data
                  </Button>
                </div>
                <Textarea
                  placeholder={`+14155551234,John Doe\n@telegram_user\nusername123`}
                  value={recipientsText}
                  onChange={(e) => setRecipientsText(e.target.value)}
                  rows={6}
                  className="font-mono text-sm resize-none"
                />
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">
                    {recipientCount} recipient{recipientCount !== 1 ? 's' : ''}
                  </span>
                  {dataStats.unused > 0 && (
                    <span className="text-primary">{dataStats.unused} unused in Data</span>
                  )}
                </div>
              </div>

              {/* Distribution Preview */}
              {distributionPreview && (
                <Card className="p-4 bg-primary/5 border-primary/20">
                  <div className="flex items-center gap-2 mb-3">
                    <Users className="w-4 h-4 text-primary" />
                    <span className="text-sm font-medium text-primary">Distribution Preview</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {distributionPreview.map((d, idx) => (
                      <div key={idx} className="flex items-center gap-1">
                        <Badge variant="secondary" className="bg-primary/20 text-primary font-bold">
                          {d.count}
                        </Badge>
                        <span className="text-xs text-muted-foreground">{d.seatName}</span>
                        {idx < distributionPreview.length - 1 && (
                          <span className="text-muted-foreground mx-1">+</span>
                        )}
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    Recipients randomly distributed. Each appears in one campaign only.
                  </p>
                </Card>
              )}
            </TabsContent>
            
            {/* STEP 2: Messages */}
            <TabsContent value="messages" className="space-y-4 mt-4 pb-4">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">Message Templates</Label>
                <Button variant="outline" size="sm" onClick={addMessageTemplate} disabled={messageTemplates.length >= 10} className="h-8">
                  <Plus className="w-4 h-4 mr-1" />
                  Add
                </Button>
              </div>
              
              <div className="space-y-3">
                {messageTemplates.map((template, index) => (
                  <Card key={template.id} className="p-4">
                    <div className="flex items-start gap-3">
                      <Badge variant="outline" className="mt-1 shrink-0">#{index + 1}</Badge>
                      <div className="flex-1 space-y-3">
                        <Textarea
                          placeholder={`Message template... Use {name} and {phone} for personalization`}
                          value={template.message}
                          onChange={(e) => updateMessageTemplate(template.id, 'message', e.target.value)}
                          rows={3}
                          className="resize-none"
                        />
                        <div className="flex items-center gap-3">
                          <Label className="text-xs text-muted-foreground">Accounts:</Label>
                          <Input
                            type="number"
                            min={1}
                            max={100}
                            value={template.accountCount}
                            onChange={(e) => updateMessageTemplate(template.id, 'accountCount', parseInt(e.target.value) || 10)}
                            className="w-20 h-8"
                          />
                        </div>
                      </div>
                      {messageTemplates.length > 1 && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => removeMessageTemplate(template.id)}
                          className="shrink-0 text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
              
              <p className="text-xs text-muted-foreground">
                Use {'{name}'} and {'{phone}'} for personalization.
              </p>
            </TabsContent>
            
            {/* STEP 3: Accounts */}
            <TabsContent value="accounts" className="space-y-4 mt-4 pb-4">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">
                  Select Accounts 
                  {selectedAccountIds.length > 0 && (
                    <Badge variant="secondary" className="ml-2">{selectedAccountIds.length}</Badge>
                  )}
                </Label>
              </div>
              
              {/* Tag Filter */}
              {accountTags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  <Badge
                    variant={selectedAccountTagFilter === 'all' ? 'default' : 'outline'}
                    className="cursor-pointer"
                    onClick={() => setSelectedAccountTagFilter('all')}
                  >
                    All ({eligibleAccounts.length})
                  </Badge>
                  {accountTags.map(tag => {
                    const count = eligibleAccounts.filter(a => a.tags?.includes(tag)).length;
                    return (
                      <Badge
                        key={tag}
                        variant={selectedAccountTagFilter === tag ? 'default' : 'outline'}
                        className="cursor-pointer"
                        onClick={() => setSelectedAccountTagFilter(tag)}
                      >
                        {tag} ({count})
                      </Badge>
                    );
                  })}
                </div>
              )}
              
              {eligibleAccounts.length === 0 ? (
                <Card className="p-8 text-center">
                  <p className="text-muted-foreground">No active accounts available</p>
                  <p className="text-sm text-muted-foreground mt-1">Add accounts in the Accounts page first.</p>
                </Card>
              ) : (
                <Card className="p-3">
                  <div className="flex items-center gap-2 pb-2 border-b mb-2">
                    <Checkbox
                      checked={filteredAccounts.length > 0 && filteredAccounts.every(a => selectedAccountIds.includes(a.id))}
                      onCheckedChange={(checked) => handleSelectAllAccounts(!!checked)}
                    />
                    <span className="text-sm font-medium">
                      Select All {selectedAccountTagFilter !== 'all' ? `"${selectedAccountTagFilter}"` : ''} ({filteredAccounts.length})
                    </span>
                  </div>
                  <div className="max-h-48 overflow-y-auto space-y-1">
                    {filteredAccounts.map(account => {
                      const daysSinceCreation = Math.floor((now.getTime() - new Date(account.createdAt).getTime()) / (1000 * 60 * 60 * 24));
                      const uniqueRecipientsToday = accountUniqueRecipients.get(account.id) || 0;
                      return (
                        <AccountItem
                          key={account.id}
                          account={account}
                          isSelected={selectedAccountIds.includes(account.id)}
                          onToggle={() => handleAccountToggle(account.id)}
                          uniqueRecipientsToday={uniqueRecipientsToday}
                          daysSinceCreation={daysSinceCreation}
                        />
                      );
                    })}
                  </div>
                </Card>
              )}

              {/* Restricted accounts warning */}
              {restrictedAccounts.length > 0 && (
                <Card className="p-4 bg-yellow-500/10 border-yellow-500/30">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 text-yellow-600 mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-yellow-600">
                        {restrictedAccounts.length} Account(s) Restricted
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Cannot be used for new campaigns.
                      </p>
                      <div className="mt-2 space-y-1 max-h-24 overflow-y-auto">
                        {restrictedAccounts.slice(0, 5).map((acc) => (
                          <div key={acc.id} className="flex items-center justify-between text-xs text-yellow-600">
                            <span>• {acc.firstName || acc.phoneNumber}</span>
                            {acc.restrictedUntil && new Date(acc.restrictedUntil) > now && (
                              <CountdownTimer targetDate={new Date(acc.restrictedUntil)} className="text-yellow-600" />
                            )}
                          </div>
                        ))}
                        {restrictedAccounts.length > 5 && (
                          <p className="text-xs text-yellow-600">+{restrictedAccounts.length - 5} more</p>
                        )}
                      </div>
                    </div>
                  </div>
                </Card>
              )}
            </TabsContent>
          </ScrollArea>
        </Tabs>

        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t bg-muted/30">
          <div className="text-xs text-muted-foreground">
            {recipientCount} recipients • {selectedAccountIds.length} accounts • {selectedSeatIds.length || 'No'} seat{selectedSeatIds.length !== 1 ? 's' : ''}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={!isValid || isCreating}>
              {isCreating ? 'Creating...' : 'Create Campaign'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
});

CreateCampaignDialog.displayName = 'CreateCampaignDialog';
