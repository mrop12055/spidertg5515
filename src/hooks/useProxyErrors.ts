import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

interface ProxyError {
  error_type: string;
  error_message: string;
  created_at: string;
}

// Fetch proxy errors for proxies with error status
const fetchProxyErrors = async (): Promise<Map<string, ProxyError>> => {
  const errorMap = new Map<string, ProxyError>();

  // Get proxies with error status
  const { data: errorProxies, error: proxyError } = await supabase
    .from('proxies')
    .select('id')
    .eq('status', 'error')
    .limit(1000);

  if (proxyError) {
    console.error('Error fetching error proxies:', proxyError);
    return errorMap;
  }

  if (!errorProxies || errorProxies.length === 0) {
    return errorMap;
  }

  const errorProxyIds = new Set(errorProxies.map(p => p.id));

  // Initialize all error-status proxies with default message
  errorProxyIds.forEach(proxyId => {
    errorMap.set(proxyId, {
      error_type: 'error',
      error_message: 'Proxy marked as error',
      created_at: new Date().toISOString()
    });
  });

  // Get latest error messages for these proxies
  const { data: errors, error: errorsError } = await supabase
    .from('proxy_errors')
    .select('proxy_id, error_type, error_message, created_at')
    .order('created_at', { ascending: false })
    .limit(500);

  if (errorsError) {
    console.error('Error fetching proxy errors:', errorsError);
    return errorMap;
  }

  // Add actual error messages where available
  (errors || []).forEach(err => {
    if (!errorProxyIds.has(err.proxy_id)) return;
    // Only set if not already set (we want the latest error)
    if (errorMap.get(err.proxy_id)?.error_type === 'error') {
      errorMap.set(err.proxy_id, {
        error_type: err.error_type || 'unknown',
        error_message: err.error_message || 'Unknown error',
        created_at: err.created_at
      });
    }
  });

  return errorMap;
};

export const useProxyErrors = () => {
  const query = useQuery({
    queryKey: ['proxy-errors'],
    queryFn: fetchProxyErrors,
    staleTime: 60000, // Data stays fresh for 1 minute
    gcTime: 300000, // Cache persists for 5 minutes
    refetchOnWindowFocus: false,
  });

  return {
    proxyErrors: query.data ?? new Map<string, ProxyError>(),
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    refetch: query.refetch,
  };
};
