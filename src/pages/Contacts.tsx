import React, { useState } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { useTelegram } from '@/context/TelegramContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Contact, Search, Plus, Phone, User, MessageSquare, Edit, Trash2, Loader2, StickyNote } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

type ContactStatus = 'new' | 'contacted' | 'replied' | 'interested' | 'not_interested' | 'converted';

interface ContactItem {
  id: string;
  name: string;
  phone: string;
  status: ContactStatus;
  notes: string;
  createdAt: Date;
}

const statusOptions: { value: ContactStatus; label: string; color: string }[] = [
  { value: 'new', label: 'New', color: 'bg-muted text-muted-foreground' },
  { value: 'contacted', label: 'Contacted', color: 'bg-blue-500/20 text-blue-600' },
  { value: 'replied', label: 'Replied', color: 'bg-green-500/20 text-green-600' },
  { value: 'interested', label: 'Interested', color: 'bg-amber-500/20 text-amber-600' },
  { value: 'not_interested', label: 'Not Interested', color: 'bg-red-500/20 text-red-600' },
  { value: 'converted', label: 'Converted', color: 'bg-primary/20 text-primary' },
];

const Contacts: React.FC = () => {
  const { isLoading } = useTelegram();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<ContactItem | null>(null);
  
  // Local contacts state (in a real app, this would be in database)
  const [contacts, setContacts] = useState<ContactItem[]>([
    { id: '1', name: 'John Doe', phone: '+14155551234', status: 'new', notes: '', createdAt: new Date() },
    { id: '2', name: 'Jane Smith', phone: '+14155559876', status: 'contacted', notes: 'Sent intro message', createdAt: new Date() },
  ]);
  
  const [newContact, setNewContact] = useState({
    name: '',
    phone: '',
    status: 'new' as ContactStatus,
    notes: ''
  });

  const filteredContacts = contacts.filter(contact => {
    const matchesSearch = contact.name.toLowerCase().includes(search.toLowerCase()) || 
                         contact.phone.includes(search);
    const matchesStatus = statusFilter === 'all' || contact.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const handleAddContact = () => {
    if (!newContact.name || !newContact.phone) {
      toast.error('Name and phone are required');
      return;
    }

    const contact: ContactItem = {
      id: Date.now().toString(),
      name: newContact.name,
      phone: newContact.phone,
      status: newContact.status,
      notes: newContact.notes,
      createdAt: new Date()
    };

    setContacts(prev => [contact, ...prev]);
    setNewContact({ name: '', phone: '', status: 'new', notes: '' });
    setIsAddOpen(false);
    toast.success('Contact added');
  };

  const handleUpdateContact = () => {
    if (!editingContact) return;

    setContacts(prev => prev.map(c => 
      c.id === editingContact.id ? editingContact : c
    ));
    setEditingContact(null);
    toast.success('Contact updated');
  };

  const handleDeleteContact = (id: string) => {
    setContacts(prev => prev.filter(c => c.id !== id));
    toast.success('Contact deleted');
  };

  const handleStatusChange = (contactId: string, newStatus: ContactStatus) => {
    setContacts(prev => prev.map(c => 
      c.id === contactId ? { ...c, status: newStatus } : c
    ));
  };

  const getStatusBadge = (status: ContactStatus) => {
    const option = statusOptions.find(o => o.value === status);
    return option ? (
      <Badge className={cn("font-medium", option.color)}>
        {option.label}
      </Badge>
    ) : null;
  };

  const statusCounts = statusOptions.reduce((acc, status) => {
    acc[status.value] = contacts.filter(c => c.status === status.value).length;
    return acc;
  }, {} as Record<ContactStatus, number>);

  return (
    <DashboardLayout>
      <PageHeader 
        title="Contacts" 
        description={`Managing ${contacts.length} contacts`}
        icon={Contact}
      >
        <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
          <DialogTrigger asChild>
            <Button className="gradient-primary">
              <Plus className="w-4 h-4 mr-2" />
              Add Contact
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add New Contact</DialogTitle>
              <DialogDescription>Add a contact to track your outreach</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 pt-4">
              <div className="space-y-2">
                <Label>Name *</Label>
                <Input
                  placeholder="Contact name"
                  value={newContact.name}
                  onChange={(e) => setNewContact(prev => ({ ...prev, name: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>Phone Number *</Label>
                <Input
                  placeholder="+1234567890"
                  value={newContact.phone}
                  onChange={(e) => setNewContact(prev => ({ ...prev, phone: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select 
                  value={newContact.status} 
                  onValueChange={(v) => setNewContact(prev => ({ ...prev, status: v as ContactStatus }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {statusOptions.map(option => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Notes</Label>
                <Textarea
                  placeholder="Add notes about this contact..."
                  value={newContact.notes}
                  onChange={(e) => setNewContact(prev => ({ ...prev, notes: e.target.value }))}
                  rows={3}
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setIsAddOpen(false)}>Cancel</Button>
                <Button onClick={handleAddContact}>Add Contact</Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </PageHeader>

      {/* Status Summary */}
      <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-6">
        {statusOptions.map(status => (
          <button
            key={status.value}
            onClick={() => setStatusFilter(statusFilter === status.value ? 'all' : status.value)}
            className={cn(
              "p-3 rounded-lg border text-center transition-all",
              statusFilter === status.value 
                ? "border-primary bg-primary/10" 
                : "border-border bg-card hover:border-primary/50"
            )}
          >
            <p className="text-2xl font-bold">{statusCounts[status.value]}</p>
            <p className="text-xs text-muted-foreground">{status.label}</p>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-6">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input 
            placeholder="Search contacts..." 
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {statusFilter !== 'all' && (
          <Button variant="outline" size="sm" onClick={() => setStatusFilter('all')}>
            Clear Filter
          </Button>
        )}
      </div>

      {/* Edit Contact Dialog */}
      <Dialog open={!!editingContact} onOpenChange={(open) => !open && setEditingContact(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Contact</DialogTitle>
            <DialogDescription>Update contact information and notes</DialogDescription>
          </DialogHeader>
          {editingContact && (
            <div className="space-y-4 pt-4">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input
                  value={editingContact.name}
                  onChange={(e) => setEditingContact({ ...editingContact, name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Phone</Label>
                <Input
                  value={editingContact.phone}
                  onChange={(e) => setEditingContact({ ...editingContact, phone: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select 
                  value={editingContact.status} 
                  onValueChange={(v) => setEditingContact({ ...editingContact, status: v as ContactStatus })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {statusOptions.map(option => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Notes</Label>
                <Textarea
                  value={editingContact.notes}
                  onChange={(e) => setEditingContact({ ...editingContact, notes: e.target.value })}
                  rows={4}
                  placeholder="Add notes about conversations, responses, follow-ups..."
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setEditingContact(null)}>Cancel</Button>
                <Button onClick={handleUpdateContact}>Save Changes</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Loading State */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : contacts.length === 0 ? (
        <div className="text-center py-12">
          <Contact className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
          <h3 className="text-lg font-medium mb-2">No Contacts Yet</h3>
          <p className="text-muted-foreground mb-4">
            Add your first contact to start tracking your outreach
          </p>
          <Button onClick={() => setIsAddOpen(true)} className="gradient-primary">
            <Plus className="w-4 h-4 mr-2" />
            Add Contact
          </Button>
        </div>
      ) : (
        <>
          {/* Contacts Table */}
          <div className="rounded-xl border border-border overflow-hidden bg-card">
            <table className="w-full">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-4 font-medium text-muted-foreground">Contact</th>
                  <th className="text-left p-4 font-medium text-muted-foreground">Phone</th>
                  <th className="text-left p-4 font-medium text-muted-foreground">Status</th>
                  <th className="text-left p-4 font-medium text-muted-foreground">Notes</th>
                  <th className="text-right p-4 font-medium text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredContacts.map(contact => (
                  <tr key={contact.id} className="border-t border-border hover:bg-muted/30 transition-colors">
                    <td className="p-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full gradient-primary flex items-center justify-center text-primary-foreground font-semibold">
                          {contact.name.charAt(0).toUpperCase()}
                        </div>
                        <span className="font-medium">{contact.name}</span>
                      </div>
                    </td>
                    <td className="p-4">
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Phone className="w-4 h-4" />
                        {contact.phone}
                      </div>
                    </td>
                    <td className="p-4">
                      <Select 
                        value={contact.status} 
                        onValueChange={(v) => handleStatusChange(contact.id, v as ContactStatus)}
                      >
                        <SelectTrigger className="w-40 h-8">
                          <SelectValue>
                            {getStatusBadge(contact.status)}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {statusOptions.map(option => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="p-4">
                      {contact.notes ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground max-w-xs truncate">
                          <StickyNote className="w-4 h-4 flex-shrink-0" />
                          <span className="truncate">{contact.notes}</span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground/50 text-sm">No notes</span>
                      )}
                    </td>
                    <td className="p-4">
                      <div className="flex items-center justify-end gap-2">
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="h-8 w-8"
                          onClick={() => setEditingContact(contact)}
                        >
                          <Edit className="w-4 h-4" />
                        </Button>
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          onClick={() => handleDeleteContact(contact.id)}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {filteredContacts.length === 0 && contacts.length > 0 && (
            <div className="text-center py-8 text-muted-foreground">
              No contacts match your search
            </div>
          )}
        </>
      )}
    </DashboardLayout>
  );
};

export default Contacts;
