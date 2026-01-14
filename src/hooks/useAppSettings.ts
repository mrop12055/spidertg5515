import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { Json } from '@/integrations/supabase/types';

export interface MessageTimingSettings {
  minDelaySeconds: number;
  maxDelaySeconds: number;
  accountSwitchDelaySeconds: number;
}

export interface SchedulerSettings {
  enabled: boolean;
  maxMessagesBeforeRotation: number;
  cooldownDuration: number;
  prioritizeHighMaturity: boolean;
  autoSkipRestricted: boolean;
  balanceLoad: boolean;
}

export interface AccountLimitsSettings {
  dailyMessageLimit: number;
  warmupDays: number;
  messagesPerAccount: number;
}

export interface SafetySettings {
  autoRestartBanned: boolean;
  proxyRotation: boolean;
}

export interface CleanupSettings {
  autoCleanup: boolean;
  retentionDays: number;
}

export interface WarmupBatchSettings {
  batchSize: number;
}

export interface CampaignSpeedSettings {
  staggerMin: number;
  staggerMax: number;
  pollingInterval: number;
  batchSize: number;
  messagesPerAccountPerDay: number;
}

export interface LivechatSettings {
  sameAccountStaggerMin: number;  // Min delay (seconds) between messages for SAME account
  sameAccountStaggerMax: number;  // Max delay (seconds)
  parallelAccountLimit: number;   // Max accounts to process in parallel (0 = unlimited)
  pollingInterval: number;        // Seconds between fetching new tasks
  enableParallel: boolean;        // Master toggle for parallel mode
}

export interface AllSettings {
  message_timing: MessageTimingSettings;
  scheduler: SchedulerSettings;
  account_limits: AccountLimitsSettings;
  safety: SafetySettings;
  cleanup: CleanupSettings;
  warmup_batch_size: WarmupBatchSettings;
  campaign_speed: CampaignSpeedSettings;
  livechat: LivechatSettings;
}

const defaultSettings: AllSettings = {
  message_timing: {
    minDelaySeconds: 5,
    maxDelaySeconds: 15,
    accountSwitchDelaySeconds: 30,
  },
  scheduler: {
    enabled: true,
    maxMessagesBeforeRotation: 10,
    cooldownDuration: 300,
    prioritizeHighMaturity: true,
    autoSkipRestricted: true,
    balanceLoad: true,
  },
  account_limits: {
    dailyMessageLimit: 25,
    warmupDays: 14,
    messagesPerAccount: 10,
  },
  safety: {
    autoRestartBanned: true,
    proxyRotation: false,
  },
  cleanup: {
    autoCleanup: true,
    retentionDays: 30,
  },
  warmup_batch_size: {
    batchSize: 100,
  },
  campaign_speed: {
    staggerMin: 0.3,
    staggerMax: 1.5,
    pollingInterval: 3,
    batchSize: 100,
    messagesPerAccountPerDay: 10,
  },
  livechat: {
    sameAccountStaggerMin: 1,
    sameAccountStaggerMax: 2,
    parallelAccountLimit: 0,  // 0 = unlimited
    pollingInterval: 0.5,     // Fast polling
    enableParallel: true,
  },
};

export function useAppSettings() {
  const [settings, setSettings] = useState<AllSettings>(defaultSettings);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  // Fetch all settings from database
  const fetchSettings = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('app_settings')
        .select('key, value');

      if (error) throw error;

      if (data && data.length > 0) {
        const newSettings = { ...defaultSettings };
        data.forEach((row) => {
          const key = row.key as keyof AllSettings;
          if (key in newSettings && row.value) {
            (newSettings as Record<string, unknown>)[key] = row.value;
          }
        });
        setSettings(newSettings);
      }
    } catch (error) {
      console.error('Failed to fetch settings:', error);
      // Fall back to defaults
      setSettings(defaultSettings);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Save a specific setting to database
  const saveSetting = useCallback(async <K extends keyof AllSettings>(
    key: K,
    value: AllSettings[K]
  ): Promise<boolean> => {
    setIsSaving(true);
    try {
      // Check if setting exists
      const { data: existing } = await supabase
        .from('app_settings')
        .select('id')
        .eq('key', key)
        .maybeSingle();

      const jsonValue = JSON.parse(JSON.stringify(value)) as Json;

      if (existing) {
        // Update existing
        const { error } = await supabase
          .from('app_settings')
          .update({ value: jsonValue })
          .eq('key', key);
        if (error) throw error;
      } else {
        // Insert new
        const { error } = await supabase
          .from('app_settings')
          .insert({ key, value: jsonValue });
        if (error) throw error;
      }

      setSettings(prev => ({ ...prev, [key]: value }));
      return true;
    } catch (error) {
      console.error(`Failed to save ${key}:`, error);
      toast.error(`Failed to save ${key} settings`);
      return false;
    } finally {
      setIsSaving(false);
    }
  }, []);

  // Save all settings at once
  const saveAllSettings = useCallback(async (newSettings: AllSettings): Promise<boolean> => {
    setIsSaving(true);
    try {
      for (const [key, value] of Object.entries(newSettings)) {
        const { data: existing } = await supabase
          .from('app_settings')
          .select('id')
          .eq('key', key)
          .maybeSingle();

        const jsonValue = JSON.parse(JSON.stringify(value)) as Json;

        if (existing) {
          const { error } = await supabase
            .from('app_settings')
            .update({ value: jsonValue })
            .eq('key', key);
          if (error) throw error;
        } else {
          const { error } = await supabase
            .from('app_settings')
            .insert({ key, value: jsonValue });
          if (error) throw error;
        }
      }

      setSettings(newSettings);
      toast.success('All settings saved to database');
      return true;
    } catch (error) {
      console.error('Failed to save settings:', error);
      toast.error('Failed to save settings');
      return false;
    } finally {
      setIsSaving(false);
    }
  }, []);

  // Update local state (for UI)
  const updateSettings = useCallback(<K extends keyof AllSettings>(
    key: K,
    value: Partial<AllSettings[K]>
  ) => {
    setSettings(prev => ({
      ...prev,
      [key]: { ...prev[key], ...value },
    }));
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  return {
    settings,
    isLoading,
    isSaving,
    fetchSettings,
    saveSetting,
    saveAllSettings,
    updateSettings,
  };
}
