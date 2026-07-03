import { useState, useCallback } from 'react';
import { toast } from 'sonner';

// In-memory settings only (app_settings table removed).
// Values reset when the page reloads.

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
  sameAccountStaggerMin: number;
  sameAccountStaggerMax: number;
  enableParallel: boolean;
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
    pollingInterval: 10,
    batchSize: 100,
    messagesPerAccountPerDay: 10,
  },
  livechat: {
    sameAccountStaggerMin: 1,
    sameAccountStaggerMax: 2,
    enableParallel: true,
  },
};

export function useAppSettings() {
  const [settings, setSettings] = useState<AllSettings>(defaultSettings);
  const [isSaving, setIsSaving] = useState(false);

  const fetchSettings = useCallback(async () => {
    // No-op — settings are in-memory only now.
  }, []);

  const saveSetting = useCallback(async <K extends keyof AllSettings>(
    key: K,
    value: AllSettings[K]
  ): Promise<boolean> => {
    setIsSaving(true);
    try {
      setSettings(prev => ({ ...prev, [key]: value }));
      return true;
    } finally {
      setIsSaving(false);
    }
  }, []);

  const saveAllSettings = useCallback(async (newSettings: AllSettings): Promise<boolean> => {
    setIsSaving(true);
    try {
      setSettings(newSettings);
      toast.success('Settings updated (in-memory)');
      return true;
    } finally {
      setIsSaving(false);
    }
  }, []);

  const updateSettings = useCallback(<K extends keyof AllSettings>(
    key: K,
    value: Partial<AllSettings[K]>
  ) => {
    setSettings(prev => ({
      ...prev,
      [key]: { ...prev[key], ...value },
    }));
  }, []);

  return {
    settings,
    isLoading: false,
    isSaving,
    fetchSettings,
    saveSetting,
    saveAllSettings,
    updateSettings,
  };
}
