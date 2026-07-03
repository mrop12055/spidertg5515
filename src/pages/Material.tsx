import React, { useState, useEffect, useCallback } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { 
  Plus, Upload, Trash2, Tag, Package, FileText, Image, User,
  RefreshCw, MoreVertical, Phone, AtSign, Download
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { localClient as supabase } from '@/lib/localClient';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface MaterialTag {
  id: string;
  name: string;
  type: 'data' | 'pictures' | 'names';
  item_count: number;
  created_at: string;
}

interface MaterialData {
  id: string;
  tag_id: string;
  phone_number: string | null;
  username: string | null;
  created_at: string;
}

interface MaterialPicture {
  id: string;
  tag_id: string;
  file_url: string;
  file_name: string;
  created_at: string;
}

interface MaterialName {
  id: string;
  tag_id: string;
  first_name: string;
  last_name: string | null;
  created_at: string;
}

const Material: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'data' | 'pictures' | 'names'>('data');
  const [tags, setTags] = useState<MaterialTag[]>([]);
  const [dataItems, setDataItems] = useState<MaterialData[]>([]);
  const [pictures, setPictures] = useState<MaterialPicture[]>([]);
  const [names, setNames] = useState<MaterialName[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  
  // Dialog states
  const [isCreateTagOpen, setIsCreateTagOpen] = useState(false);
  const [isAddDataOpen, setIsAddDataOpen] = useState(false);
  const [isImportDataOpen, setIsImportDataOpen] = useState(false);
  const [isUploadPicturesOpen, setIsUploadPicturesOpen] = useState(false);
  const [isAddNameOpen, setIsAddNameOpen] = useState(false);
  const [isImportNamesOpen, setIsImportNamesOpen] = useState(false);
  
  // Bulk delete confirmation states
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState<{
    open: boolean;
    type: 'data' | 'pictures' | 'names' | 'tag';
    tagId: string;
    tagName: string;
    count: number;
  } | null>(null);
  
  // Form states
  const [newTagName, setNewTagName] = useState('');
  const [selectedTagId, setSelectedTagId] = useState<string>('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [username, setUsername] = useState('');
  const [importText, setImportText] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [uploadingFiles, setUploadingFiles] = useState(false);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
      // Limit queries to prevent slow loading with large datasets
      const LIMIT = 10000; // Increased to support large material libraries
      const [tagsRes, dataRes, picturesRes, namesRes] = await Promise.all([
        supabase.from('material_tags').select('*').order('created_at', { ascending: false }).limit(1000),
        supabase.from('material_data').select('*').order('created_at', { ascending: false }).limit(LIMIT),
        supabase.from('material_pictures').select('*').order('created_at', { ascending: false }).limit(LIMIT),
        supabase.from('material_names').select('*').order('created_at', { ascending: false }).limit(LIMIT),
      ]);

      if (tagsRes.data) setTags(tagsRes.data as MaterialTag[]);
      if (dataRes.data) setDataItems(dataRes.data);
      if (picturesRes.data) setPictures(picturesRes.data);
      if (namesRes.data) setNames(namesRes.data);
    } catch (error) {
      console.error('Error fetching data:', error);
      toast.error('Failed to load materials');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const filteredTags = tags.filter(tag => tag.type === activeTab);

  // Create Tag
  const handleCreateTag = async () => {
    if (!newTagName.trim()) {
      toast.error('Please enter a tag name');
      return;
    }

    try {
      const { error } = await supabase.from('material_tags').insert({
        name: newTagName.trim(),
        type: activeTab,
      });

      if (error) throw error;
      toast.success('Tag created successfully');
      setNewTagName('');
      setIsCreateTagOpen(false);
      fetchData();
    } catch (error) {
      console.error('Error creating tag:', error);
      toast.error('Failed to create tag');
    }
  };

  // Delete Tag
  const handleDeleteTag = async (tagId: string) => {
    try {
      // Delete associated pictures from storage first
      const tagPictures = pictures.filter(p => p.tag_id === tagId);
      for (const pic of tagPictures) {
        const fileName = pic.file_url.split('/').pop();
        if (fileName) {
          await supabase.storage.from('material-pictures').remove([fileName]);
        }
      }

      const { error } = await supabase.from('material_tags').delete().eq('id', tagId);
      if (error) throw error;
      toast.success('Tag deleted successfully');
      fetchData();
    } catch (error) {
      console.error('Error deleting tag:', error);
      toast.error('Failed to delete tag');
    }
  };

  // Add Data (phone/username)
  const handleAddData = async () => {
    if (!selectedTagId) {
      toast.error('Please select a tag');
      return;
    }
    if (!phoneNumber.trim() && !username.trim()) {
      toast.error('Please enter phone number or username');
      return;
    }

    try {
      const { error } = await supabase.from('material_data').insert({
        tag_id: selectedTagId,
        phone_number: phoneNumber.trim() || null,
        username: username.trim() || null,
      });

      if (error) throw error;
      toast.success('Data added successfully');
      setPhoneNumber('');
      setUsername('');
      setIsAddDataOpen(false);
      fetchData();
    } catch (error) {
      console.error('Error adding data:', error);
      toast.error('Failed to add data');
    }
  };

  // Import Data from text
  const handleImportData = async () => {
    if (!selectedTagId) {
      toast.error('Please select a tag');
      return;
    }
    if (!importText.trim()) {
      toast.error('Please enter data to import');
      return;
    }

    try {
      const lines = importText.split('\n').filter(line => line.trim());
      const records = lines.map(line => {
        const trimmed = line.trim();
        // Check if it looks like a phone number (starts with + or digits)
        const isPhone = /^[+\d]/.test(trimmed);
        return {
          tag_id: selectedTagId,
          phone_number: isPhone ? trimmed : null,
          username: isPhone ? null : trimmed.replace('@', ''),
        };
      });

      const { error } = await supabase.from('material_data').insert(records);
      if (error) throw error;
      toast.success(`Imported ${records.length} items`);
      setImportText('');
      setIsImportDataOpen(false);
      fetchData();
    } catch (error) {
      console.error('Error importing data:', error);
      toast.error('Failed to import data');
    }
  };

  // Upload Pictures
  const handleUploadPictures = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    if (!selectedTagId) {
      toast.error('Please select a tag first');
      return;
    }

    setUploadingFiles(true);
    try {
      const uploads = [];
      for (const file of Array.from(files)) {
        const fileName = `${Date.now()}-${file.name}`;
        const { error } = await supabase.storage
          .from('material-pictures')
          .upload(fileName, file);

        if (error) throw error;

        const { data: urlData } = supabase.storage
          .from('material-pictures')
          .getPublicUrl(fileName);

        uploads.push({
          tag_id: selectedTagId,
          file_url: urlData.publicUrl,
          file_name: file.name,
        });
      }

      const { error } = await supabase.from('material_pictures').insert(uploads);
      if (error) throw error;
      
      toast.success(`Uploaded ${uploads.length} pictures`);
      setIsUploadPicturesOpen(false);
      fetchData();
    } catch (error) {
      console.error('Error uploading pictures:', error);
      toast.error('Failed to upload pictures');
    } finally {
      setUploadingFiles(false);
    }
  };

  // Add Name
  const handleAddName = async () => {
    if (!selectedTagId) {
      toast.error('Please select a tag');
      return;
    }
    if (!firstName.trim()) {
      toast.error('Please enter first name');
      return;
    }

    try {
      const { error } = await supabase.from('material_names').insert({
        tag_id: selectedTagId,
        first_name: firstName.trim(),
        last_name: lastName.trim() || null,
      });

      if (error) throw error;
      toast.success('Name added successfully');
      setFirstName('');
      setLastName('');
      setIsAddNameOpen(false);
      fetchData();
    } catch (error) {
      console.error('Error adding name:', error);
      toast.error('Failed to add name');
    }
  };

  // Import Names from text
  const handleImportNames = async () => {
    if (!selectedTagId) {
      toast.error('Please select a tag');
      return;
    }
    if (!importText.trim()) {
      toast.error('Please enter names to import');
      return;
    }

    try {
      const lines = importText.split('\n').filter(line => line.trim());
      const records = lines.map(line => {
        const parts = line.trim().split(/\s+/);
        return {
          tag_id: selectedTagId,
          first_name: parts[0] || '',
          last_name: parts.slice(1).join(' ') || null,
        };
      }).filter(r => r.first_name);

      const { error } = await supabase.from('material_names').insert(records);
      if (error) throw error;
      toast.success(`Imported ${records.length} names`);
      setImportText('');
      setIsImportNamesOpen(false);
      fetchData();
    } catch (error) {
      console.error('Error importing names:', error);
      toast.error('Failed to import names');
    }
  };

  // Delete individual items
  const handleDeleteData = async (id: string) => {
    try {
      const { error } = await supabase.from('material_data').delete().eq('id', id);
      if (error) throw error;
      toast.success('Deleted');
      fetchData();
    } catch (error) {
      toast.error('Failed to delete');
    }
  };

  const handleDeletePicture = async (id: string, fileUrl: string) => {
    try {
      const fileName = fileUrl.split('/').pop();
      if (fileName) {
        await supabase.storage.from('material-pictures').remove([fileName]);
      }
      const { error } = await supabase.from('material_pictures').delete().eq('id', id);
      if (error) throw error;
      toast.success('Deleted');
      fetchData();
    } catch (error) {
      toast.error('Failed to delete');
    }
  };

  const handleDeleteName = async (id: string) => {
    try {
      const { error } = await supabase.from('material_names').delete().eq('id', id);
      if (error) throw error;
      toast.success('Deleted');
      fetchData();
    } catch (error) {
      toast.error('Failed to delete');
    }
  };

  // Bulk delete confirmation triggers
  const confirmBulkDeleteData = (tagId: string, tagName: string) => {
    const count = dataItems.filter(d => d.tag_id === tagId).length;
    setBulkDeleteConfirm({ open: true, type: 'data', tagId, tagName, count });
  };

  const confirmBulkDeletePictures = (tagId: string, tagName: string) => {
    const count = pictures.filter(p => p.tag_id === tagId).length;
    setBulkDeleteConfirm({ open: true, type: 'pictures', tagId, tagName, count });
  };

  const confirmBulkDeleteNames = (tagId: string, tagName: string) => {
    const count = names.filter(n => n.tag_id === tagId).length;
    setBulkDeleteConfirm({ open: true, type: 'names', tagId, tagName, count });
  };

  const confirmDeleteTag = (tagId: string, tagName: string) => {
    setBulkDeleteConfirm({ open: true, type: 'tag', tagId, tagName, count: 0 });
  };

  // Bulk delete all items in a tag
  const handleBulkDeleteData = async (tagId: string) => {
    try {
      const count = dataItems.filter(d => d.tag_id === tagId).length;
      const { error } = await supabase.from('material_data').delete().eq('tag_id', tagId);
      if (error) throw error;
      toast.success(`Deleted ${count} data items`);
      fetchData();
    } catch (error) {
      console.error('Error bulk deleting data:', error);
      toast.error('Failed to delete items');
    }
  };

  const handleBulkDeletePictures = async (tagId: string) => {
    try {
      const tagPictures = pictures.filter(p => p.tag_id === tagId);
      // Delete from storage first
      for (const pic of tagPictures) {
        const fileName = pic.file_url.split('/').pop();
        if (fileName) {
          await supabase.storage.from('material-pictures').remove([fileName]);
        }
      }
      // Then delete from database
      const { error } = await supabase.from('material_pictures').delete().eq('tag_id', tagId);
      if (error) throw error;
      toast.success(`Deleted ${tagPictures.length} pictures`);
      fetchData();
    } catch (error) {
      console.error('Error bulk deleting pictures:', error);
      toast.error('Failed to delete pictures');
    }
  };

  const handleBulkDeleteNames = async (tagId: string) => {
    try {
      const count = names.filter(n => n.tag_id === tagId).length;
      const { error } = await supabase.from('material_names').delete().eq('tag_id', tagId);
      if (error) throw error;
      toast.success(`Deleted ${count} names`);
      fetchData();
    } catch (error) {
      console.error('Error bulk deleting names:', error);
      toast.error('Failed to delete names');
    }
  };

  // Handle confirmed bulk delete
  const handleConfirmedBulkDelete = async () => {
    if (!bulkDeleteConfirm) return;
    
    const { type, tagId } = bulkDeleteConfirm;
    setBulkDeleteConfirm(null);
    
    switch (type) {
      case 'data':
        await handleBulkDeleteData(tagId);
        break;
      case 'pictures':
        await handleBulkDeletePictures(tagId);
        break;
      case 'names':
        await handleBulkDeleteNames(tagId);
        break;
      case 'tag':
        await handleDeleteTag(tagId);
        break;
    }
  };

  // Export functions
  const handleExportData = (tagId: string, tagName: string, format: 'csv' | 'txt') => {
    const tagData = dataItems.filter(d => d.tag_id === tagId);
    if (tagData.length === 0) {
      toast.error('No data to export');
      return;
    }

    let content: string;
    let filename: string;
    let mimeType: string;

    if (format === 'csv') {
      const headers = 'phone_number,username';
      const rows = tagData.map(d => `${d.phone_number || ''},${d.username || ''}`);
      content = [headers, ...rows].join('\n');
      filename = `${tagName}-data.csv`;
      mimeType = 'text/csv';
    } else {
      content = tagData.map(d => d.phone_number || d.username || '').join('\n');
      filename = `${tagName}-data.txt`;
      mimeType = 'text/plain';
    }

    downloadFile(content, filename, mimeType);
    toast.success(`Exported ${tagData.length} items`);
  };

  const handleExportNames = (tagId: string, tagName: string, format: 'csv' | 'txt') => {
    const tagNames = names.filter(n => n.tag_id === tagId);
    if (tagNames.length === 0) {
      toast.error('No names to export');
      return;
    }

    let content: string;
    let filename: string;
    let mimeType: string;

    if (format === 'csv') {
      const headers = 'first_name,last_name';
      const rows = tagNames.map(n => `${n.first_name},${n.last_name || ''}`);
      content = [headers, ...rows].join('\n');
      filename = `${tagName}-names.csv`;
      mimeType = 'text/csv';
    } else {
      content = tagNames.map(n => `${n.first_name}${n.last_name ? ' ' + n.last_name : ''}`).join('\n');
      filename = `${tagName}-names.txt`;
      mimeType = 'text/plain';
    }

    downloadFile(content, filename, mimeType);
    toast.success(`Exported ${tagNames.length} names`);
  };

  const downloadFile = (content: string, filename: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Import from file
  const handleImportFromFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!selectedTagId) {
      toast.error('Please select a tag first');
      return;
    }

    try {
      const text = await file.text();
      const lines = text.split('\n').filter(line => line.trim());
      
      // Skip header if CSV
      const startIndex = file.name.endsWith('.csv') && lines[0]?.includes(',') ? 1 : 0;
      
      const records = lines.slice(startIndex).map(line => {
        let phone: string | null = null;
        let user: string | null = null;
        
        if (line.includes(',')) {
          const parts = line.split(',');
          phone = parts[0]?.trim() || null;
          user = parts[1]?.trim() || null;
        } else {
          const trimmed = line.trim();
          const isPhone = /^[+\d]/.test(trimmed);
          phone = isPhone ? trimmed : null;
          user = isPhone ? null : trimmed.replace('@', '');
        }
        
        return {
          tag_id: selectedTagId,
          phone_number: phone || null,
          username: user || null,
        };
      }).filter(r => r.phone_number || r.username);

      if (records.length === 0) {
        toast.error('No valid data found in file');
        return;
      }

      const { error } = await supabase.from('material_data').insert(records);
      if (error) throw error;
      toast.success(`Imported ${records.length} items from file`);
      setIsImportDataOpen(false);
      fetchData();
    } catch (error) {
      console.error('Error importing from file:', error);
      toast.error('Failed to import from file');
    }
    
    // Reset file input
    e.target.value = '';
  };

  return (
    <DashboardLayout>
      <PageHeader 
        title="Material Management" 
        description="Manage data, pictures, and names for account operations"
        icon={Package}
      />

      <AnimatePresence mode="wait">
        {isLoading ? (
          <motion.div
            key="loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="space-y-6"
          >
            <Card>
              <CardHeader>
                <Skeleton className="h-10 w-64" />
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-40 rounded-xl" />
                  ))}
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ) : (
          <motion.div
            key="content"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <Card>
              <CardHeader className="pb-3">
                <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'data' | 'pictures' | 'names')}>
                  <div className="flex items-center justify-between flex-wrap gap-4">
                    <TabsList className="grid w-full max-w-md grid-cols-3">
                      <TabsTrigger value="data" className="flex items-center gap-2">
                        <FileText className="h-4 w-4" />
                        Data
                      </TabsTrigger>
                      <TabsTrigger value="pictures" className="flex items-center gap-2">
                        <Image className="h-4 w-4" />
                        Pictures
                      </TabsTrigger>
                      <TabsTrigger value="names" className="flex items-center gap-2">
                        <User className="h-4 w-4" />
                        Names
                      </TabsTrigger>
                    </TabsList>

                    <div className="flex gap-2">
                      <Button onClick={() => setIsCreateTagOpen(true)} variant="outline" size="sm">
                        <Tag className="h-4 w-4 mr-2" />
                        Create Tag
                      </Button>
                      {activeTab === 'data' && (
                        <>
                          <Button onClick={() => { setSelectedTagId(''); setIsAddDataOpen(true); }} size="sm">
                            <Plus className="h-4 w-4 mr-2" />
                            Add Data
                          </Button>
                          <Button onClick={() => { setSelectedTagId(''); setIsImportDataOpen(true); }} variant="secondary" size="sm">
                            <Upload className="h-4 w-4 mr-2" />
                            Import
                          </Button>
                        </>
                      )}
                      {activeTab === 'pictures' && (
                        <Button onClick={() => { setSelectedTagId(''); setIsUploadPicturesOpen(true); }} size="sm">
                          <Upload className="h-4 w-4 mr-2" />
                          Upload Pictures
                        </Button>
                      )}
                      {activeTab === 'names' && (
                        <>
                          <Button onClick={() => { setSelectedTagId(''); setIsAddNameOpen(true); }} size="sm">
                            <Plus className="h-4 w-4 mr-2" />
                            Add Name
                          </Button>
                          <Button onClick={() => { setSelectedTagId(''); setIsImportNamesOpen(true); }} variant="secondary" size="sm">
                            <Upload className="h-4 w-4 mr-2" />
                            Import
                          </Button>
                        </>
                      )}
                      <Button onClick={fetchData} variant="ghost" size="sm">
                        <RefreshCw className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  <TabsContent value="data" className="mt-6">
                    {filteredTags.length === 0 ? (
                      <div className="text-center py-12 text-muted-foreground">
                        <FileText className="h-12 w-12 mx-auto mb-4 opacity-50" />
                        <p>No data tags yet. Create a tag to start adding phone numbers and usernames.</p>
                      </div>
                    ) : (
                      <div className="space-y-6">
                        {filteredTags.map((tag) => {
                          const tagData = dataItems.filter(d => d.tag_id === tag.id);
                          return (
                            <Card key={tag.id} className="border-border/50">
                              <CardHeader className="py-3">
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-2">
                                    <Tag className="h-4 w-4 text-primary" />
                                    <CardTitle className="text-base">{tag.name}</CardTitle>
                                    <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                                      {tag.item_count} items
                                    </span>
                                  </div>
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button variant="ghost" size="icon" className="h-8 w-8">
                                        <MoreVertical className="h-4 w-4" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                      {tagData.length > 0 && (
                                        <>
                                          <DropdownMenuItem onClick={() => handleExportData(tag.id, tag.name, 'csv')}>
                                            <Download className="h-4 w-4 mr-2" />
                                            Export as CSV
                                          </DropdownMenuItem>
                                          <DropdownMenuItem onClick={() => handleExportData(tag.id, tag.name, 'txt')}>
                                            <Download className="h-4 w-4 mr-2" />
                                            Export as TXT
                                          </DropdownMenuItem>
                                          <DropdownMenuSeparator />
                                          <DropdownMenuItem 
                                            onClick={() => confirmBulkDeleteData(tag.id, tag.name)}
                                            className="text-destructive"
                                          >
                                            <Trash2 className="h-4 w-4 mr-2" />
                                            Delete All Items ({tagData.length})
                                          </DropdownMenuItem>
                                          <DropdownMenuSeparator />
                                        </>
                                      )}
                                      <DropdownMenuItem 
                                        onClick={() => confirmDeleteTag(tag.id, tag.name)}
                                        className="text-destructive"
                                      >
                                        <Trash2 className="h-4 w-4 mr-2" />
                                        Delete Tag
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                </div>
                              </CardHeader>
                              <CardContent className="pt-0">
                                {tagData.length === 0 ? (
                                  <p className="text-sm text-muted-foreground">No data in this tag</p>
                                ) : (
                                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2 max-h-60 overflow-y-auto">
                                    {tagData.map((item) => (
                                      <div key={item.id} className="flex items-center justify-between bg-muted/50 rounded-lg px-3 py-2 text-sm">
                                        <div className="flex items-center gap-2 truncate">
                                          {item.phone_number ? (
                                            <>
                                              <Phone className="h-3 w-3 text-muted-foreground" />
                                              <span className="truncate">{item.phone_number}</span>
                                            </>
                                          ) : (
                                            <>
                                              <AtSign className="h-3 w-3 text-muted-foreground" />
                                              <span className="truncate">{item.username}</span>
                                            </>
                                          )}
                                        </div>
                                        <Button 
                                          variant="ghost" 
                                          size="icon" 
                                          className="h-6 w-6 shrink-0"
                                          onClick={() => handleDeleteData(item.id)}
                                        >
                                          <Trash2 className="h-3 w-3" />
                                        </Button>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </CardContent>
                            </Card>
                          );
                        })}
                      </div>
                    )}
                  </TabsContent>

                  <TabsContent value="pictures" className="mt-6">
                    {filteredTags.length === 0 ? (
                      <div className="text-center py-12 text-muted-foreground">
                        <Image className="h-12 w-12 mx-auto mb-4 opacity-50" />
                        <p>No picture tags yet. Create a tag to start uploading profile pictures.</p>
                      </div>
                    ) : (
                      <div className="space-y-6">
                        {filteredTags.map((tag) => {
                          const tagPictures = pictures.filter(p => p.tag_id === tag.id);
                          return (
                            <Card key={tag.id} className="border-border/50">
                              <CardHeader className="py-3">
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-2">
                                    <Tag className="h-4 w-4 text-primary" />
                                    <CardTitle className="text-base">{tag.name}</CardTitle>
                                    <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                                      {tag.item_count} pictures
                                    </span>
                                  </div>
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button variant="ghost" size="icon" className="h-8 w-8">
                                        <MoreVertical className="h-4 w-4" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                      {tagPictures.length > 0 && (
                                        <>
                                          <DropdownMenuItem 
                                            onClick={() => confirmBulkDeletePictures(tag.id, tag.name)}
                                            className="text-destructive"
                                          >
                                            <Trash2 className="h-4 w-4 mr-2" />
                                            Delete All Pictures ({tagPictures.length})
                                          </DropdownMenuItem>
                                          <DropdownMenuSeparator />
                                        </>
                                      )}
                                      <DropdownMenuItem 
                                        onClick={() => confirmDeleteTag(tag.id, tag.name)}
                                        className="text-destructive"
                                      >
                                        <Trash2 className="h-4 w-4 mr-2" />
                                        Delete Tag
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                </div>
                              </CardHeader>
                              <CardContent className="pt-0">
                                {tagPictures.length === 0 ? (
                                  <p className="text-sm text-muted-foreground">No pictures in this tag</p>
                                ) : (
                                  <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-2 max-h-60 overflow-y-auto">
                                    {tagPictures.map((pic) => (
                                      <div key={pic.id} className="relative group aspect-square">
                                        <img 
                                          src={pic.file_url} 
                                          alt={pic.file_name}
                                          className="w-full h-full object-cover rounded-lg"
                                        />
                                        <Button 
                                          variant="destructive" 
                                          size="icon" 
                                          className="absolute top-1 right-1 h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity"
                                          onClick={() => handleDeletePicture(pic.id, pic.file_url)}
                                        >
                                          <Trash2 className="h-3 w-3" />
                                        </Button>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </CardContent>
                            </Card>
                          );
                        })}
                      </div>
                    )}
                  </TabsContent>

                  <TabsContent value="names" className="mt-6">
                    {filteredTags.length === 0 ? (
                      <div className="text-center py-12 text-muted-foreground">
                        <User className="h-12 w-12 mx-auto mb-4 opacity-50" />
                        <p>No name tags yet. Create a tag to start adding names.</p>
                      </div>
                    ) : (
                      <div className="space-y-6">
                        {filteredTags.map((tag) => {
                          const tagNames = names.filter(n => n.tag_id === tag.id);
                          return (
                            <Card key={tag.id} className="border-border/50">
                              <CardHeader className="py-3">
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-2">
                                    <Tag className="h-4 w-4 text-primary" />
                                    <CardTitle className="text-base">{tag.name}</CardTitle>
                                    <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                                      {tag.item_count} names
                                    </span>
                                  </div>
                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <Button variant="ghost" size="icon" className="h-8 w-8">
                                        <MoreVertical className="h-4 w-4" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                      {tagNames.length > 0 && (
                                        <>
                                          <DropdownMenuItem onClick={() => handleExportNames(tag.id, tag.name, 'csv')}>
                                            <Download className="h-4 w-4 mr-2" />
                                            Export as CSV
                                          </DropdownMenuItem>
                                          <DropdownMenuItem onClick={() => handleExportNames(tag.id, tag.name, 'txt')}>
                                            <Download className="h-4 w-4 mr-2" />
                                            Export as TXT
                                          </DropdownMenuItem>
                                          <DropdownMenuSeparator />
                                          <DropdownMenuItem 
                                            onClick={() => confirmBulkDeleteNames(tag.id, tag.name)}
                                            className="text-destructive"
                                          >
                                            <Trash2 className="h-4 w-4 mr-2" />
                                            Delete All Names ({tagNames.length})
                                          </DropdownMenuItem>
                                          <DropdownMenuSeparator />
                                        </>
                                      )}
                                      <DropdownMenuItem 
                                        onClick={() => confirmDeleteTag(tag.id, tag.name)}
                                        className="text-destructive"
                                      >
                                        <Trash2 className="h-4 w-4 mr-2" />
                                        Delete Tag
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                </div>
                              </CardHeader>
                              <CardContent className="pt-0">
                                {tagNames.length === 0 ? (
                                  <p className="text-sm text-muted-foreground">No names in this tag</p>
                                ) : (
                                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2 max-h-60 overflow-y-auto">
                                    {tagNames.map((name) => (
                                      <div key={name.id} className="flex items-center justify-between bg-muted/50 rounded-lg px-3 py-2 text-sm">
                                        <div className="flex items-center gap-2 truncate">
                                          <User className="h-3 w-3 text-muted-foreground" />
                                          <span className="truncate">
                                            {name.first_name} {name.last_name || ''}
                                          </span>
                                        </div>
                                        <Button 
                                          variant="ghost" 
                                          size="icon" 
                                          className="h-6 w-6 shrink-0"
                                          onClick={() => handleDeleteName(name.id)}
                                        >
                                          <Trash2 className="h-3 w-3" />
                                        </Button>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </CardContent>
                            </Card>
                          );
                        })}
                      </div>
                    )}
                  </TabsContent>
                </Tabs>
              </CardHeader>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Create Tag Dialog */}
      <Dialog open={isCreateTagOpen} onOpenChange={setIsCreateTagOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Tag for {activeTab.charAt(0).toUpperCase() + activeTab.slice(1)}</DialogTitle>
            <DialogDescription>
              Create a new tag to organize your {activeTab}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Tag Name</Label>
              <Input 
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                placeholder="e.g., New Accounts, VIP List"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateTagOpen(false)}>Cancel</Button>
            <Button onClick={handleCreateTag}>Create Tag</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Data Dialog */}
      <Dialog open={isAddDataOpen} onOpenChange={setIsAddDataOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Data</DialogTitle>
            <DialogDescription>
              Add phone number or username
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Select Tag</Label>
              <Select value={selectedTagId} onValueChange={setSelectedTagId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a tag" />
                </SelectTrigger>
                <SelectContent>
                  {tags.filter(t => t.type === 'data').map((tag) => (
                    <SelectItem key={tag.id} value={tag.id}>{tag.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Phone Number</Label>
              <Input 
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                placeholder="+1234567890 or 1234567890"
              />
            </div>
            <div>
              <Label>Username</Label>
              <Input 
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="@username or username"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddDataOpen(false)}>Cancel</Button>
            <Button onClick={handleAddData}>Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import Data Dialog */}
      <Dialog open={isImportDataOpen} onOpenChange={setIsImportDataOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Import Data</DialogTitle>
            <DialogDescription>
              Import phone numbers and usernames from text or file
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Select Tag</Label>
              <Select value={selectedTagId} onValueChange={setSelectedTagId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a tag" />
                </SelectTrigger>
                <SelectContent>
                  {tags.filter(t => t.type === 'data').map((tag) => (
                    <SelectItem key={tag.id} value={tag.id}>{tag.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="border rounded-lg p-4 bg-muted/30">
              <Label className="text-sm font-medium">Import from File</Label>
              <p className="text-xs text-muted-foreground mb-2">
                Upload a .txt or .csv file with data
              </p>
              <Input 
                type="file"
                accept=".txt,.csv"
                onChange={handleImportFromFile}
                disabled={!selectedTagId}
                className="cursor-pointer"
              />
            </div>
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-background px-2 text-muted-foreground">Or paste text</span>
              </div>
            </div>
            <div>
              <Label>Data (one per line)</Label>
              <Textarea 
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder={"+1234567890\n9876543210\n@username\nusername2"}
                rows={6}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Phone numbers (with or without +) and usernames (with or without @)
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsImportDataOpen(false)}>Cancel</Button>
            <Button onClick={handleImportData} disabled={!importText.trim()}>Import Text</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Upload Pictures Dialog */}
      <Dialog open={isUploadPicturesOpen} onOpenChange={setIsUploadPicturesOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload Pictures</DialogTitle>
            <DialogDescription>
              Upload profile pictures in bulk
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Select Tag</Label>
              <Select value={selectedTagId} onValueChange={setSelectedTagId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a tag" />
                </SelectTrigger>
                <SelectContent>
                  {tags.filter(t => t.type === 'pictures').map((tag) => (
                    <SelectItem key={tag.id} value={tag.id}>{tag.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Select Images</Label>
              <Input 
                type="file"
                accept="image/*"
                multiple
                onChange={handleUploadPictures}
                disabled={!selectedTagId || uploadingFiles}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Select multiple images to upload at once
              </p>
            </div>
            {uploadingFiles && (
              <p className="text-sm text-primary">Uploading...</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsUploadPicturesOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Name Dialog */}
      <Dialog open={isAddNameOpen} onOpenChange={setIsAddNameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Name</DialogTitle>
            <DialogDescription>
              Add first and last name
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Select Tag</Label>
              <Select value={selectedTagId} onValueChange={setSelectedTagId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a tag" />
                </SelectTrigger>
                <SelectContent>
                  {tags.filter(t => t.type === 'names').map((tag) => (
                    <SelectItem key={tag.id} value={tag.id}>{tag.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>First Name</Label>
              <Input 
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="John"
              />
            </div>
            <div>
              <Label>Last Name (optional)</Label>
              <Input 
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder="Smith"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddNameOpen(false)}>Cancel</Button>
            <Button onClick={handleAddName}>Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import Names Dialog */}
      <Dialog open={isImportNamesOpen} onOpenChange={setIsImportNamesOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Import Names</DialogTitle>
            <DialogDescription>
              Import names (one per line, first name and optional last name)
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Select Tag</Label>
              <Select value={selectedTagId} onValueChange={setSelectedTagId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a tag" />
                </SelectTrigger>
                <SelectContent>
                  {tags.filter(t => t.type === 'names').map((tag) => (
                    <SelectItem key={tag.id} value={tag.id}>{tag.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Names (one per line)</Label>
              <Textarea 
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder={"John Smith\nJane Doe\nMike\nSarah Johnson"}
                rows={8}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Format: "FirstName LastName" or just "FirstName"
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsImportNamesOpen(false)}>Cancel</Button>
            <Button onClick={handleImportNames}>Import</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Delete Confirmation Dialog */}
      <AlertDialog open={bulkDeleteConfirm?.open ?? false} onOpenChange={(open) => !open && setBulkDeleteConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {bulkDeleteConfirm?.type === 'tag' ? 'Delete Tag?' : 'Delete All Items?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {bulkDeleteConfirm?.type === 'tag' ? (
                <>
                  This will permanently delete the tag "<strong>{bulkDeleteConfirm?.tagName}</strong>" and all its contents. This action cannot be undone.
                </>
              ) : bulkDeleteConfirm?.type === 'data' ? (
                <>
                  This will permanently delete <strong>{bulkDeleteConfirm?.count} data items</strong> from "<strong>{bulkDeleteConfirm?.tagName}</strong>". This action cannot be undone.
                </>
              ) : bulkDeleteConfirm?.type === 'pictures' ? (
                <>
                  This will permanently delete <strong>{bulkDeleteConfirm?.count} pictures</strong> from "<strong>{bulkDeleteConfirm?.tagName}</strong>". This action cannot be undone.
                </>
              ) : (
                <>
                  This will permanently delete <strong>{bulkDeleteConfirm?.count} names</strong> from "<strong>{bulkDeleteConfirm?.tagName}</strong>". This action cannot be undone.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmedBulkDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardLayout>
  );
};

export default Material;
