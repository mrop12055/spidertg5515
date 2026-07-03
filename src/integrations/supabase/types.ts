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
    PostgrestVersion: "14.5"
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
          updated_at: string | null
        }
        Insert: {
          account_id: string
          completed_at?: string | null
          created_at?: string | null
          id?: string
          result?: string | null
          status?: string
          task_type?: string
          updated_at?: string | null
        }
        Update: {
          account_id?: string
          completed_at?: string | null
          created_at?: string | null
          id?: string
          result?: string | null
          status?: string
          task_type?: string
          updated_at?: string | null
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
      block_contact_tasks: {
        Row: {
          account_id: string
          action: string
          completed_at: string | null
          created_at: string
          id: string
          result: string | null
          status: string
          target_phone: string
          target_telegram_id: number | null
          target_username: string | null
        }
        Insert: {
          account_id: string
          action?: string
          completed_at?: string | null
          created_at?: string
          id?: string
          result?: string | null
          status?: string
          target_phone: string
          target_telegram_id?: number | null
          target_username?: string | null
        }
        Update: {
          account_id?: string
          action?: string
          completed_at?: string | null
          created_at?: string
          id?: string
          result?: string | null
          status?: string
          target_phone?: string
          target_telegram_id?: number | null
          target_username?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "block_contact_tasks_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "telegram_accounts"
            referencedColumns: ["id"]
          },
        ]
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
          api_credential_id: string | null
          campaign_id: string
          failed_account_ids: string[] | null
          failed_api_ids: string[] | null
          failed_reason: string | null
          id: string
          name: string | null
          phone_number: string
          retry_count: number | null
          scheduled_at: string | null
          seat_id: string | null
          sending_started_at: string | null
          sent_at: string | null
          sent_by_account_id: string | null
          status: string | null
        }
        Insert: {
          api_credential_id?: string | null
          campaign_id: string
          failed_account_ids?: string[] | null
          failed_api_ids?: string[] | null
          failed_reason?: string | null
          id?: string
          name?: string | null
          phone_number: string
          retry_count?: number | null
          scheduled_at?: string | null
          seat_id?: string | null
          sending_started_at?: string | null
          sent_at?: string | null
          sent_by_account_id?: string | null
          status?: string | null
        }
        Update: {
          api_credential_id?: string | null
          campaign_id?: string
          failed_account_ids?: string[] | null
          failed_api_ids?: string[] | null
          failed_reason?: string | null
          id?: string
          name?: string | null
          phone_number?: string
          retry_count?: number | null
          scheduled_at?: string | null
          seat_id?: string | null
          sending_started_at?: string | null
          sent_at?: string | null
          sent_by_account_id?: string | null
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "campaign_recipients_api_credential_id_fkey"
            columns: ["api_credential_id"]
            isOneToOne: false
            referencedRelation: "telegram_api_credentials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_recipients_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_recipients_seat_id_fkey"
            columns: ["seat_id"]
            isOneToOne: false
            referencedRelation: "seat_stats"
            referencedColumns: ["seat_id"]
          },
          {
            foreignKeyName: "campaign_recipients_seat_id_fkey"
            columns: ["seat_id"]
            isOneToOne: false
            referencedRelation: "seats"
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
          batch_size: number | null
          created_at: string | null
          failed_count: number | null
          id: string
          message_template: string
          name: string
          pending_count: number | null
          recipient_count: number | null
          reply_count: number | null
          scheduled_at: string | null
          seat_id: string | null
          sent_count: number | null
          status: Database["public"]["Enums"]["campaign_status"] | null
          updated_at: string | null
        }
        Insert: {
          batch_size?: number | null
          created_at?: string | null
          failed_count?: number | null
          id?: string
          message_template: string
          name: string
          pending_count?: number | null
          recipient_count?: number | null
          reply_count?: number | null
          scheduled_at?: string | null
          seat_id?: string | null
          sent_count?: number | null
          status?: Database["public"]["Enums"]["campaign_status"] | null
          updated_at?: string | null
        }
        Update: {
          batch_size?: number | null
          created_at?: string | null
          failed_count?: number | null
          id?: string
          message_template?: string
          name?: string
          pending_count?: number | null
          recipient_count?: number | null
          reply_count?: number | null
          scheduled_at?: string | null
          seat_id?: string | null
          sent_count?: number | null
          status?: Database["public"]["Enums"]["campaign_status"] | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_seat_id_fkey"
            columns: ["seat_id"]
            isOneToOne: false
            referencedRelation: "seat_stats"
            referencedColumns: ["seat_id"]
          },
          {
            foreignKeyName: "campaigns_seat_id_fkey"
            columns: ["seat_id"]
            isOneToOne: false
            referencedRelation: "seats"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_import_tasks: {
        Row: {
          account_id: string
          completed_at: string | null
          created_at: string
          current_account_id: string | null
          failed_account_ids: string[] | null
          id: string
          invalid_numbers: string[] | null
          phone_numbers: string[]
          remaining_numbers: string[] | null
          result: string | null
          status: string
          tag_id: string
          valid_numbers: string[] | null
        }
        Insert: {
          account_id: string
          completed_at?: string | null
          created_at?: string
          current_account_id?: string | null
          failed_account_ids?: string[] | null
          id?: string
          invalid_numbers?: string[] | null
          phone_numbers: string[]
          remaining_numbers?: string[] | null
          result?: string | null
          status?: string
          tag_id: string
          valid_numbers?: string[] | null
        }
        Update: {
          account_id?: string
          completed_at?: string | null
          created_at?: string
          current_account_id?: string | null
          failed_account_ids?: string[] | null
          id?: string
          invalid_numbers?: string[] | null
          phone_numbers?: string[]
          remaining_numbers?: string[] | null
          result?: string | null
          status?: string
          tag_id?: string
          valid_numbers?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "contact_import_tasks_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "telegram_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_import_tasks_current_account_id_fkey"
            columns: ["current_account_id"]
            isOneToOne: false
            referencedRelation: "telegram_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_import_tasks_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "contact_tags"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_tags: {
        Row: {
          created_at: string
          id: string
          name: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
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
          tag_id: string | null
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
          tag_id?: string | null
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
          tag_id?: string | null
          updated_at?: string | null
          used_at?: string | null
          used_in_campaign_id?: string | null
          username?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contacts_data_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "contact_tags"
            referencedColumns: ["id"]
          },
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
          campaign_id: string | null
          campaign_name: string | null
          created_at: string | null
          first_message_sent: boolean | null
          has_prior_contact: boolean | null
          has_reply: boolean | null
          id: string
          is_active: boolean | null
          is_hidden: boolean | null
          is_pinned: boolean | null
          last_message_at: string | null
          last_message_content: string | null
          last_message_direction: string | null
          recipient_avatar: string | null
          recipient_name: string | null
          recipient_phone: string | null
          recipient_telegram_id: number | null
          recipient_username: string | null
          seat_id: string | null
          unread_count: number | null
          updated_at: string | null
        }
        Insert: {
          account_id: string
          blocked_by_recipient?: boolean | null
          campaign_id?: string | null
          campaign_name?: string | null
          created_at?: string | null
          first_message_sent?: boolean | null
          has_prior_contact?: boolean | null
          has_reply?: boolean | null
          id?: string
          is_active?: boolean | null
          is_hidden?: boolean | null
          is_pinned?: boolean | null
          last_message_at?: string | null
          last_message_content?: string | null
          last_message_direction?: string | null
          recipient_avatar?: string | null
          recipient_name?: string | null
          recipient_phone?: string | null
          recipient_telegram_id?: number | null
          recipient_username?: string | null
          seat_id?: string | null
          unread_count?: number | null
          updated_at?: string | null
        }
        Update: {
          account_id?: string
          blocked_by_recipient?: boolean | null
          campaign_id?: string | null
          campaign_name?: string | null
          created_at?: string | null
          first_message_sent?: boolean | null
          has_prior_contact?: boolean | null
          has_reply?: boolean | null
          id?: string
          is_active?: boolean | null
          is_hidden?: boolean | null
          is_pinned?: boolean | null
          last_message_at?: string | null
          last_message_content?: string | null
          last_message_direction?: string | null
          recipient_avatar?: string | null
          recipient_name?: string | null
          recipient_phone?: string | null
          recipient_telegram_id?: number | null
          recipient_username?: string | null
          seat_id?: string | null
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
          {
            foreignKeyName: "conversations_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_seat_id_fkey"
            columns: ["seat_id"]
            isOneToOne: false
            referencedRelation: "seat_stats"
            referencedColumns: ["seat_id"]
          },
          {
            foreignKeyName: "conversations_seat_id_fkey"
            columns: ["seat_id"]
            isOneToOne: false
            referencedRelation: "seats"
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
      lifetime_stats: {
        Row: {
          id: string
          stat_key: string
          stat_value: number
          updated_at: string | null
        }
        Insert: {
          id?: string
          stat_key: string
          stat_value?: number
          updated_at?: string | null
        }
        Update: {
          id?: string
          stat_key?: string
          stat_value?: number
          updated_at?: string | null
        }
        Relationships: []
      }
      material_data: {
        Row: {
          created_at: string | null
          id: string
          phone_number: string | null
          tag_id: string
          username: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          phone_number?: string | null
          tag_id: string
          username?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          phone_number?: string | null
          tag_id?: string
          username?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "material_data_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "material_tags"
            referencedColumns: ["id"]
          },
        ]
      }
      material_names: {
        Row: {
          created_at: string | null
          first_name: string
          id: string
          last_name: string | null
          tag_id: string
        }
        Insert: {
          created_at?: string | null
          first_name: string
          id?: string
          last_name?: string | null
          tag_id: string
        }
        Update: {
          created_at?: string | null
          first_name?: string
          id?: string
          last_name?: string | null
          tag_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "material_names_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "material_tags"
            referencedColumns: ["id"]
          },
        ]
      }
      material_pictures: {
        Row: {
          created_at: string | null
          file_name: string
          file_url: string
          id: string
          tag_id: string
        }
        Insert: {
          created_at?: string | null
          file_name: string
          file_url: string
          id?: string
          tag_id: string
        }
        Update: {
          created_at?: string | null
          file_name?: string
          file_url?: string
          id?: string
          tag_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "material_pictures_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "material_tags"
            referencedColumns: ["id"]
          },
        ]
      }
      material_tags: {
        Row: {
          created_at: string | null
          id: string
          item_count: number | null
          name: string
          type: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          item_count?: number | null
          name: string
          type: string
        }
        Update: {
          created_at?: string | null
          id?: string
          item_count?: number | null
          name?: string
          type?: string
        }
        Relationships: []
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
          api_credential_id: string | null
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
          priority: number | null
          read_at: string | null
          status: Database["public"]["Enums"]["message_status"] | null
          telegram_message_id: number | null
        }
        Insert: {
          account_id: string
          api_credential_id?: string | null
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
          priority?: number | null
          read_at?: string | null
          status?: Database["public"]["Enums"]["message_status"] | null
          telegram_message_id?: number | null
        }
        Update: {
          account_id?: string
          api_credential_id?: string | null
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
          priority?: number | null
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
            foreignKeyName: "messages_api_credential_id_fkey"
            columns: ["api_credential_id"]
            isOneToOne: false
            referencedRelation: "telegram_api_credentials"
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
      proxy_errors: {
        Row: {
          created_at: string
          error_message: string | null
          error_type: string | null
          id: string
          proxy_id: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          error_type?: string | null
          id?: string
          proxy_id: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          error_type?: string | null
          id?: string
          proxy_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "proxy_errors_proxy_id_fkey"
            columns: ["proxy_id"]
            isOneToOne: false
            referencedRelation: "proxies"
            referencedColumns: ["id"]
          },
        ]
      }
      runner_heartbeats: {
        Row: {
          created_at: string
          id: string
          ip_address: string | null
          last_offline_at: string | null
          last_seen: string
          runner_name: string
          server_id: string | null
          status: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          ip_address?: string | null
          last_offline_at?: string | null
          last_seen?: string
          runner_name: string
          server_id?: string | null
          status?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          ip_address?: string | null
          last_offline_at?: string | null
          last_seen?: string
          runner_name?: string
          server_id?: string | null
          status?: string | null
        }
        Relationships: []
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
      seats: {
        Row: {
          access_token: string
          created_at: string | null
          id: string
          is_active: boolean | null
          name: string
          updated_at: string | null
        }
        Insert: {
          access_token?: string
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          updated_at?: string | null
        }
        Update: {
          access_token?: string
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      telegram_accounts: {
        Row: {
          api_credential_id: string | null
          api_hash: string | null
          api_id: string | null
          app_version: string | null
          auto_disabled: boolean | null
          avatar_url: string | null
          ban_reason: string | null
          build_id: string | null
          cooldown_until: string | null
          created_at: string | null
          daily_limit: number | null
          device_model: string | null
          disabled_reason: string | null
          failure_count: number | null
          first_name: string | null
          geo_mismatch: boolean | null
          id: string
          interaction_pair_id: string | null
          lang_code: string | null
          last_active: string | null
          last_campaign_send_at: string | null
          last_name: string | null
          last_spambot_check: string | null
          locked_at: string | null
          locked_by: string | null
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
          success_count: number | null
          success_rate: number | null
          system_lang_code: string | null
          system_version: string | null
          tags: string[] | null
          telegram_id: number | null
          two_fa_password: string | null
          username: string | null
          warmup_pair_id: string | null
          warmup_phase: number | null
          warmup_started_at: string | null
          warmup_unpaired: boolean | null
        }
        Insert: {
          api_credential_id?: string | null
          api_hash?: string | null
          api_id?: string | null
          app_version?: string | null
          auto_disabled?: boolean | null
          avatar_url?: string | null
          ban_reason?: string | null
          build_id?: string | null
          cooldown_until?: string | null
          created_at?: string | null
          daily_limit?: number | null
          device_model?: string | null
          disabled_reason?: string | null
          failure_count?: number | null
          first_name?: string | null
          geo_mismatch?: boolean | null
          id?: string
          interaction_pair_id?: string | null
          lang_code?: string | null
          last_active?: string | null
          last_campaign_send_at?: string | null
          last_name?: string | null
          last_spambot_check?: string | null
          locked_at?: string | null
          locked_by?: string | null
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
          success_count?: number | null
          success_rate?: number | null
          system_lang_code?: string | null
          system_version?: string | null
          tags?: string[] | null
          telegram_id?: number | null
          two_fa_password?: string | null
          username?: string | null
          warmup_pair_id?: string | null
          warmup_phase?: number | null
          warmup_started_at?: string | null
          warmup_unpaired?: boolean | null
        }
        Update: {
          api_credential_id?: string | null
          api_hash?: string | null
          api_id?: string | null
          app_version?: string | null
          auto_disabled?: boolean | null
          avatar_url?: string | null
          ban_reason?: string | null
          build_id?: string | null
          cooldown_until?: string | null
          created_at?: string | null
          daily_limit?: number | null
          device_model?: string | null
          disabled_reason?: string | null
          failure_count?: number | null
          first_name?: string | null
          geo_mismatch?: boolean | null
          id?: string
          interaction_pair_id?: string | null
          lang_code?: string | null
          last_active?: string | null
          last_campaign_send_at?: string | null
          last_name?: string | null
          last_spambot_check?: string | null
          locked_at?: string | null
          locked_by?: string | null
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
          success_count?: number | null
          success_rate?: number | null
          system_lang_code?: string | null
          system_version?: string | null
          tags?: string[] | null
          telegram_id?: number | null
          two_fa_password?: string | null
          username?: string | null
          warmup_pair_id?: string | null
          warmup_phase?: number | null
          warmup_started_at?: string | null
          warmup_unpaired?: boolean | null
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
          {
            foreignKeyName: "telegram_accounts_warmup_pair_id_fkey"
            columns: ["warmup_pair_id"]
            isOneToOne: false
            referencedRelation: "telegram_accounts"
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
          daily_usage: number | null
          daily_usage_reset_at: string | null
          id: string
          is_active: boolean | null
          last_used_at: string | null
          last_validated_at: string | null
          name: string
          usage_count: number | null
          validation_error: string | null
        }
        Insert: {
          accounts_count?: number | null
          api_hash: string
          api_id: string
          client_type: string
          created_at?: string | null
          daily_usage?: number | null
          daily_usage_reset_at?: string | null
          id?: string
          is_active?: boolean | null
          last_used_at?: string | null
          last_validated_at?: string | null
          name: string
          usage_count?: number | null
          validation_error?: string | null
        }
        Update: {
          accounts_count?: number | null
          api_hash?: string
          api_id?: string
          client_type?: string
          created_at?: string | null
          daily_usage?: number | null
          daily_usage_reset_at?: string | null
          id?: string
          is_active?: boolean | null
          last_used_at?: string | null
          last_validated_at?: string | null
          name?: string
          usage_count?: number | null
          validation_error?: string | null
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string | null
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      vps_commands: {
        Row: {
          command: string
          created_at: string
          id: string
          processed_at: string | null
          result: string | null
          status: string
          target_runner: string | null
          vps_id: string | null
        }
        Insert: {
          command: string
          created_at?: string
          id?: string
          processed_at?: string | null
          result?: string | null
          status?: string
          target_runner?: string | null
          vps_id?: string | null
        }
        Update: {
          command?: string
          created_at?: string
          id?: string
          processed_at?: string | null
          result?: string | null
          status?: string
          target_runner?: string | null
          vps_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vps_commands_vps_id_fkey"
            columns: ["vps_id"]
            isOneToOne: false
            referencedRelation: "vps_connections"
            referencedColumns: ["id"]
          },
        ]
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
      vps_logs: {
        Row: {
          created_at: string
          id: string
          log_level: string | null
          message: string
          runner_name: string
          vps_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          log_level?: string | null
          message: string
          runner_name: string
          vps_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          log_level?: string | null
          message?: string
          runner_name?: string
          vps_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vps_logs_vps_id_fkey"
            columns: ["vps_id"]
            isOneToOne: false
            referencedRelation: "vps_connections"
            referencedColumns: ["id"]
          },
        ]
      }
      warmup_errors: {
        Row: {
          account_id: string | null
          created_at: string | null
          error_message: string
          error_type: string | null
          id: string
          pair_id: string | null
          session_id: string | null
        }
        Insert: {
          account_id?: string | null
          created_at?: string | null
          error_message: string
          error_type?: string | null
          id?: string
          pair_id?: string | null
          session_id?: string | null
        }
        Update: {
          account_id?: string | null
          created_at?: string | null
          error_message?: string
          error_type?: string | null
          id?: string
          pair_id?: string | null
          session_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "warmup_errors_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "telegram_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "warmup_errors_pair_id_fkey"
            columns: ["pair_id"]
            isOneToOne: false
            referencedRelation: "warmup_pairs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "warmup_errors_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "warmup_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      warmup_message_templates: {
        Row: {
          category: string | null
          created_at: string | null
          id: string
          is_question: boolean | null
          message_text: string
          sender_position: string
          sequence_order: number
        }
        Insert: {
          category?: string | null
          created_at?: string | null
          id?: string
          is_question?: boolean | null
          message_text: string
          sender_position: string
          sequence_order: number
        }
        Update: {
          category?: string | null
          created_at?: string | null
          id?: string
          is_question?: boolean | null
          message_text?: string
          sender_position?: string
          sequence_order?: number
        }
        Relationships: []
      }
      warmup_messages: {
        Row: {
          claimed_at: string | null
          claimed_by: string | null
          created_at: string | null
          error_message: string | null
          id: string
          is_cycle_last: boolean | null
          message_content: string
          message_type: string | null
          pair_id: string
          receiver_account_id: string
          reply_delay_seconds: number | null
          scheduled_at: string
          sender_account_id: string
          sent_at: string | null
          status: string | null
          template_id: string | null
        }
        Insert: {
          claimed_at?: string | null
          claimed_by?: string | null
          created_at?: string | null
          error_message?: string | null
          id?: string
          is_cycle_last?: boolean | null
          message_content: string
          message_type?: string | null
          pair_id: string
          receiver_account_id: string
          reply_delay_seconds?: number | null
          scheduled_at: string
          sender_account_id: string
          sent_at?: string | null
          status?: string | null
          template_id?: string | null
        }
        Update: {
          claimed_at?: string | null
          claimed_by?: string | null
          created_at?: string | null
          error_message?: string | null
          id?: string
          is_cycle_last?: boolean | null
          message_content?: string
          message_type?: string | null
          pair_id?: string
          receiver_account_id?: string
          reply_delay_seconds?: number | null
          scheduled_at?: string
          sender_account_id?: string
          sent_at?: string | null
          status?: string | null
          template_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "warmup_messages_pair_id_fkey"
            columns: ["pair_id"]
            isOneToOne: false
            referencedRelation: "warmup_pairs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "warmup_messages_receiver_account_id_fkey"
            columns: ["receiver_account_id"]
            isOneToOne: false
            referencedRelation: "telegram_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "warmup_messages_sender_account_id_fkey"
            columns: ["sender_account_id"]
            isOneToOne: false
            referencedRelation: "telegram_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "warmup_messages_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "warmup_message_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      warmup_pairs: {
        Row: {
          account_a_id: string
          account_b_id: string
          contacts_exchanged: boolean | null
          created_at: string | null
          cycles_completed_today: number | null
          failed_reason: string | null
          id: string
          last_category_used: string | null
          last_cycle_date: string | null
          last_message_at: string | null
          last_template_id: string | null
          messages_exchanged: number | null
          session_id: string
          status: string | null
          used_categories: string[] | null
        }
        Insert: {
          account_a_id: string
          account_b_id: string
          contacts_exchanged?: boolean | null
          created_at?: string | null
          cycles_completed_today?: number | null
          failed_reason?: string | null
          id?: string
          last_category_used?: string | null
          last_cycle_date?: string | null
          last_message_at?: string | null
          last_template_id?: string | null
          messages_exchanged?: number | null
          session_id: string
          status?: string | null
          used_categories?: string[] | null
        }
        Update: {
          account_a_id?: string
          account_b_id?: string
          contacts_exchanged?: boolean | null
          created_at?: string | null
          cycles_completed_today?: number | null
          failed_reason?: string | null
          id?: string
          last_category_used?: string | null
          last_cycle_date?: string | null
          last_message_at?: string | null
          last_template_id?: string | null
          messages_exchanged?: number | null
          session_id?: string
          status?: string | null
          used_categories?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "warmup_pairs_account_a_id_fkey"
            columns: ["account_a_id"]
            isOneToOne: false
            referencedRelation: "telegram_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "warmup_pairs_account_b_id_fkey"
            columns: ["account_b_id"]
            isOneToOne: false
            referencedRelation: "telegram_accounts"
            referencedColumns: ["id"]
          },
        ]
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
      warmup_sessions: {
        Row: {
          created_at: string | null
          id: string
          messages_per_pair_max: number | null
          messages_per_pair_min: number | null
          started_at: string | null
          status: string | null
          stopped_at: string | null
          total_pairs: number | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          messages_per_pair_max?: number | null
          messages_per_pair_min?: number | null
          started_at?: string | null
          status?: string | null
          stopped_at?: string | null
          total_pairs?: number | null
        }
        Update: {
          created_at?: string | null
          id?: string
          messages_per_pair_max?: number | null
          messages_per_pair_min?: number | null
          started_at?: string | null
          status?: string | null
          stopped_at?: string | null
          total_pairs?: number | null
        }
        Relationships: []
      }
    }
    Views: {
      seat_stats: {
        Row: {
          conversations_started: number | null
          messages_read: number | null
          messages_sent_today: number | null
          responses_received: number | null
          responses_today: number | null
          seat_id: string | null
          seat_name: string | null
          total_conversations: number | null
        }
        Relationships: []
      }
      system_health: {
        Row: {
          active_accounts: number | null
          active_proxies: number | null
          checked_at: string | null
          pending_account_tasks: number | null
          pending_block_tasks: number | null
          pending_import_tasks: number | null
          pending_messages: number | null
          pending_recipients: number | null
          stuck_messages: number | null
          total_conversations: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      batch_increment_success: { Args: { updates: Json }; Returns: undefined }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      increment_account_failure: {
        Args: { acc_id: string }
        Returns: undefined
      }
      increment_account_success: {
        Args: { acc_id: string }
        Returns: undefined
      }
      increment_api_usage: { Args: { p_api_id: string }; Returns: undefined }
      increment_campaign_failed_count: {
        Args: { cid: string }
        Returns: undefined
      }
      increment_campaign_sent_count: {
        Args: { cid: string }
        Returns: undefined
      }
      increment_lifetime_stat: {
        Args: { p_increment?: number; p_stat_key: string }
        Returns: undefined
      }
      increment_messages_sent_today: {
        Args: { acc_id: string }
        Returns: undefined
      }
      increment_unread_count: { Args: { conv_id: string }; Returns: undefined }
      is_admin: { Args: never; Returns: boolean }
      is_authenticated: { Args: never; Returns: boolean }
      reset_daily_message_counts: { Args: never; Returns: undefined }
      sync_campaign_counters: { Args: { cid: string }; Returns: undefined }
      sync_messages_sent_today: { Args: never; Returns: undefined }
    }
    Enums: {
      account_status:
        | "active"
        | "banned"
        | "restricted"
        | "disconnected"
        | "cooldown"
        | "frozen"
      app_role: "admin" | "user"
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
        "frozen",
      ],
      app_role: ["admin", "user"],
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
