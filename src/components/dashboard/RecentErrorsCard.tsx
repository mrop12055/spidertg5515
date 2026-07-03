import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { localClient as supabase } from '@/lib/localClient';
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
  const queryClient = useQueryClient();

  const fetchRecentErrors = async (): Promise<RecentError[]> => {
    const [
      failedRecipientsRes, failedMessagesRes, failedAccountTasksRes,
      failedBlockTasksRes, failedImportTasksRes,
      accountErrorsRes, vpsErrorLogsRes
    ] = await Promise.all([
      supabase.from('campaign_recipients').select('id, phone_number, failed_reason, sent_at').eq('status', 'failed').not('failed_reason', 'is', null).order('sent_at', { ascending: false, nullsFirst: false }).limit(150),
      supabase.from('messages').select('id, failed_reason, created_at, conversation_id').eq('status', 'failed').not('failed_reason', 'is', null).order('created_at', { ascending: false }).limit(150),
      supabase.from('account_check_tasks').select('id, account_id, result, created_at').eq('status', 'failed').not('result', 'is', null).order('created_at', { ascending: false }).limit(150),
      supabase.from('block_contact_tasks').select('id, target_phone, result, created_at').eq('status', 'failed').not('result', 'is', null).order('created_at', { ascending: false }).limit(100),
      supabase.from('contact_import_tasks').select('id, result, created_at').eq('status', 'failed').not('result', 'is', null).order('created_at', { ascending: false }).limit(100),
      supabase.from('telegram_accounts').select('id, phone_number, status, ban_reason, restricted_until, created_at').not('ban_reason', 'is', null).neq('ban_reason', '').order('restricted_until', { ascending: false, nullsFirst: false }).limit(150),
      supabase.from('vps_logs').select('id, runner_name, message, log_level, created_at').eq('log_level', 'error').order('created_at', { ascending: false }).limit(200),
    ]);

    const allErrors: RecentError[] = [];

    (failedRecipientsRes.data || []).forEach(r => {
      if (r.failed_reason) {
        allErrors.push({ id: r.id, phone: r.phone_number, reason: r.failed_reason, timestamp: r.sent_at || new Date().toISOString(), source: 'Campaign' });
      }
    });

    (failedMessagesRes.data || []).forEach(m => {
      if (m.failed_reason) {
        allErrors.push({ id: m.id, phone: m.conversation_id?.substring(0, 8) || '-', reason: m.failed_reason, timestamp: m.created_at || new Date().toISOString(), source: 'Message' });
      }
    });

    (failedAccountTasksRes.data || []).forEach(t => {
      if (t.result) {
        allErrors.push({ id: t.id, phone: t.account_id?.substring(0, 8) || '-', reason: t.result, timestamp: t.created_at || new Date().toISOString(), source: 'Account Check' });
      }
    });

    (failedBlockTasksRes.data || []).forEach(t => {
      if (t.result) {
        allErrors.push({ id: t.id, phone: t.target_phone || '-', reason: t.result, timestamp: t.created_at || new Date().toISOString(), source: 'Block Task' });
      }
    });

    (failedImportTasksRes.data || []).forEach(t => {
      if (t.result) {
        allErrors.push({ id: t.id, phone: 'Import', reason: t.result, timestamp: t.created_at || new Date().toISOString(), source: 'Import' });
      }
    });


    (accountErrorsRes.data || []).forEach(a => {
      if (a.ban_reason) {
        allErrors.push({ id: a.id, phone: a.phone_number, reason: a.ban_reason, timestamp: a.restricted_until || a.created_at || new Date().toISOString(), source: 'Account' });
      }
    });

    (vpsErrorLogsRes.data || []).forEach(v => {
      if (v.message) {
        allErrors.push({ id: v.id, phone: v.runner_name || 'Python', reason: v.message, timestamp: v.created_at || new Date().toISOString(), source: 'Python' });
      }
    });

    allErrors.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return allErrors.slice(0, 1000);
  };

  const { data: recentErrors = [] } = useQuery({
    queryKey: ['recent-errors'],
    queryFn: fetchRecentErrors,
    staleTime: 300000,
    gcTime: 600000,
    refetchOnWindowFocus: false,
  });

  // Removed 6 realtime channels — errors are not time-critical.
  // Data refreshes when staleTime expires (5 min) or on manual navigation.

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
