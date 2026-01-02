import React, { useState, useEffect, useCallback } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { 
  Plus, Upload, Trash2, Search, Database, Users, Phone, 
  CheckCircle, XCircle, Ban, Download, RefreshCw, Filter,
  UserCheck, UserX
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { format } from 'date-fns';

interface ContactData {
  id: string;
  phone_number: string;
  name: string | null;
  username: string | null;
  notes: string | null;
  is_used: boolean;
  used_in_campaign_id: string | null;
  used_at: string | null;
  is_blocked: boolean;
  blocked_at: string | null;
  created_at: string;
}

interface BlockedContact {
  id: string;
  phone_number: string;
  name: string | null;
  blocked_by_account_id: string | null;
  reason: string | null;
  created_at: string;
}

const Data: React.FC = () => {
  const [contacts, setContacts] = useState<ContactData[]>([]);
  const [blockedContacts, setBlockedContacts] = useState<BlockedContact[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isBulkAddOpen, setIsBulkAddOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [selectedContacts, setSelectedContacts] = useState<Set<string>>(new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [activeTab, setActiveTab] = useState('all');

  const [newContact, setNewContact] = useState({
    phone_number: '',
    name: '',
    username: '',
    notes: ''
  });

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
      const { data: contactsData, error: contactsError } = await supabase
        .from('contacts_data')
        .select('*')
        .order('created_at', { ascending: false });

      if (contactsError) throw contactsError;
      setContacts(contactsData || []);

      const { data: blockedData, error: blockedError } = await supabase
        .from('blocked_contacts')
        .select('*')
        .order('created_at', { ascending: false });

      if (blockedError) throw blockedError;
      setBlockedContacts(blockedData || []);
    } catch (error) {
      console.error('Error fetching data:', error);
      toast.error('Failed to load data');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleAddContact = async () => {
    if (!newContact.phone_number.trim()) {
      toast.error('Phone number is required');
      return;
    }

    try {
      const { error } = await supabase
        .from('contacts_data')
        .insert({
          phone_number: newContact.phone_number.trim(),
          name: newContact.name.trim() || null,
          username: newContact.username.trim() || null,
          notes: newContact.notes.trim() || null
        });

      if (error) {
        if (error.code === '23505') {
          toast.error('This phone number already exists');
        } else {
          throw error;
        }
        return;
      }

      toast.success('Contact added');
      setNewContact({ phone_number: '', name: '', username: '', notes: '' });
      setIsAddDialogOpen(false);
      fetchData();
    } catch (error) {
      console.error('Error adding contact:', error);
      toast.error('Failed to add contact');
    }
  };

  const handleBulkAdd = async () => {
    const lines = bulkText.split('\n').filter(l => l.trim());
    if (lines.length === 0) {
      toast.error('Please enter at least one contact');
      return;
    }

    const contacts = lines.map(line => {
      const parts = line.split(/[,\t]/).map(p => p.trim());
      return {
        phone_number: parts[0],
        name: parts[1] || null,
        username: parts[2] || null,
        notes: null
      };
    }).filter(c => c.phone_number);

    try {
      const { error } = await supabase
        .from('contacts_data')
        .upsert(contacts, { onConflict: 'phone_number', ignoreDuplicates: true });

      if (error) throw error;

      toast.success(`Added ${contacts.length} contacts`);
      setBulkText('');
      setIsBulkAddOpen(false);
      fetchData();
    } catch (error) {
      console.error('Error bulk adding:', error);
      toast.error('Failed to add contacts');
    }
  };

  const handleDeleteContacts = async (ids: string[]) => {
    try {
      const { error } = await supabase
        .from('contacts_data')
        .delete()
        .in('id', ids);

      if (error) throw error;

      toast.success(`Deleted ${ids.length} contact(s)`);
      setSelectedContacts(new Set());
      setIsSelectionMode(false);
      fetchData();
    } catch (error) {
      console.error('Error deleting:', error);
      toast.error('Failed to delete contacts');
    }
  };

  const handleMarkAsUsed = async (ids: string[], campaignId?: string) => {
    try {
      const { error } = await supabase
        .from('contacts_data')
        .update({
          is_used: true,
          used_at: new Date().toISOString(),
          used_in_campaign_id: campaignId || null
        })
        .in('id', ids);

      if (error) throw error;

      toast.success(`Marked ${ids.length} as used`);
      fetchData();
    } catch (error) {
      console.error('Error marking as used:', error);
      toast.error('Failed to update');
    }
  };

  const handleMarkAsUnused = async (ids: string[]) => {
    try {
      const { error } = await supabase
        .from('contacts_data')
        .update({
          is_used: false,
          used_at: null,
          used_in_campaign_id: null
        })
        .in('id', ids);

      if (error) throw error;

      toast.success(`Marked ${ids.length} as unused`);
      fetchData();
    } catch (error) {
      console.error('Error marking as unused:', error);
      toast.error('Failed to update');
    }
  };

  const handleUnblock = async (id: string) => {
    try {
      const { error } = await supabase
        .from('blocked_contacts')
        .delete()
        .eq('id', id);

      if (error) throw error;

      toast.success('Contact unblocked');
      fetchData();
    } catch (error) {
      console.error('Error unblocking:', error);
      toast.error('Failed to unblock');
    }
  };

  const exportContacts = (type: 'all' | 'unused' | 'used') => {
    let data = contacts;
    if (type === 'unused') data = contacts.filter(c => !c.is_used);
    if (type === 'used') data = contacts.filter(c => c.is_used);

    const csv = [
      'Phone Number,Name,Username,Notes,Used,Used At',
      ...data.map(c => 
        `${c.phone_number},${c.name || ''},${c.username || ''},${c.notes || ''},${c.is_used},${c.used_at || ''}`
      )
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `contacts_${type}_${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const filteredContacts = contacts.filter(c => {
    const matchesSearch = 
      c.phone_number.includes(searchQuery) ||
      c.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.username?.toLowerCase().includes(searchQuery.toLowerCase());
    
    if (activeTab === 'unused') return matchesSearch && !c.is_used;
    if (activeTab === 'used') return matchesSearch && c.is_used;
    return matchesSearch;
  });

  const stats = {
    total: contacts.length,
    unused: contacts.filter(c => !c.is_used).length,
    used: contacts.filter(c => c.is_used).length,
    blocked: blockedContacts.length
  };

  return (
    <DashboardLayout>
      <PageHeader 
        title="Data Management" 
        description="Store and manage phone numbers and usernames for campaigns"
      />

      <div className="space-y-6">
        {/* Stats Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="bg-muted/30 border-border/50">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 mb-1">
                <Database className="w-4 h-4 text-muted-foreground" />
                <span className="text-xs text-muted-foreground uppercase tracking-wide">Total</span>
              </div>
              <p className="text-2xl font-bold">{stats.total}</p>
            </CardContent>
          </Card>

          <Card className="bg-primary/5 border-primary/20">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 mb-1">
                <UserCheck className="w-4 h-4 text-primary" />
                <span className="text-xs text-muted-foreground uppercase tracking-wide">Unused</span>
              </div>
              <p className="text-2xl font-bold text-primary">{stats.unused}</p>
            </CardContent>
          </Card>

          <Card className="bg-muted/30 border-border/50">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 mb-1">
                <UserX className="w-4 h-4 text-muted-foreground" />
                <span className="text-xs text-muted-foreground uppercase tracking-wide">Used</span>
              </div>
              <p className="text-2xl font-bold">{stats.used}</p>
            </CardContent>
          </Card>

          <Card className="bg-destructive/5 border-destructive/20">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 mb-1">
                <Ban className="w-4 h-4 text-destructive" />
                <span className="text-xs text-muted-foreground uppercase tracking-wide">Blocked</span>
              </div>
              <p className="text-2xl font-bold text-destructive">{stats.blocked}</p>
            </CardContent>
          </Card>
        </div>

        {/* Main Content */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Users className="w-5 h-5" />
                  Contacts Data
                </CardTitle>
                <CardDescription>Manage your contact list for campaigns</CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => fetchData()} disabled={isLoading}>
                  <RefreshCw className={cn("w-4 h-4 mr-2", isLoading && "animate-spin")} />
                  Refresh
                </Button>
                <Dialog open={isBulkAddOpen} onOpenChange={setIsBulkAddOpen}>
                  <DialogTrigger asChild>
                    <Button variant="outline" size="sm">
                      <Upload className="w-4 h-4 mr-2" />
                      Bulk Add
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Bulk Add Contacts</DialogTitle>
                      <DialogDescription>
                        Paste contacts (one per line). Format: phone,name,username
                      </DialogDescription>
                    </DialogHeader>
                    <Textarea
                      placeholder="+1234567890,John Doe,@johndoe
+0987654321,Jane Smith"
                      value={bulkText}
                      onChange={(e) => setBulkText(e.target.value)}
                      className="min-h-[200px] font-mono text-sm"
                    />
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setIsBulkAddOpen(false)}>Cancel</Button>
                      <Button onClick={handleBulkAdd}>
                        <Plus className="w-4 h-4 mr-2" />
                        Add All
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
                <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm">
                      <Plus className="w-4 h-4 mr-2" />
                      Add Contact
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Add New Contact</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4">
                      <div>
                        <Label>Phone Number *</Label>
                        <Input
                          placeholder="+1234567890"
                          value={newContact.phone_number}
                          onChange={(e) => setNewContact({ ...newContact, phone_number: e.target.value })}
                        />
                      </div>
                      <div>
                        <Label>Name</Label>
                        <Input
                          placeholder="John Doe"
                          value={newContact.name}
                          onChange={(e) => setNewContact({ ...newContact, name: e.target.value })}
                        />
                      </div>
                      <div>
                        <Label>Username</Label>
                        <Input
                          placeholder="@username"
                          value={newContact.username}
                          onChange={(e) => setNewContact({ ...newContact, username: e.target.value })}
                        />
                      </div>
                      <div>
                        <Label>Notes</Label>
                        <Textarea
                          placeholder="Optional notes..."
                          value={newContact.notes}
                          onChange={(e) => setNewContact({ ...newContact, notes: e.target.value })}
                        />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setIsAddDialogOpen(false)}>Cancel</Button>
                      <Button onClick={handleAddContact}>Add Contact</Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <div className="flex items-center justify-between mb-4">
                <TabsList>
                  <TabsTrigger value="all" className="gap-2">
                    All <Badge variant="secondary" className="ml-1">{stats.total}</Badge>
                  </TabsTrigger>
                  <TabsTrigger value="unused" className="gap-2">
                    Unused <Badge variant="secondary" className="ml-1 bg-primary/20 text-primary">{stats.unused}</Badge>
                  </TabsTrigger>
                  <TabsTrigger value="used" className="gap-2">
                    Used <Badge variant="secondary" className="ml-1">{stats.used}</Badge>
                  </TabsTrigger>
                  <TabsTrigger value="blocked" className="gap-2">
                    Blocked <Badge variant="secondary" className="ml-1 bg-destructive/20 text-destructive">{stats.blocked}</Badge>
                  </TabsTrigger>
                </TabsList>

                <div className="flex items-center gap-2">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      placeholder="Search..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-10 w-[200px]"
                    />
                  </div>
                  <Button variant="outline" size="sm" onClick={() => exportContacts(activeTab as 'all' | 'unused' | 'used')}>
                    <Download className="w-4 h-4 mr-2" />
                    Export
                  </Button>
                </div>
              </div>

              <TabsContent value="all" className="mt-0">
                <ContactsList 
                  contacts={filteredContacts}
                  selectedContacts={selectedContacts}
                  setSelectedContacts={setSelectedContacts}
                  isSelectionMode={isSelectionMode}
                  setIsSelectionMode={setIsSelectionMode}
                  onDelete={handleDeleteContacts}
                  onMarkAsUsed={handleMarkAsUsed}
                  onMarkAsUnused={handleMarkAsUnused}
                />
              </TabsContent>

              <TabsContent value="unused" className="mt-0">
                <ContactsList 
                  contacts={filteredContacts}
                  selectedContacts={selectedContacts}
                  setSelectedContacts={setSelectedContacts}
                  isSelectionMode={isSelectionMode}
                  setIsSelectionMode={setIsSelectionMode}
                  onDelete={handleDeleteContacts}
                  onMarkAsUsed={handleMarkAsUsed}
                  onMarkAsUnused={handleMarkAsUnused}
                />
              </TabsContent>

              <TabsContent value="used" className="mt-0">
                <ContactsList 
                  contacts={filteredContacts}
                  selectedContacts={selectedContacts}
                  setSelectedContacts={setSelectedContacts}
                  isSelectionMode={isSelectionMode}
                  setIsSelectionMode={setIsSelectionMode}
                  onDelete={handleDeleteContacts}
                  onMarkAsUsed={handleMarkAsUsed}
                  onMarkAsUnused={handleMarkAsUnused}
                />
              </TabsContent>

              <TabsContent value="blocked" className="mt-0">
                <BlockedList 
                  contacts={blockedContacts}
                  onUnblock={handleUnblock}
                  searchQuery={searchQuery}
                />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
};

// Contacts List Component
interface ContactsListProps {
  contacts: ContactData[];
  selectedContacts: Set<string>;
  setSelectedContacts: React.Dispatch<React.SetStateAction<Set<string>>>;
  isSelectionMode: boolean;
  setIsSelectionMode: React.Dispatch<React.SetStateAction<boolean>>;
  onDelete: (ids: string[]) => void;
  onMarkAsUsed: (ids: string[]) => void;
  onMarkAsUnused: (ids: string[]) => void;
}

const ContactsList: React.FC<ContactsListProps> = ({
  contacts,
  selectedContacts,
  setSelectedContacts,
  isSelectionMode,
  setIsSelectionMode,
  onDelete,
  onMarkAsUsed,
  onMarkAsUnused
}) => {
  const toggleSelection = (id: string) => {
    setSelectedContacts(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (contacts.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Database className="w-12 h-12 mx-auto mb-3 opacity-50" />
        <p>No contacts found</p>
      </div>
    );
  }

  return (
    <div>
      {isSelectionMode && selectedContacts.size > 0 && (
        <div className="flex items-center gap-2 mb-4 p-3 bg-muted/50 rounded-lg">
          <span className="text-sm font-medium">{selectedContacts.size} selected</span>
          <div className="flex-1" />
          <Button variant="outline" size="sm" onClick={() => onMarkAsUnused(Array.from(selectedContacts))}>
            Mark Unused
          </Button>
          <Button variant="outline" size="sm" onClick={() => onMarkAsUsed(Array.from(selectedContacts))}>
            Mark Used
          </Button>
          <Button variant="destructive" size="sm" onClick={() => onDelete(Array.from(selectedContacts))}>
            <Trash2 className="w-4 h-4 mr-1" />
            Delete
          </Button>
          <Button variant="ghost" size="sm" onClick={() => { setSelectedContacts(new Set()); setIsSelectionMode(false); }}>
            Cancel
          </Button>
        </div>
      )}

      <ScrollArea className="h-[500px]">
        <div className="space-y-2">
          {contacts.map(contact => (
            <div
              key={contact.id}
              className={cn(
                "flex items-center gap-3 p-3 rounded-lg border transition-colors",
                contact.is_used ? "bg-muted/30" : "bg-card hover:bg-muted/30",
                selectedContacts.has(contact.id) && "bg-primary/10 border-primary/30"
              )}
              onClick={() => isSelectionMode && toggleSelection(contact.id)}
            >
              {isSelectionMode && (
                <Checkbox
                  checked={selectedContacts.has(contact.id)}
                  onCheckedChange={() => toggleSelection(contact.id)}
                />
              )}
              
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Phone className="w-4 h-4 text-muted-foreground" />
                  <span className="font-medium">{contact.phone_number}</span>
                  {contact.is_used ? (
                    <Badge variant="secondary" className="text-xs">Used</Badge>
                  ) : (
                    <Badge variant="secondary" className="text-xs bg-primary/20 text-primary">Available</Badge>
                  )}
                </div>
                {(contact.name || contact.username) && (
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {contact.name}{contact.name && contact.username && ' • '}{contact.username}
                  </p>
                )}
              </div>

              {!isSelectionMode && (
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={(e) => { e.stopPropagation(); setIsSelectionMode(true); toggleSelection(contact.id); }}
                  >
                    <Checkbox checked={false} />
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
};

// Blocked List Component
interface BlockedListProps {
  contacts: BlockedContact[];
  onUnblock: (id: string) => void;
  searchQuery: string;
}

const BlockedList: React.FC<BlockedListProps> = ({ contacts, onUnblock, searchQuery }) => {
  const filtered = contacts.filter(c =>
    c.phone_number.includes(searchQuery) ||
    c.name?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (filtered.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Ban className="w-12 h-12 mx-auto mb-3 opacity-50" />
        <p>No blocked contacts</p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-[500px]">
      <div className="space-y-2">
        {filtered.map(contact => (
          <div
            key={contact.id}
            className="flex items-center gap-3 p-3 rounded-lg border bg-destructive/5 border-destructive/20"
          >
            <Ban className="w-5 h-5 text-destructive" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium">{contact.phone_number}</span>
                {contact.name && <span className="text-sm text-muted-foreground">({contact.name})</span>}
              </div>
              {contact.reason && (
                <p className="text-sm text-muted-foreground mt-0.5">{contact.reason}</p>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                Blocked on {format(new Date(contact.created_at), 'MMM d, yyyy HH:mm')}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => onUnblock(contact.id)}>
              Unblock
            </Button>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
};

export default Data;
