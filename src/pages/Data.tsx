import React, { useState, useEffect, useCallback } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { 
  Plus, Upload, Trash2, Database, Tag, 
  CheckCircle, Download, RefreshCw, ArrowLeft,
  UserCheck, UserX, FileText, FolderOpen, MoreVertical, Loader2, AlertCircle
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useTelegram } from '@/context/TelegramContext';

interface ContactTag {
  id: string;
  name: string;
  created_at: string;
  unused_count: number;
  used_count: number;
  total_count: number;
}

interface ContactData {
  id: string;
  phone_number: string;
  name: string | null;
  username: string | null;
  is_used: boolean;
  tag_id: string | null;
  created_at: string;
}

interface ImportTask {
  id: string;
  status: string;
  phone_numbers: string[];
  valid_numbers: string[];
  invalid_numbers: string[];
  result: string | null;
  created_at: string;
  completed_at: string | null;
}

const Data: React.FC = () => {
  const { accounts } = useTelegram();
  const [tags, setTags] = useState<ContactTag[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreateTagOpen, setIsCreateTagOpen] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  
  // View mode: 'tags' or 'contacts'
  const [viewMode, setViewMode] = useState<'tags' | 'contacts'>('tags');
  const [selectedTag, setSelectedTag] = useState<ContactTag | null>(null);
  const [tagContacts, setTagContacts] = useState<ContactData[]>([]);
  const [isLoadingContacts, setIsLoadingContacts] = useState(false);
  
  // Add contacts dialog
  const [isAddContactsOpen, setIsAddContactsOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [addToTagId, setAddToTagId] = useState<string>('');
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  
  // Import task tracking
  const [currentImportTask, setCurrentImportTask] = useState<ImportTask | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ valid: number; invalid: number } | null>(null);
  
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  
  const activeAccounts = accounts.filter(a => a.status === 'active');

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

  // Poll for import task completion
  useEffect(() => {
    if (!currentImportTask || currentImportTask.status === 'completed' || currentImportTask.status === 'failed') {
      return;
    }

    const interval = setInterval(async () => {
      const { data, error } = await supabase
        .from('contact_import_tasks')
        .select('*')
        .eq('id', currentImportTask.id)
        .maybeSingle();

      if (error) {
        console.error('Error polling import task:', error);
        return;
      }

      if (data) {
        setCurrentImportTask(data as ImportTask);
        
        if (data.status === 'completed') {
          const validCount = (data.valid_numbers || []).length;
          const invalidCount = (data.invalid_numbers || []).length;
          setImportResult({ valid: validCount, invalid: invalidCount });
          setIsImporting(false);
          
          if (validCount > 0) {
            toast.success(`Added ${validCount} valid contacts. ${invalidCount} invalid skipped.`);
          } else {
            toast.warning(`No valid contacts found. ${invalidCount} numbers were invalid.`);
          }
          
          fetchTags();
          if (selectedTag) {
            fetchTagContacts(selectedTag.id);
          }
        } else if (data.status === 'failed') {
          setIsImporting(false);
          toast.error(`Import failed: ${data.result || 'Unknown error'}`);
        }
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [currentImportTask, selectedTag, fetchTags]);

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

  // Normalize input - auto-add + for phones, @ for usernames
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
    
    if (!selectedAccountId) {
      toast.error('Please select a Telegram account for validation');
      return;
    }

    const lines = bulkText.split('\n').filter(l => l.trim());
    if (lines.length === 0) {
      toast.error('Please enter at least one contact');
      return;
    }

    const phoneNumbers = lines.map(line => {
      const parts = line.split(/[,\t]/).map(p => p.trim());
      return normalizeContact(parts[0]);
    }).filter(p => p && p.length >= 2);

    if (phoneNumbers.length === 0) {
      toast.error('No valid phone numbers found');
      return;
    }

    try {
      setIsImporting(true);
      setImportResult(null);
      
      // Create import task for Python runner to validate via Telegram
      const { data: task, error } = await supabase
        .from('contact_import_tasks')
        .insert({
          account_id: selectedAccountId,
          tag_id: addToTagId,
          phone_numbers: phoneNumbers,
          status: 'pending'
        })
        .select()
        .single();

      if (error) throw error;

      setCurrentImportTask(task as ImportTask);
      setBulkText('');
      
      toast.info(`Validating ${phoneNumbers.length} contacts via Telegram...`);
    } catch (error) {
      console.error('Error creating import task:', error);
      toast.error('Failed to start import');
      setIsImporting(false);
    }
  };

  const handleFileImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!addToTagId) {
      toast.error('Please select a tag first');
      return;
    }
    
    if (!selectedAccountId) {
      toast.error('Please select a Telegram account for validation');
      return;
    }

    try {
      const text = await file.text();
      const lines = text.split('\n').filter(l => l.trim());
      
      if (lines.length === 0) {
        toast.error('File is empty');
        return;
      }

      const phoneNumbers = lines.map(line => {
        const parts = line.split(/[,\t]/).map(p => p.trim());
        return normalizeContact(parts[0]);
      }).filter(p => p && p.length >= 2);

      if (phoneNumbers.length === 0) {
        toast.error('No valid contacts found in file');
        return;
      }

      setIsImporting(true);
      setImportResult(null);
      
      // Create import task for Python runner
      const { data: task, error } = await supabase
        .from('contact_import_tasks')
        .insert({
          account_id: selectedAccountId,
          tag_id: addToTagId,
          phone_numbers: phoneNumbers,
          status: 'pending'
        })
        .select()
        .single();

      if (error) throw error;

      setCurrentImportTask(task as ImportTask);
      toast.info(`Validating ${phoneNumbers.length} contacts via Telegram...`);
    } catch (error) {
      console.error('Error importing file:', error);
      toast.error('Failed to start import');
      setIsImporting(false);
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const fetchTagContacts = async (tagId: string) => {
    setIsLoadingContacts(true);
    try {
      const { data, error } = await supabase
        .from('contacts_data')
        .select('id, phone_number, name, username, is_used, tag_id, created_at')
        .eq('tag_id', tagId)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setTagContacts(data || []);
    } catch (error) {
      console.error('Error fetching contacts:', error);
      toast.error('Failed to load contacts');
    } finally {
      setIsLoadingContacts(false);
    }
  };

  const openTagView = (tag: ContactTag) => {
    setSelectedTag(tag);
    setViewMode('contacts');
    fetchTagContacts(tag.id);
  };

  const backToTags = () => {
    setViewMode('tags');
    setSelectedTag(null);
    setTagContacts([]);
    fetchTags();
  };

  const exportTagContacts = () => {
    if (!selectedTag || tagContacts.length === 0) return;

    const csv = [
      'Phone Number,Name,Username,Used',
      ...tagContacts.map(c => 
        `${c.phone_number},${c.name || ''},${c.username || ''},${c.is_used}`
      )
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedTag.name}_${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const totalStats = tags.reduce((acc, tag) => ({
    total: acc.total + tag.total_count,
    unused: acc.unused + tag.unused_count,
    used: acc.used + tag.used_count,
  }), { total: 0, unused: 0, used: 0 });

  return (
    <DashboardLayout>
      <PageHeader 
        title="Data Management" 
        description="Organize contacts into tags for campaigns"
      />

      <div className="space-y-6">
        {/* Stats Cards */}
        <div className="grid grid-cols-3 gap-4">
          <Card className="bg-muted/30 border-border/50">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 mb-1">
                <Database className="w-4 h-4 text-muted-foreground" />
                <span className="text-xs text-muted-foreground uppercase tracking-wide">Total Contacts</span>
              </div>
              <p className="text-2xl font-bold">{totalStats.total}</p>
            </CardContent>
          </Card>

          <Card className="bg-primary/5 border-primary/20">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 mb-1">
                <UserCheck className="w-4 h-4 text-primary" />
                <span className="text-xs text-muted-foreground uppercase tracking-wide">Unused</span>
              </div>
              <p className="text-2xl font-bold text-primary">{totalStats.unused}</p>
            </CardContent>
          </Card>

          <Card className="bg-muted/30 border-border/50">
            <CardContent className="pt-4 pb-3">
              <div className="flex items-center gap-2 mb-1">
                <UserX className="w-4 h-4 text-muted-foreground" />
                <span className="text-xs text-muted-foreground uppercase tracking-wide">Used</span>
              </div>
              <p className="text-2xl font-bold">{totalStats.used}</p>
            </CardContent>
          </Card>
        </div>

        {/* Main Content */}
        {viewMode === 'tags' ? (
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
                  
                  <Dialog open={isAddContactsOpen} onOpenChange={(open) => {
                    setIsAddContactsOpen(open);
                    if (!open) {
                      setImportResult(null);
                      setCurrentImportTask(null);
                    }
                  }}>
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
                          Contacts will be validated via Telegram before adding. Only valid Telegram users will be saved.
                        </DialogDescription>
                      </DialogHeader>
                      
                      {isImporting ? (
                        <div className="py-8 text-center">
                          <Loader2 className="w-12 h-12 mx-auto mb-4 animate-spin text-primary" />
                          <p className="font-medium mb-2">Validating contacts via Telegram...</p>
                          <p className="text-sm text-muted-foreground">
                            Checking {currentImportTask?.phone_numbers.length || 0} numbers
                          </p>
                          <p className="text-xs text-muted-foreground mt-2">
                            This may take a few moments. Make sure your Python runner is active.
                          </p>
                        </div>
                      ) : importResult ? (
                        <div className="py-6">
                          <div className="flex items-center justify-center gap-8 mb-4">
                            <div className="text-center">
                              <div className="flex items-center justify-center w-16 h-16 rounded-full bg-green-500/20 mb-2 mx-auto">
                                <CheckCircle className="w-8 h-8 text-green-500" />
                              </div>
                              <p className="text-2xl font-bold text-green-500">{importResult.valid}</p>
                              <p className="text-sm text-muted-foreground">Valid & Added</p>
                            </div>
                            <div className="text-center">
                              <div className="flex items-center justify-center w-16 h-16 rounded-full bg-destructive/20 mb-2 mx-auto">
                                <AlertCircle className="w-8 h-8 text-destructive" />
                              </div>
                              <p className="text-2xl font-bold text-destructive">{importResult.invalid}</p>
                              <p className="text-sm text-muted-foreground">Invalid & Skipped</p>
                            </div>
                          </div>
                          <Button 
                            className="w-full" 
                            onClick={() => { setImportResult(null); setCurrentImportTask(null); }}
                          >
                            Import More Contacts
                          </Button>
                        </div>
                      ) : (
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
                          
                          <div>
                            <Label>Telegram Account for Validation *</Label>
                            <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
                              <SelectTrigger>
                                <SelectValue placeholder="Choose an account" />
                              </SelectTrigger>
                              <SelectContent>
                                {activeAccounts.length === 0 ? (
                                  <SelectItem value="none" disabled>No active accounts</SelectItem>
                                ) : (
                                  activeAccounts.map(acc => (
                                    <SelectItem key={acc.id} value={acc.id}>
                                      {acc.firstName || acc.phoneNumber}
                                    </SelectItem>
                                  ))
                                )}
                              </SelectContent>
                            </Select>
                            <p className="text-xs text-muted-foreground mt-1">
                              This account will check if numbers are valid Telegram users
                            </p>
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
                              disabled={!addToTagId || !selectedAccountId}
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
                      )}
                      
                      {!isImporting && !importResult && (
                        <DialogFooter>
                          <Button variant="outline" onClick={() => setIsAddContactsOpen(false)}>Cancel</Button>
                          <Button onClick={handleAddContacts} disabled={!addToTagId || !selectedAccountId || !bulkText.trim()}>
                            <Plus className="w-4 h-4 mr-2" />
                            Validate & Add
                          </Button>
                        </DialogFooter>
                      )}
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
                    <Card 
                      key={tag.id} 
                      className="cursor-pointer hover:border-primary/50 transition-colors"
                      onClick={() => openTagView(tag)}
                    >
                      <CardContent className="pt-4">
                        <div className="flex items-start justify-between mb-3">
                          <div className="flex items-center gap-2">
                            <FolderOpen className="w-5 h-5 text-primary" />
                            <h3 className="font-semibold">{tag.name}</h3>
                          </div>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                              <Button variant="ghost" size="icon" className="h-8 w-8">
                                <MoreVertical className="w-4 h-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem 
                                className="text-destructive"
                                onClick={(e) => { e.stopPropagation(); handleDeleteTag(tag.id); }}
                              >
                                <Trash2 className="w-4 h-4 mr-2" />
                                Delete Tag
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                        
                        <div className="flex items-center gap-4 text-sm">
                          <div className="flex items-center gap-1">
                            <span className="text-muted-foreground">Total:</span>
                            <Badge variant="secondary">{tag.total_count}</Badge>
                          </div>
                          <div className="flex items-center gap-1">
                            <span className="text-muted-foreground">Left:</span>
                            <Badge variant="secondary" className="bg-primary/20 text-primary">{tag.unused_count}</Badge>
                          </div>
                          <div className="flex items-center gap-1">
                            <span className="text-muted-foreground">Used:</span>
                            <Badge variant="secondary">{tag.used_count}</Badge>
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
        ) : (
          // Contacts view for selected tag
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Button variant="ghost" size="icon" onClick={backToTags}>
                    <ArrowLeft className="w-5 h-5" />
                  </Button>
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <FolderOpen className="w-5 h-5 text-primary" />
                      {selectedTag?.name}
                    </CardTitle>
                    <CardDescription>
                      {selectedTag?.total_count} contacts • {selectedTag?.unused_count} unused • {selectedTag?.used_count} used
                    </CardDescription>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={exportTagContacts} disabled={tagContacts.length === 0}>
                    <Download className="w-4 h-4 mr-2" />
                    Export
                  </Button>
                  <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={() => { setAddToTagId(selectedTag?.id || ''); setIsAddContactsOpen(true); }}
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    Add More
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {isLoadingContacts ? (
                <div className="text-center py-12">
                  <RefreshCw className="w-8 h-8 mx-auto mb-3 animate-spin text-muted-foreground" />
                  <p className="text-muted-foreground">Loading contacts...</p>
                </div>
              ) : tagContacts.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <Database className="w-12 h-12 mx-auto mb-3 opacity-50" />
                  <p>No contacts in this tag</p>
                </div>
              ) : (
                <ScrollArea className="h-[400px]">
                  <div className="space-y-2">
                    {tagContacts.map(contact => (
                      <div
                        key={contact.id}
                        className={cn(
                          "flex items-center gap-3 p-3 rounded-lg border transition-colors",
                          contact.is_used ? "bg-muted/30" : "bg-card"
                        )}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium font-mono text-sm">{contact.phone_number}</span>
                            {contact.is_used ? (
                              <Badge variant="secondary" className="text-xs">Used</Badge>
                            ) : (
                              <Badge variant="secondary" className="text-xs bg-primary/20 text-primary">Available</Badge>
                            )}
                          </div>
                          {contact.name && (
                            <p className="text-sm text-muted-foreground mt-0.5">{contact.name}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
};

export default Data;
