import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Server, Loader2, Circle, ExternalLink } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import { Link } from 'react-router-dom';

const VPS_ONLINE_THRESHOLD_MS = 30000;

interface VPSConnection {
  id: string;
  name: string;
  status: string;
  last_seen: string | null;
  ip_address: string | null;
}

export const VPSManager: React.FC = () => {
  const [vps, setVps] = useState<VPSConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [vpsOnline, setVpsOnline] = useState(false);
  const statusCheckRef = useRef<NodeJS.Timeout | null>(null);

  const fetchVPS = useCallback(async () => {
    const { data } = await supabase
      .from('vps_connections')
      .select('id, name, status, last_seen, ip_address')
      .limit(1)
      .maybeSingle();
    setVps(data);
    setLoading(false);
  }, []);

  const checkVpsStatus = useCallback(() => {
    if (!vps?.last_seen) {
      setVpsOnline(false);
      return;
    }
    const lastSeen = new Date(vps.last_seen).getTime();
    setVpsOnline(Date.now() - lastSeen < VPS_ONLINE_THRESHOLD_MS);
  }, [vps]);

  useEffect(() => {
    fetchVPS();
  }, [fetchVPS]);

  useEffect(() => {
    if (vps) {
      checkVpsStatus();
      statusCheckRef.current = setInterval(checkVpsStatus, 5000);
      
      const channel = supabase
        .channel('vps-status')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'vps_connections', filter: `id=eq.${vps.id}` }, () => fetchVPS())
        .subscribe();

      return () => {
        if (statusCheckRef.current) clearInterval(statusCheckRef.current);
        supabase.removeChannel(channel);
      };
    }
  }, [vps, checkVpsStatus, fetchVPS]);

  const getLastSeenText = () => {
    if (!vps?.last_seen) return 'Never';
    const diff = Date.now() - new Date(vps.last_seen).getTime();
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return new Date(vps.last_seen).toLocaleTimeString();
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!vps) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Server className="h-5 w-5" />
            VPS Agent
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-3">No VPS connected</p>
          <Button variant="outline" size="sm" asChild>
            <Link to="/setup">
              <ExternalLink className="h-4 w-4 mr-2" />
              Setup VPS
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Server className="h-5 w-5 text-primary" />
          VPS Agent
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium",
              vpsOnline 
                ? "bg-green-500/15 text-green-600 dark:text-green-400" 
                : "bg-red-500/15 text-red-600 dark:text-red-400"
            )}>
              <Circle className={cn("h-2 w-2 fill-current", vpsOnline && "animate-pulse")} />
              {vpsOnline ? 'Running' : 'Stopped'}
            </div>
            <span className="text-xs text-muted-foreground">{getLastSeenText()}</span>
            {vps.ip_address && (
              <span className="text-xs font-mono text-muted-foreground">{vps.ip_address}</span>
            )}
          </div>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/setup">
              Manage
              <ExternalLink className="h-3.5 w-3.5 ml-1.5" />
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
