export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      account_check_tasks: {
        Row: {
          account_id: string
          completed_at: string | null
          created_at: string | null
          id: string
          result: string | null
          status: string
          task_type: string
        }
        Insert: {
          account_id: string
          completed_at?: string | null
          created_at?: string | null
          id?: string
          result?: string | null
          status?: string
          task_type?: string
        }
        Update: {
          account_id?: string
          completed_at?: string | null
          created_at?: string | null
          id?: string
          result?: string | null
          status?: string
          task_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_check_tasks_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "telegram_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      app_settings: {
        Row: {
          created_at: string
          description: string | null
          id: string
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      blocked_contacts: {
        Row: {
          blocked_by_account_id: string | null
          created_at: string | null
          id: string
          name: string | null
          phone_number: string
          reason: string | null
        }
        Insert: {
          blocked_by_account_id?: string | null
          created_at?: string | null
          id?: string
          name?: string | null
          phone_number: string
          reason?: string | null
        }
        Update: {
          blocked_by_account_id?: string | null
          created_at?: string | null
          id?: string
          name?: string | null
          phone_number?: string
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "blocked_contacts_blocked_by_account_id_fkey"
            columns: ["blocked_by_account_id"]
            isOneToOne: false
            referencedRelation: "telegram_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_accounts: {
        Row: {
          account_id: string
          campaign_id: string
        }
        Insert: {
          account_id: string
          campaign_id: string
        }
        Update: {
          account_id?: string
          campaign_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaign_accounts_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "telegram_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_accounts_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_recipients: {
        Row: {
          campaign_id: string
          failed_reason: string | null
          id: string
          name: string | null
          phone_number: string
          sent_at: string | null
          sent_by_account_id: string | null
          status: string | null
        }
        Insert: {
          campaign_id: string
          failed_reason?: string | null
          id?: string
          name?: string | null
          phone_number: string
          sent_at?: string | null
          sent_by_account_id?: string | null
          status?: string | null
        }
        Update: {
          campaign_id?: string
          failed_reason?: string | null
          id?: string
          name?: string | null
          phone_number?: string
          sent_at?: string | null
          sent_by_account_id?: string | null
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "campaign_recipients_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_recipients_sent_by_account_id_fkey"
            columns: ["sent_by_account_id"]
            isOneToOne: false
            referencedRelation: "telegram_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      campaigns: {
        Row: {
          created_at: string | null
          failed_count: number | null
          id: string
          message_template: string
          name: string
          recipient_count: number | null
          reply_count: number | null
          scheduled_at: string | null
          sent_count: number | null
          status: Database["public"]["Enums"]["campaign_status"] | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          failed_count?: number | null
          id?: string
          message_template: string
          name: string
          recipient_count?: number | null
          reply_count?: number | null
          scheduled_at?: string | null
          sent_count?: number | null
          status?: Database["public"]["Enums"]["campaign_status"] | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          failed_count?: number | null
          id?: string
          message_template?: string
          name?: string
          recipient_count?: number | null
          reply_count?: number | null
          scheduled_at?: string | null
          sent_count?: number | null
          status?: Database["public"]["Enums"]["campaign_status"] | null
          updated_at?: string | null
        }
        Relationships: []
      }
      contacts_data: {
        Row: {
          blocked_at: string | null
          created_at: string | null
          id: string
          is_blocked: boolean | null
          is_used: boolean | null
          name: string | null
          notes: string | null
          phone_number: string
          updated_at: string | null
          used_at: string | null
          used_in_campaign_id: string | null
          username: string | null
        }
        Insert: {
          blocked_at?: string | null
          created_at?: string | null
          id?: string
          is_blocked?: boolean | null
          is_used?: boolean | null
          name?: string | null
          notes?: string | null
          phone_number: string
          updated_at?: string | null
          used_at?: string | null
          used_in_campaign_id?: string | null
          username?: string | null
        }
        Update: {
          blocked_at?: string | null
          created_at?: string | null
          id?: string
          is_blocked?: boolean | null
          is_used?: boolean | null
          name?: string | null
          notes?: string | null
          phone_number?: string
          updated_at?: string | null
          used_at?: string | null
          used_in_campaign_id?: string | null
          username?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contacts_data_used_in_campaign_id_fkey"
            columns: ["used_in_campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          account_id: string
          blocked_by_recipient: boolean | null
          created_at: string | null
          first_message_sent: boolean | null
          has_prior_contact: boolean | null
          id: string
          is_active: boolean | null
          last_message_at: string | null
          recipient_avatar: string | null
          recipient_name: string | null
          recipient_phone: string | null
          recipient_telegram_id: number | null
          recipient_username: string | null
          unread_count: number | null
          updated_at: string | null
        }
        Insert: {
          account_id: string
          blocked_by_recipient?: boolean | null
          created_at?: string | null
          first_message_sent?: boolean | null
          has_prior_contact?: boolean | null
          id?: string
          is_active?: boolean | null
          last_message_at?: string | null
          recipient_avatar?: string | null
          recipient_name?: string | null
          recipient_phone?: string | null
          recipient_telegram_id?: number | null
          recipient_username?: string | null
          unread_count?: number | null
          updated_at?: string | null
        }
        Update: {
          account_id?: string
          blocked_by_recipient?: boolean | null
          created_at?: string | null
          first_message_sent?: boolean | null
          has_prior_contact?: boolean | null
          id?: string
          is_active?: boolean | null
          last_message_at?: string | null
          recipient_avatar?: string | null
          recipient_name?: string | null
          recipient_phone?: string | null
          recipient_telegram_id?: number | null
          recipient_username?: string | null
          unread_count?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "conversations_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "telegram_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      interaction_scheduler: {
        Row: {
          created_at: string
          id: string
          message_content: string
          receiver_account_id: string
          scheduled_at: string
          sender_account_id: string
          sent_at: string | null
          status: string
        }
        Insert: {
          created_at?: string
          id?: string
          message_content: string
          receiver_account_id: string
          scheduled_at?: string
          sender_account_id: string
          sent_at?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          id?: string
          message_content?: string
          receiver_account_id?: string
          scheduled_at?: string
          sender_account_id?: string
          sent_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "interaction_scheduler_receiver_account_id_fkey"
            columns: ["receiver_account_id"]
            isOneToOne: false
            referencedRelation: "telegram_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "interaction_scheduler_sender_account_id_fkey"
            columns: ["sender_account_id"]
            isOneToOne: false
            referencedRelation: "telegram_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      maturation_tasks: {
        Row: {
          account_id: string
          completed_at: string | null
          created_at: string | null
          description: string | null
          id: string
          scheduled_at: string | null
          status: string | null
          task_type: string
        }
        Insert: {
          account_id: string
          completed_at?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          scheduled_at?: string | null
          status?: string | null
          task_type: string
        }
        Update: {
          account_id?: string
          completed_at?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          scheduled_at?: string | null
          status?: string | null
          task_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "maturation_tasks_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "telegram_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          account_id: string
          campaign_recipient_id: string | null
          content: string
          conversation_id: string
          created_at: string | null
          delivered_at: string | null
          direction: Database["public"]["Enums"]["message_direction"]
          failed_reason: string | null
          id: string
          media_type: string | null
          media_url: string | null
          read_at: string | null
          status: Database["public"]["Enums"]["message_status"] | null
          telegram_message_id: number | null
        }
        Insert: {
          account_id: string
          campaign_recipient_id?: string | null
          content: string
          conversation_id: string
          created_at?: string | null
          delivered_at?: string | null
          direction: Database["public"]["Enums"]["message_direction"]
          failed_reason?: string | null
          id?: string
          media_type?: string | null
          media_url?: string | null
          read_at?: string | null
          status?: Database["public"]["Enums"]["message_status"] | null
          telegram_message_id?: number | null
        }
        Update: {
          account_id?: string
          campaign_recipient_id?: string | null
          content?: string
          conversation_id?: string
          created_at?: string | null
          delivered_at?: string | null
          direction?: Database["public"]["Enums"]["message_direction"]
          failed_reason?: string | null
          id?: string
          media_type?: string | null
          media_url?: string | null
          read_at?: string | null
          status?: Database["public"]["Enums"]["message_status"] | null
          telegram_message_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "telegram_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_campaign_recipient_id_fkey"
            columns: ["campaign_recipient_id"]
            isOneToOne: false
            referencedRelation: "campaign_recipients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      proxies: {
        Row: {
          assigned_account_id: string | null
          country: string | null
          created_at: string | null
          detected_country: string | null
          host: string
          id: string
          last_checked: string | null
          password: string | null
          port: number
          proxy_type: Database["public"]["Enums"]["proxy_type"] | null
          response_time: number | null
          status: Database["public"]["Enums"]["proxy_status"] | null
          username: string | null
        }
        Insert: {
          assigned_account_id?: string | null
          country?: string | null
          created_at?: string | null
          detected_country?: string | null
          host: string
          id?: string
          last_checked?: string | null
          password?: string | null
          port: number
          proxy_type?: Database["public"]["Enums"]["proxy_type"] | null
          response_time?: number | null
          status?: Database["public"]["Enums"]["proxy_status"] | null
          username?: string | null
        }
        Update: {
          assigned_account_id?: string | null
          country?: string | null
          created_at?: string | null
          detected_country?: string | null
          host?: string
          id?: string
          last_checked?: string | null
          password?: string | null
          port?: number
          proxy_type?: Database["public"]["Enums"]["proxy_type"] | null
          response_time?: number | null
          status?: Database["public"]["Enums"]["proxy_status"] | null
          username?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "proxies_assigned_account_id_fkey"
            columns: ["assigned_account_id"]
            isOneToOne: false
            referencedRelation: "telegram_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      scheduled_interactions: {
        Row: {
          created_at: string | null
          id: string
          message_content: string
          receiver_account_id: string
          scheduled_at: string | null
          sender_account_id: string
          sent_at: string | null
          status: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          message_content: string
          receiver_account_id: string
          scheduled_at?: string | null
          sender_account_id: string
          sent_at?: string | null
          status?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          message_content?: string
          receiver_account_id?: string
          scheduled_at?: string | null
          sender_account_id?: string
          sent_at?: string | null
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "scheduled_interactions_receiver_account_id_fkey"
            columns: ["receiver_account_id"]
            isOneToOne: false
            referencedRelation: "telegram_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_interactions_sender_account_id_fkey"
            columns: ["sender_account_id"]
            isOneToOne: false
            referencedRelation: "telegram_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      telegram_accounts: {
        Row: {
          api_credential_id: string | null
          api_hash: string | null
          api_id: string | null
          app_version: string | null
          avatar_url: string | null
          ban_reason: string | null
          created_at: string | null
          daily_limit: number | null
          device_model: string | null
          first_name: string | null
          geo_mismatch: boolean | null
          id: string
          interaction_pair_id: string | null
          lang_code: string | null
          last_active: string | null
          last_name: string | null
          last_spambot_check: string | null
          maturity_days: number | null
          maturity_score: number | null
          messages_sent_today: number | null
          phone_country: string | null
          phone_number: string
          proxy_id: string | null
          restricted_until: string | null
          session_data: string | null
          spambot_status: string | null
          status: Database["public"]["Enums"]["account_status"] | null
          system_lang_code: string | null
          system_version: string | null
          telegram_id: number | null
          username: string | null
          warmup_phase: number | null
          warmup_started_at: string | null
        }
        Insert: {
          api_credential_id?: string | null
          api_hash?: string | null
          api_id?: string | null
          app_version?: string | null
          avatar_url?: string | null
          ban_reason?: string | null
          created_at?: string | null
          daily_limit?: number | null
          device_model?: string | null
          first_name?: string | null
          geo_mismatch?: boolean | null
          id?: string
          interaction_pair_id?: string | null
          lang_code?: string | null
          last_active?: string | null
          last_name?: string | null
          last_spambot_check?: string | null
          maturity_days?: number | null
          maturity_score?: number | null
          messages_sent_today?: number | null
          phone_country?: string | null
          phone_number: string
          proxy_id?: string | null
          restricted_until?: string | null
          session_data?: string | null
          spambot_status?: string | null
          status?: Database["public"]["Enums"]["account_status"] | null
          system_lang_code?: string | null
          system_version?: string | null
          telegram_id?: number | null
          username?: string | null
          warmup_phase?: number | null
          warmup_started_at?: string | null
        }
        Update: {
          api_credential_id?: string | null
          api_hash?: string | null
          api_id?: string | null
          app_version?: string | null
          avatar_url?: string | null
          ban_reason?: string | null
          created_at?: string | null
          daily_limit?: number | null
          device_model?: string | null
          first_name?: string | null
          geo_mismatch?: boolean | null
          id?: string
          interaction_pair_id?: string | null
          lang_code?: string | null
          last_active?: string | null
          last_name?: string | null
          last_spambot_check?: string | null
          maturity_days?: number | null
          maturity_score?: number | null
          messages_sent_today?: number | null
          phone_country?: string | null
          phone_number?: string
          proxy_id?: string | null
          restricted_until?: string | null
          session_data?: string | null
          spambot_status?: string | null
          status?: Database["public"]["Enums"]["account_status"] | null
          system_lang_code?: string | null
          system_version?: string | null
          telegram_id?: number | null
          username?: string | null
          warmup_phase?: number | null
          warmup_started_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fk_proxy"
            columns: ["proxy_id"]
            isOneToOne: false
            referencedRelation: "proxies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "telegram_accounts_api_credential_id_fkey"
            columns: ["api_credential_id"]
            isOneToOne: false
            referencedRelation: "telegram_api_credentials"
            referencedColumns: ["id"]
          },
        ]
      }
      telegram_api_credentials: {
        Row: {
          accounts_count: number | null
          api_hash: string
          api_id: string
          client_type: string
          created_at: string | null
          id: string
          is_active: boolean | null
          name: string
        }
        Insert: {
          accounts_count?: number | null
          api_hash: string
          api_id: string
          client_type: string
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          name: string
        }
        Update: {
          accounts_count?: number | null
          api_hash?: string
          api_id?: string
          client_type?: string
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
        }
        Relationships: []
      }
      vps_connections: {
        Row: {
          api_key: string
          created_at: string | null
          id: string
          ip_address: string | null
          last_seen: string | null
          name: string
          status: string | null
        }
        Insert: {
          api_key: string
          created_at?: string | null
          id?: string
          ip_address?: string | null
          last_seen?: string | null
          name: string
          status?: string | null
        }
        Update: {
          api_key?: string
          created_at?: string | null
          id?: string
          ip_address?: string | null
          last_seen?: string | null
          name?: string
          status?: string | null
        }
        Relationships: []
      }
      warmup_schedule: {
        Row: {
          account_id: string
          channel_username: string | null
          completed_at: string | null
          created_at: string | null
          day_number: number
          id: string
          priority: number | null
          scheduled_at: string | null
          status: string | null
          task_description: string | null
          task_type: string
        }
        Insert: {
          account_id: string
          channel_username?: string | null
          completed_at?: string | null
          created_at?: string | null
          day_number: number
          id?: string
          priority?: number | null
          scheduled_at?: string | null
          status?: string | null
          task_description?: string | null
          task_type: string
        }
        Update: {
          account_id?: string
          channel_username?: string | null
          completed_at?: string | null
          created_at?: string | null
          day_number?: number
          id?: string
          priority?: number | null
          scheduled_at?: string | null
          status?: string | null
          task_description?: string | null
          task_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "warmup_schedule_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "telegram_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      increment_campaign_failed_count: {
        Args: { cid: string }
        Returns: undefined
      }
      increment_campaign_sent_count: {
        Args: { cid: string }
        Returns: undefined
      }
      reset_daily_message_counts: { Args: never; Returns: undefined }
    }
    Enums: {
      account_status:
        | "active"
        | "banned"
        | "restricted"
        | "disconnected"
        | "cooldown"
      campaign_status:
        | "draft"
        | "scheduled"
        | "running"
        | "paused"
        | "completed"
        | "failed"
      message_direction: "incoming" | "outgoing"
      message_status:
        | "pending"
        | "sending"
        | "sent"
        | "delivered"
        | "read"
        | "failed"
        | "cancelled"
      proxy_status: "active" | "inactive" | "error"
      proxy_type: "http" | "https" | "socks4" | "socks5"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      account_status: [
        "active",
        "banned",
        "restricted",
        "disconnected",
        "cooldown",
      ],
      campaign_status: [
        "draft",
        "scheduled",
        "running",
        "paused",
        "completed",
        "failed",
      ],
      message_direction: ["incoming", "outgoing"],
      message_status: [
        "pending",
        "sending",
        "sent",
        "delivered",
        "read",
        "failed",
        "cancelled",
      ],
      proxy_status: ["active", "inactive", "error"],
      proxy_type: ["http", "https", "socks4", "socks5"],
    },
  },
} as const
