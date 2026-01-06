import React, { useState, useEffect, useCallback } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { 
  Plus, Upload, Trash2, Tag, 
  Download, RefreshCw, FileText, FolderOpen, MoreVertical
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

interface ContactTag {
  id: string;
  name: string;
  created_at: string;
  unused_count: number;
  used_count: number;
  total_count: number;
}

const Data: React.FC = () => {
  const [tags, setTags] = useState<ContactTag[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreateTagOpen, setIsCreateTagOpen] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  
  // Add contacts dialog
  const [isAddContactsOpen, setIsAddContactsOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [addToTagId, setAddToTagId] = useState<string>('');
  
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const fetchTags = useCallback(async () => {
    setIsLoading(true);
    try {
      const { data: tagsData, error: tagsError } = await supabase
        .from('contact_tags')
        .select('*')
        .order('created_at', { ascending: false });

      if (tagsError) throw tagsError;

      const { data: contactsData, error: contactsError } = await supabase
        .from('contacts_data')
        .select('tag_id, is_used');

      if (contactsError) throw contactsError;

      const tagCounts: Record<string, { unused: number; used: number; total: number }> = {};
      (contactsData || []).forEach(c => {
        if (c.tag_id) {
          if (!tagCounts[c.tag_id]) {
            tagCounts[c.tag_id] = { unused: 0, used: 0, total: 0 };
          }
          tagCounts[c.tag_id].total++;
          if (c.is_used) {
            tagCounts[c.tag_id].used++;
          } else {
            tagCounts[c.tag_id].unused++;
          }
        }
      });

      const enrichedTags: ContactTag[] = (tagsData || []).map(tag => ({
        ...tag,
        unused_count: tagCounts[tag.id]?.unused || 0,
        used_count: tagCounts[tag.id]?.used || 0,
        total_count: tagCounts[tag.id]?.total || 0,
      }));

      setTags(enrichedTags);
    } catch (error) {
      console.error('Error fetching tags:', error);
      toast.error('Failed to load tags');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTags();
  }, [fetchTags]);

  const handleCreateTag = async () => {
    if (!newTagName.trim()) {
      toast.error('Tag name is required');
      return;
    }

    try {
      const { error } = await supabase
        .from('contact_tags')
        .insert({ name: newTagName.trim() });

      if (error) {
        if (error.code === '23505') {
          toast.error('Tag name already exists');
        } else {
          throw error;
        }
        return;
      }

      toast.success('Tag created');
      setNewTagName('');
      setIsCreateTagOpen(false);
      fetchTags();
    } catch (error) {
      console.error('Error creating tag:', error);
      toast.error('Failed to create tag');
    }
  };

  const handleDeleteTag = async (tagId: string) => {
    try {
      await supabase.from('contacts_data').delete().eq('tag_id', tagId);
      
      const { error } = await supabase
        .from('contact_tags')
        .delete()
        .eq('id', tagId);

      if (error) throw error;

      toast.success('Tag deleted');
      fetchTags();
    } catch (error) {
      console.error('Error deleting tag:', error);
      toast.error('Failed to delete tag');
    }
  };

  const normalizeContact = (input: string): string => {
    const trimmed = input.trim();
    
    if (trimmed.startsWith('@')) {
      return trimmed.toLowerCase();
    }
    
    const isLikelyUsername = /^[a-zA-Z][a-zA-Z0-9_]*$/.test(trimmed) && !/^\d+$/.test(trimmed);
    if (isLikelyUsername) {
      return '@' + trimmed.toLowerCase();
    }
    
    let normalized = trimmed.replace(/[^\d+]/g, '');
    if (normalized && !normalized.startsWith('+')) {
      normalized = '+' + normalized;
    }
    
    return normalized;
  };

  const handleAddContacts = async () => {
    if (!addToTagId) {
      toast.error('Please select a tag');
      return;
    }

    const lines = bulkText.split('\n').filter(l => l.trim());
    if (lines.length === 0) {
      toast.error('Please enter at least one contact');
      return;
    }

    const contacts = lines.map(line => {
      const parts = line.split(/[,\t]/).map(p => p.trim());
      return {
        phone_number: normalizeContact(parts[0]),
        name: parts[1] || null,
        tag_id: addToTagId
      };
    }).filter(c => c.phone_number && c.phone_number.length >= 2);

    if (contacts.length === 0) {
      toast.error('No valid contacts found');
      return;
    }

    try {
      const { error } = await supabase
        .from('contacts_data')
        .upsert(contacts, { onConflict: 'phone_number' });

      if (error) throw error;

      toast.success(`Added ${contacts.length} contacts`);
      setBulkText('');
      setIsAddContactsOpen(false);
      fetchTags();
    } catch (error) {
      console.error('Error adding contacts:', error);
      toast.error('Failed to add contacts');
    }
  };

  const handleFileImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!addToTagId) {
      toast.error('Please select a tag first');
      return;
    }

    try {
      const text = await file.text();
      const lines = text.split('\n').filter(l => l.trim());
      
      if (lines.length === 0) {
        toast.error('File is empty');
        return;
      }

      const contacts = lines.map(line => {
        const parts = line.split(/[,\t]/).map(p => p.trim());
        return {
          phone_number: normalizeContact(parts[0]),
          name: parts[1] || null,
          tag_id: addToTagId
        };
      }).filter(c => c.phone_number && c.phone_number.length >= 2);

      if (contacts.length === 0) {
        toast.error('No valid contacts found in file');
        return;
      }

      const { error } = await supabase
        .from('contacts_data')
        .upsert(contacts, { onConflict: 'phone_number' });

      if (error) throw error;

      toast.success(`Added ${contacts.length} contacts from file`);
      setIsAddContactsOpen(false);
      fetchTags();
    } catch (error) {
      console.error('Error importing file:', error);
      toast.error('Failed to import contacts');
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const exportContacts = async (tagId: string, tagName: string, filter: 'all' | 'unused' | 'used') => {
    try {
      let query = supabase
        .from('contacts_data')
        .select('phone_number, name, username, is_used')
        .eq('tag_id', tagId);
      
      if (filter === 'unused') {
        query = query.eq('is_used', false);
      } else if (filter === 'used') {
        query = query.eq('is_used', true);
      }

      const { data, error } = await query;
      if (error) throw error;

      if (!data || data.length === 0) {
        toast.warning('No contacts to export');
        return;
      }

      const csv = [
        'Phone Number,Name,Username,Used',
        ...data.map(c => 
          `${c.phone_number},${c.name || ''},${c.username || ''},${c.is_used}`
        )
      ].join('\n');

      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${tagName}_${filter}_${format(new Date(), 'yyyy-MM-dd')}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      
      toast.success(`Exported ${data.length} ${filter} contacts`);
    } catch (error) {
      console.error('Error exporting contacts:', error);
      toast.error('Failed to export contacts');
    }
  };

  return (
    <DashboardLayout>
      <PageHeader 
        title="Data Management" 
        description="Organize contacts into tags for campaigns"
        icon={Tag}
      />

      <div className="space-y-6">
        {/* Tags List */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Tag className="w-5 h-5" />
                  Contact Tags
                </CardTitle>
                <CardDescription>Create tags to organize your contacts</CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => fetchTags()} disabled={isLoading}>
                  <RefreshCw className={cn("w-4 h-4 mr-2", isLoading && "animate-spin")} />
                  Refresh
                </Button>
                
                <Dialog open={isAddContactsOpen} onOpenChange={setIsAddContactsOpen}>
                  <DialogTrigger asChild>
                    <Button variant="outline" size="sm">
                      <Upload className="w-4 h-4 mr-2" />
                      Add Contacts
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="max-w-lg">
                    <DialogHeader>
                      <DialogTitle>Add Contacts to Tag</DialogTitle>
                      <DialogDescription>
                        Add phone numbers or usernames to a tag
                      </DialogDescription>
                    </DialogHeader>
                    
                    <div className="space-y-4">
                      <div>
                        <Label>Select Tag *</Label>
                        <Select value={addToTagId} onValueChange={setAddToTagId}>
                          <SelectTrigger>
                            <SelectValue placeholder="Choose a tag" />
                          </SelectTrigger>
                          <SelectContent>
                            {tags.map(tag => (
                              <SelectItem key={tag.id} value={tag.id}>
                                {tag.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      
                      <div className="flex gap-2">
                        <input
                          type="file"
                          ref={fileInputRef}
                          accept=".txt,.csv"
                          onChange={handleFileImport}
                          className="hidden"
                        />
                        <Button 
                          variant="outline" 
                          size="sm" 
                          onClick={() => fileInputRef.current?.click()}
                          disabled={!addToTagId}
                        >
                          <FileText className="w-4 h-4 mr-2" />
                          Import File
                        </Button>
                      </div>

                      <div className="p-3 rounded-lg bg-accent/30 border border-border text-xs text-muted-foreground">
                        <p className="font-semibold mb-1">Format examples:</p>
                        <pre className="font-mono">
{`12303802803
93282083028
ahmadraza9392`}
                        </pre>
                      </div>
                      
                      <Textarea
                        placeholder={`12303802803\n93282083028\nahmadraza9392`}
                        value={bulkText}
                        onChange={(e) => setBulkText(e.target.value)}
                        className="min-h-[150px] font-mono text-sm"
                      />
                    </div>
                    
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setIsAddContactsOpen(false)}>Cancel</Button>
                      <Button onClick={handleAddContacts} disabled={!addToTagId || !bulkText.trim()}>
                        <Plus className="w-4 h-4 mr-2" />
                        Add Contacts
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>

                <Dialog open={isCreateTagOpen} onOpenChange={setIsCreateTagOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm">
                      <Plus className="w-4 h-4 mr-2" />
                      Create Tag
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Create New Tag</DialogTitle>
                      <DialogDescription>
                        Create a tag to organize your contacts
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                      <div>
                        <Label>Tag Name *</Label>
                        <Input
                          placeholder="e.g., Campaign 1, Hot Leads, etc."
                          value={newTagName}
                          onChange={(e) => setNewTagName(e.target.value)}
                        />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setIsCreateTagOpen(false)}>Cancel</Button>
                      <Button onClick={handleCreateTag}>Create Tag</Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="text-center py-12">
                <RefreshCw className="w-8 h-8 mx-auto mb-3 animate-spin text-muted-foreground" />
                <p className="text-muted-foreground">Loading tags...</p>
              </div>
            ) : tags.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Tag className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p className="mb-2">No tags created yet</p>
                <p className="text-sm">Create a tag to start organizing your contacts</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {tags.map(tag => (
                  <Card key={tag.id} className="border-border/50">
                    <CardContent className="pt-4">
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <FolderOpen className="w-5 h-5 text-primary" />
                          <h3 className="font-semibold">{tag.name}</h3>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreVertical className="w-4 h-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => exportContacts(tag.id, tag.name, 'all')}>
                              <Download className="w-4 h-4 mr-2" />
                              Export All
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => exportContacts(tag.id, tag.name, 'unused')}>
                              <Download className="w-4 h-4 mr-2" />
                              Export Unused
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => exportContacts(tag.id, tag.name, 'used')}>
                              <Download className="w-4 h-4 mr-2" />
                              Export Used
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem 
                              className="text-destructive"
                              onClick={() => handleDeleteTag(tag.id)}
                            >
                              <Trash2 className="w-4 h-4 mr-2" />
                              Delete Tag
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      
                      <div className="grid grid-cols-3 gap-2 text-sm">
                        <div className="text-center p-2 rounded-md bg-muted/50">
                          <p className="text-xs text-muted-foreground mb-0.5">Total</p>
                          <p className="font-bold">{tag.total_count}</p>
                        </div>
                        <div className="text-center p-2 rounded-md bg-primary/10">
                          <p className="text-xs text-muted-foreground mb-0.5">Unused</p>
                          <p className="font-bold text-primary">{tag.unused_count}</p>
                        </div>
                        <div className="text-center p-2 rounded-md bg-muted/50">
                          <p className="text-xs text-muted-foreground mb-0.5">Used</p>
                          <p className="font-bold">{tag.used_count}</p>
                        </div>
                      </div>
                      
                      <p className="text-xs text-muted-foreground mt-3">
                        Created {format(new Date(tag.created_at), 'MMM d, yyyy')}
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
};

export default Data;
