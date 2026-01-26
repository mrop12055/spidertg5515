import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { supabase } from '@/integrations/supabase/client';
import { 
  CheckCircle, 
  Activity,
  AlertTriangle
} from 'lucide-react';
import { format } from 'date-fns';

interface RecentError {
  id: string;
  phone: string;
  reason: string;
  timestamp: string;
  source: string;
}

export const RecentErrorsCard: React.FC = () => {
  const [recentErrors, setRecentErrors] = useState<RecentError[]>([]);

  const fetchData = async () => {
    try {
      // Increased limits to support 1000 total errors capacity
      const [
        failedRecipientsRes,
        failedMessagesRes,
        failedAccountTasksRes,
        failedBlockTasksRes,
        failedImportTasksRes,
        failedWarmupRes,
        accountErrorsRes,
        vpsErrorLogsRes
      ] = await Promise.all([
        supabase
          .from('campaign_recipients')
          .select('id, phone_number, failed_reason, sent_at')
          .eq('status', 'failed')
          .not('failed_reason', 'is', null)
          .order('sent_at', { ascending: false, nullsFirst: false })
          .limit(150),
        supabase
          .from('messages')
          .select('id, failed_reason, created_at, conversation_id')
          .eq('status', 'failed')
          .not('failed_reason', 'is', null)
          .order('created_at', { ascending: false })
          .limit(150),
        supabase
          .from('account_check_tasks')
          .select('id, account_id, result, created_at')
          .eq('status', 'failed')
          .not('result', 'is', null)
          .order('created_at', { ascending: false })
          .limit(150),
        supabase
          .from('block_contact_tasks')
          .select('id, target_phone, result, created_at')
          .eq('status', 'failed')
          .not('result', 'is', null)
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('contact_import_tasks')
          .select('id, result, created_at')
          .eq('status', 'failed')
          .not('result', 'is', null)
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('warmup_schedule')
          .select('id, account_id, task_type, created_at')
          .eq('status', 'failed')
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('telegram_accounts')
          .select('id, phone_number, status, ban_reason, restricted_until, created_at')
          .not('ban_reason', 'is', null)
          .neq('ban_reason', '')
          .order('restricted_until', { ascending: false, nullsFirst: false })
          .limit(150),
        // VPS/Python runner error logs
        supabase
          .from('vps_logs')
          .select('id, runner_name, message, log_level, created_at')
          .eq('log_level', 'error')
          .order('created_at', { ascending: false })
          .limit(200)
      ]);

      const allErrors: RecentError[] = [];

      (failedRecipientsRes.data || []).forEach(r => {
        allErrors.push({
          id: r.id,
          phone: r.phone_number,
          reason: r.failed_reason || 'Unknown error',
          timestamp: r.sent_at || new Date().toISOString(),
          source: 'Campaign'
        });
      });

      (failedMessagesRes.data || []).forEach(m => {
        allErrors.push({
          id: m.id,
          phone: m.conversation_id?.substring(0, 8) || 'Unknown',
          reason: m.failed_reason || 'Unknown error',
          timestamp: m.created_at || new Date().toISOString(),
          source: 'Message'
        });
      });

      (failedAccountTasksRes.data || []).forEach(t => {
        allErrors.push({
          id: t.id,
          phone: t.account_id?.substring(0, 8) || 'Unknown',
          reason: t.result || 'Account check failed',
          timestamp: t.created_at || new Date().toISOString(),
          source: 'Account Check'
        });
      });

      (failedBlockTasksRes.data || []).forEach(t => {
        allErrors.push({
          id: t.id,
          phone: t.target_phone || 'Unknown',
          reason: t.result || 'Block task failed',
          timestamp: t.created_at || new Date().toISOString(),
          source: 'Block Task'
        });
      });

      (failedImportTasksRes.data || []).forEach(t => {
        allErrors.push({
          id: t.id,
          phone: 'Import',
          reason: t.result || 'Import failed',
          timestamp: t.created_at || new Date().toISOString(),
          source: 'Import'
        });
      });

      (failedWarmupRes.data || []).forEach(w => {
        allErrors.push({
          id: w.id,
          phone: w.account_id?.substring(0, 8) || 'Unknown',
          reason: `Warmup ${w.task_type} failed`,
          timestamp: w.created_at || new Date().toISOString(),
          source: 'Warmup'
        });
      });

      (accountErrorsRes.data || []).forEach(a => {
        allErrors.push({
          id: a.id,
          phone: a.phone_number,
          reason: `[${a.status?.toUpperCase()}] ${a.ban_reason}`,
          timestamp: a.restricted_until || a.created_at || new Date().toISOString(),
          source: 'Account'
        });
      });

      // VPS/Python runner errors
      (vpsErrorLogsRes.data || []).forEach(v => {
        allErrors.push({
          id: v.id,
          phone: v.runner_name || 'Python',
          reason: v.message || 'Unknown error',
          timestamp: v.created_at || new Date().toISOString(),
          source: 'Python'
        });
      });

      allErrors.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setRecentErrors(allErrors.slice(0, 1000));

    } catch (error) {
      console.error('Error fetching recent errors:', error);
    }
  };

  useEffect(() => {
    fetchData();

    // OPTIMIZED: Increased debounce from 2s to 5s
    let refreshTimer: NodeJS.Timeout | null = null;
    const debouncedRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => fetchData(), 5000);
    };

    const channel = supabase
      .channel('recent-errors-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'campaign_recipients' }, debouncedRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, debouncedRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'account_check_tasks' }, debouncedRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'telegram_accounts' }, debouncedRefresh)
      .subscribe();

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      supabase.removeChannel(channel);
    };
  }, []);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="bg-gradient-to-r from-destructive/10 to-transparent border-b py-4">
        <CardTitle className="flex items-center gap-3 text-base">
          <div className="p-2 rounded-xl bg-destructive/10">
            <AlertTriangle className="w-4 h-4 text-destructive" />
          </div>
          <span>Recent Errors</span>
          <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/30">
            <Activity className="w-3 h-3 mr-1" />
            Live
          </Badge>
          <Badge variant="secondary" className="font-mono text-xs">
            {recentErrors.length}
          </Badge>
        </CardTitle>
        <CardDescription className="mt-1 text-xs">
          Errors from campaigns, messages, tasks, warmup, accounts
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-[400px]">
          {recentErrors.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <div className="p-3 rounded-full bg-green-500/10 w-fit mx-auto mb-3">
                <CheckCircle className="w-8 h-8 text-green-500" />
              </div>
              <p className="font-medium text-sm">No recent errors</p>
              <p className="text-xs mt-1">All systems running smoothly</p>
            </div>
          ) : (
            <div className="divide-y">
              {recentErrors.map((error) => (
                <div 
                  key={`${error.source}-${error.id}`} 
                  className="p-3 hover:bg-muted/30 transition-colors"
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <Badge 
                        variant="outline" 
                        className={`text-[10px] px-1.5 py-0 h-5 ${
                          error.source === 'Account' ? 'bg-orange-500/10 text-orange-500 border-orange-500/30' :
                          error.source === 'Campaign' ? 'bg-blue-500/10 text-blue-500 border-blue-500/30' :
                          error.source === 'Warmup' ? 'bg-purple-500/10 text-purple-500 border-purple-500/30' :
                          error.source === 'Python' ? 'bg-red-500/10 text-red-500 border-red-500/30' :
                          'bg-muted'
                        }`}
                      >
                        {error.source}
                      </Badge>
                      <span className="font-mono text-xs text-muted-foreground">{error.phone}</span>
                    </div>
                    <span className="text-[10px] text-muted-foreground">
                      {format(new Date(error.timestamp), 'MMM d, HH:mm')}
                    </span>
                  </div>
                  <p className="text-xs text-destructive line-clamp-2">{error.reason}</p>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
};
