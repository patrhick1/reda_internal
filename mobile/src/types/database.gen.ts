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
      address_match_log: {
        Row: {
          confidence: string | null
          corrected_by_user_id: string | null
          delivery_id: string | null
          gemini_response: Json | null
          id: string
          maps_response: Json | null
          matched_at: string
          matched_location_id: string | null
          override_location_id: string | null
          raw_address: string
          was_overridden: boolean
        }
        Insert: {
          confidence?: string | null
          corrected_by_user_id?: string | null
          delivery_id?: string | null
          gemini_response?: Json | null
          id?: string
          maps_response?: Json | null
          matched_at?: string
          matched_location_id?: string | null
          override_location_id?: string | null
          raw_address: string
          was_overridden?: boolean
        }
        Update: {
          confidence?: string | null
          corrected_by_user_id?: string | null
          delivery_id?: string | null
          gemini_response?: Json | null
          id?: string
          maps_response?: Json | null
          matched_at?: string
          matched_location_id?: string | null
          override_location_id?: string | null
          raw_address?: string
          was_overridden?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "address_match_log_corrected_by_user_id_fkey"
            columns: ["corrected_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "address_match_log_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "available_orders_safe"
            referencedColumns: ["delivery_id"]
          },
          {
            foreignKeyName: "address_match_log_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "address_match_log_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries_admin"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "address_match_log_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "address_match_log_matched_location_id_fkey"
            columns: ["matched_location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "address_match_log_override_location_id_fkey"
            columns: ["override_location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_location_preferences: {
        Row: {
          agent_profile_id: string
          created_at: string
          id: string
          location_id: string
          priority_score: number
        }
        Insert: {
          agent_profile_id: string
          created_at?: string
          id?: string
          location_id: string
          priority_score?: number
        }
        Update: {
          agent_profile_id?: string
          created_at?: string
          id?: string
          location_id?: string
          priority_score?: number
        }
        Relationships: [
          {
            foreignKeyName: "agent_location_preferences_agent_profile_id_fkey"
            columns: ["agent_profile_id"]
            isOneToOne: false
            referencedRelation: "agent_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_location_preferences_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_locations: {
        Row: {
          agent_id: string
          created_at: string
          created_by_user_id: string | null
          kind: string
          location_id: string
        }
        Insert: {
          agent_id: string
          created_at?: string
          created_by_user_id?: string | null
          kind?: string
          location_id: string
        }
        Update: {
          agent_id?: string
          created_at?: string
          created_by_user_id?: string | null
          kind?: string
          location_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_locations_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_locations_created_by_user_id_fkey"
            columns: ["created_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_locations_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_profiles: {
        Row: {
          created_at: string
          delivery_capacity: number
          id: string
          notes: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          delivery_capacity?: number
          id?: string
          notes?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          delivery_capacity?: number
          id?: string
          notes?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_profiles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_config: {
        Row: {
          key: string
          updated_at: string
          updated_by_user_id: string | null
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          updated_by_user_id?: string | null
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          updated_by_user_id?: string | null
          value?: Json
        }
        Relationships: [
          {
            foreignKeyName: "ai_config_updated_by_user_id_fkey"
            columns: ["updated_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          changed_at: string
          changed_by_user_id: string
          entity_id: string
          entity_type: string
          field_name: string
          id: string
          new_value: string | null
          old_value: string | null
          reason: string | null
        }
        Insert: {
          changed_at?: string
          changed_by_user_id: string
          entity_id: string
          entity_type: string
          field_name: string
          id?: string
          new_value?: string | null
          old_value?: string | null
          reason?: string | null
        }
        Update: {
          changed_at?: string
          changed_by_user_id?: string
          entity_id?: string
          entity_type?: string
          field_name?: string
          id?: string
          new_value?: string | null
          old_value?: string | null
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_changed_by_user_id_fkey"
            columns: ["changed_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      bot_inbound_messages: {
        Row: {
          delivery_id: string | null
          error_text: string | null
          id: string
          parse_result: Json | null
          processed_at: string | null
          raw_payload: Json
          raw_text: string | null
          received_at: string
          remote_jid: string | null
          status: string
          wasender_message_id: string
        }
        Insert: {
          delivery_id?: string | null
          error_text?: string | null
          id?: string
          parse_result?: Json | null
          processed_at?: string | null
          raw_payload: Json
          raw_text?: string | null
          received_at?: string
          remote_jid?: string | null
          status?: string
          wasender_message_id: string
        }
        Update: {
          delivery_id?: string | null
          error_text?: string | null
          id?: string
          parse_result?: Json | null
          processed_at?: string | null
          raw_payload?: Json
          raw_text?: string | null
          received_at?: string
          remote_jid?: string | null
          status?: string
          wasender_message_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bot_inbound_messages_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "available_orders_safe"
            referencedColumns: ["delivery_id"]
          },
          {
            foreignKeyName: "bot_inbound_messages_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bot_inbound_messages_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries_admin"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bot_inbound_messages_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      calls: {
        Row: {
          accepted_device_uuid: string | null
          agora_channel: string
          callee_audience: string
          callee_id: string | null
          caller_device_uuid: string
          caller_id: string
          client_uuid: string | null
          created_at: string
          duration_seconds: number | null
          ended_at: string | null
          id: string
          last_token_issued_at: string | null
          related_delivery_id: string | null
          ringing_until: string
          started_at: string | null
          status: string
        }
        Insert: {
          accepted_device_uuid?: string | null
          agora_channel: string
          callee_audience?: string
          callee_id?: string | null
          caller_device_uuid: string
          caller_id: string
          client_uuid?: string | null
          created_at?: string
          duration_seconds?: number | null
          ended_at?: string | null
          id?: string
          last_token_issued_at?: string | null
          related_delivery_id?: string | null
          ringing_until: string
          started_at?: string | null
          status: string
        }
        Update: {
          accepted_device_uuid?: string | null
          agora_channel?: string
          callee_audience?: string
          callee_id?: string | null
          caller_device_uuid?: string
          caller_id?: string
          client_uuid?: string | null
          created_at?: string
          duration_seconds?: number | null
          ended_at?: string | null
          id?: string
          last_token_issued_at?: string | null
          related_delivery_id?: string | null
          ringing_until?: string
          started_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "calls_callee_id_fkey"
            columns: ["callee_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calls_caller_id_fkey"
            columns: ["caller_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calls_related_delivery_id_fkey"
            columns: ["related_delivery_id"]
            isOneToOne: false
            referencedRelation: "available_orders_safe"
            referencedColumns: ["delivery_id"]
          },
          {
            foreignKeyName: "calls_related_delivery_id_fkey"
            columns: ["related_delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calls_related_delivery_id_fkey"
            columns: ["related_delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries_admin"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calls_related_delivery_id_fkey"
            columns: ["related_delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          auto_cancel_soft_fails: boolean
          bank_account_name: string | null
          bank_account_number: string | null
          bank_name: string | null
          contact_email: string | null
          contact_phone: string | null
          created_at: string
          id: string
          is_active: boolean
          max_charge_per_delivery: number | null
          name: string
          notes: string | null
        }
        Insert: {
          auto_cancel_soft_fails?: boolean
          bank_account_name?: string | null
          bank_account_number?: string | null
          bank_name?: string | null
          contact_email?: string | null
          contact_phone?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          max_charge_per_delivery?: number | null
          name: string
          notes?: string | null
        }
        Update: {
          auto_cancel_soft_fails?: boolean
          bank_account_name?: string | null
          bank_account_number?: string | null
          bank_name?: string | null
          contact_email?: string | null
          contact_phone?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          max_charge_per_delivery?: number | null
          name?: string
          notes?: string | null
        }
        Relationships: []
      }
      current_stock_parity_baseline: {
        Row: {
          agent_id: string | null
          product_catalog_id: string | null
          quantity_on_hand: number | null
        }
        Insert: {
          agent_id?: string | null
          product_catalog_id?: string | null
          quantity_on_hand?: number | null
        }
        Update: {
          agent_id?: string | null
          product_catalog_id?: string | null
          quantity_on_hand?: number | null
        }
        Relationships: []
      }
      deliveries: {
        Row: {
          agent_payment_snapshot: number | null
          assigned_agent_id: string | null
          assigned_at: string | null
          bot_raw_message: string | null
          cash_pos_fee_snapshot: number | null
          charged_snapshot: number | null
          client_id: string
          created_at: string
          created_by_user_id: string | null
          created_date: string
          created_via: string
          current_status: string
          customer_name: string
          customer_phone: string
          customer_phone_alt: string | null
          customer_phone_normalized: string | null
          customer_price: number
          deleted_at: string | null
          delivery_instructions: string | null
          id: string
          items_fingerprint: string | null
          location_id: string | null
          paid: number | null
          parent_delivery_id: string | null
          payment_method: string | null
          product_catalog_id: string
          quantity_delivered: number | null
          quantity_ordered: number
          raw_address: string
          rolled_from_date: string | null
          rolled_from_status: string | null
          rollover_count: number
          scheduled_date: string
          text_fingerprint: string | null
          updated_at: string
        }
        Insert: {
          agent_payment_snapshot?: number | null
          assigned_agent_id?: string | null
          assigned_at?: string | null
          bot_raw_message?: string | null
          cash_pos_fee_snapshot?: number | null
          charged_snapshot?: number | null
          client_id: string
          created_at?: string
          created_by_user_id?: string | null
          created_date?: string
          created_via?: string
          current_status?: string
          customer_name: string
          customer_phone: string
          customer_phone_alt?: string | null
          customer_phone_normalized?: string | null
          customer_price: number
          deleted_at?: string | null
          delivery_instructions?: string | null
          id?: string
          items_fingerprint?: string | null
          location_id?: string | null
          paid?: number | null
          parent_delivery_id?: string | null
          payment_method?: string | null
          product_catalog_id: string
          quantity_delivered?: number | null
          quantity_ordered: number
          raw_address: string
          rolled_from_date?: string | null
          rolled_from_status?: string | null
          rollover_count?: number
          scheduled_date?: string
          text_fingerprint?: string | null
          updated_at?: string
        }
        Update: {
          agent_payment_snapshot?: number | null
          assigned_agent_id?: string | null
          assigned_at?: string | null
          bot_raw_message?: string | null
          cash_pos_fee_snapshot?: number | null
          charged_snapshot?: number | null
          client_id?: string
          created_at?: string
          created_by_user_id?: string | null
          created_date?: string
          created_via?: string
          current_status?: string
          customer_name?: string
          customer_phone?: string
          customer_phone_alt?: string | null
          customer_phone_normalized?: string | null
          customer_price?: number
          deleted_at?: string | null
          delivery_instructions?: string | null
          id?: string
          items_fingerprint?: string | null
          location_id?: string | null
          paid?: number | null
          parent_delivery_id?: string | null
          payment_method?: string | null
          product_catalog_id?: string
          quantity_delivered?: number | null
          quantity_ordered?: number
          raw_address?: string
          rolled_from_date?: string | null
          rolled_from_status?: string | null
          rollover_count?: number
          scheduled_date?: string
          text_fingerprint?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "deliveries_assigned_agent_id_fkey"
            columns: ["assigned_agent_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_created_by_user_id_fkey"
            columns: ["created_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_current_status_fkey"
            columns: ["current_status"]
            isOneToOne: false
            referencedRelation: "delivery_status_defs"
            referencedColumns: ["status"]
          },
          {
            foreignKeyName: "deliveries_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_parent_delivery_id_fkey"
            columns: ["parent_delivery_id"]
            isOneToOne: false
            referencedRelation: "available_orders_safe"
            referencedColumns: ["delivery_id"]
          },
          {
            foreignKeyName: "deliveries_parent_delivery_id_fkey"
            columns: ["parent_delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_parent_delivery_id_fkey"
            columns: ["parent_delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries_admin"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_parent_delivery_id_fkey"
            columns: ["parent_delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_product_catalog_id_fkey"
            columns: ["product_catalog_id"]
            isOneToOne: false
            referencedRelation: "product_catalog"
            referencedColumns: ["id"]
          },
        ]
      }
      delivery_client_notifications: {
        Row: {
          delivery_id: string
          notified_at: string
          notified_by_user_id: string
          status_history_id: string
        }
        Insert: {
          delivery_id: string
          notified_at?: string
          notified_by_user_id: string
          status_history_id: string
        }
        Update: {
          delivery_id?: string
          notified_at?: string
          notified_by_user_id?: string
          status_history_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "delivery_client_notifications_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "available_orders_safe"
            referencedColumns: ["delivery_id"]
          },
          {
            foreignKeyName: "delivery_client_notifications_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_client_notifications_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries_admin"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_client_notifications_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_client_notifications_notified_by_user_id_fkey"
            columns: ["notified_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_client_notifications_status_history_id_fkey"
            columns: ["status_history_id"]
            isOneToOne: true
            referencedRelation: "deliveries_admin"
            referencedColumns: ["latest_history_id"]
          },
          {
            foreignKeyName: "delivery_client_notifications_status_history_id_fkey"
            columns: ["status_history_id"]
            isOneToOne: true
            referencedRelation: "deliveries_safe"
            referencedColumns: ["latest_history_id"]
          },
          {
            foreignKeyName: "delivery_client_notifications_status_history_id_fkey"
            columns: ["status_history_id"]
            isOneToOne: true
            referencedRelation: "delivery_status_history"
            referencedColumns: ["id"]
          },
        ]
      }
      delivery_followups: {
        Row: {
          claimed_at: string
          delivery_id: string
          user_id: string
        }
        Insert: {
          claimed_at?: string
          delivery_id: string
          user_id: string
        }
        Update: {
          claimed_at?: string
          delivery_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "delivery_followups_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: true
            referencedRelation: "available_orders_safe"
            referencedColumns: ["delivery_id"]
          },
          {
            foreignKeyName: "delivery_followups_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: true
            referencedRelation: "deliveries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_followups_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: true
            referencedRelation: "deliveries_admin"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_followups_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: true
            referencedRelation: "deliveries_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_followups_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      delivery_items: {
        Row: {
          created_at: string
          customer_price: number | null
          delivery_id: string
          id: string
          product_catalog_id: string
          quantity_delivered: number | null
          quantity_ordered: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          customer_price?: number | null
          delivery_id: string
          id?: string
          product_catalog_id: string
          quantity_delivered?: number | null
          quantity_ordered: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          customer_price?: number | null
          delivery_id?: string
          id?: string
          product_catalog_id?: string
          quantity_delivered?: number | null
          quantity_ordered?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "delivery_items_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "available_orders_safe"
            referencedColumns: ["delivery_id"]
          },
          {
            foreignKeyName: "delivery_items_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_items_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries_admin"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_items_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_items_product_catalog_id_fkey"
            columns: ["product_catalog_id"]
            isOneToOne: false
            referencedRelation: "product_catalog"
            referencedColumns: ["id"]
          },
        ]
      }
      delivery_location_changes: {
        Row: {
          client_uuid: string
          created_at: string
          decided_at: string | null
          decided_by_user_id: string | null
          delivery_id: string
          from_agent_payment: number | null
          from_charged: number | null
          from_location_id: string | null
          id: string
          reason: string
          requested_by_agent_id: string
          state: string
          to_agent_payment: number
          to_charged: number
          to_location_id: string
        }
        Insert: {
          client_uuid: string
          created_at?: string
          decided_at?: string | null
          decided_by_user_id?: string | null
          delivery_id: string
          from_agent_payment?: number | null
          from_charged?: number | null
          from_location_id?: string | null
          id?: string
          reason: string
          requested_by_agent_id: string
          state?: string
          to_agent_payment: number
          to_charged: number
          to_location_id: string
        }
        Update: {
          client_uuid?: string
          created_at?: string
          decided_at?: string | null
          decided_by_user_id?: string | null
          delivery_id?: string
          from_agent_payment?: number | null
          from_charged?: number | null
          from_location_id?: string | null
          id?: string
          reason?: string
          requested_by_agent_id?: string
          state?: string
          to_agent_payment?: number
          to_charged?: number
          to_location_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "delivery_location_changes_decided_by_user_id_fkey"
            columns: ["decided_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_location_changes_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "available_orders_safe"
            referencedColumns: ["delivery_id"]
          },
          {
            foreignKeyName: "delivery_location_changes_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_location_changes_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries_admin"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_location_changes_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_location_changes_from_location_id_fkey"
            columns: ["from_location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_location_changes_requested_by_agent_id_fkey"
            columns: ["requested_by_agent_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_location_changes_to_location_id_fkey"
            columns: ["to_location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      delivery_messages: {
        Row: {
          author_id: string
          author_role: string
          client_uuid: string | null
          created_at: string
          delivery_id: string
          id: string
          issue_type: string | null
          note: string | null
          read_at: string | null
        }
        Insert: {
          author_id: string
          author_role: string
          client_uuid?: string | null
          created_at?: string
          delivery_id: string
          id?: string
          issue_type?: string | null
          note?: string | null
          read_at?: string | null
        }
        Update: {
          author_id?: string
          author_role?: string
          client_uuid?: string | null
          created_at?: string
          delivery_id?: string
          id?: string
          issue_type?: string | null
          note?: string | null
          read_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "delivery_messages_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_messages_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "available_orders_safe"
            referencedColumns: ["delivery_id"]
          },
          {
            foreignKeyName: "delivery_messages_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_messages_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries_admin"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_messages_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries_safe"
            referencedColumns: ["id"]
          },
        ]
      }
      delivery_status_defs: {
        Row: {
          category: string
          label: string
          needs_followup: boolean
          sort_order: number
          status: string
        }
        Insert: {
          category: string
          label: string
          needs_followup?: boolean
          sort_order?: number
          status: string
        }
        Update: {
          category?: string
          label?: string
          needs_followup?: boolean
          sort_order?: number
          status?: string
        }
        Relationships: []
      }
      delivery_status_history: {
        Row: {
          changed_at: string
          changed_by_user_id: string
          client_uuid: string
          delivery_id: string
          effective_at: string
          from_status: string | null
          id: string
          notes: string | null
          reason: string | null
          to_status: string
        }
        Insert: {
          changed_at?: string
          changed_by_user_id: string
          client_uuid: string
          delivery_id: string
          effective_at?: string
          from_status?: string | null
          id?: string
          notes?: string | null
          reason?: string | null
          to_status: string
        }
        Update: {
          changed_at?: string
          changed_by_user_id?: string
          client_uuid?: string
          delivery_id?: string
          effective_at?: string
          from_status?: string | null
          id?: string
          notes?: string | null
          reason?: string | null
          to_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "delivery_status_history_changed_by_user_id_fkey"
            columns: ["changed_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_status_history_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "available_orders_safe"
            referencedColumns: ["delivery_id"]
          },
          {
            foreignKeyName: "delivery_status_history_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_status_history_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries_admin"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_status_history_delivery_id_fkey"
            columns: ["delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_status_history_from_status_fkey"
            columns: ["from_status"]
            isOneToOne: false
            referencedRelation: "delivery_status_defs"
            referencedColumns: ["status"]
          },
          {
            foreignKeyName: "delivery_status_history_to_status_fkey"
            columns: ["to_status"]
            isOneToOne: false
            referencedRelation: "delivery_status_defs"
            referencedColumns: ["status"]
          },
        ]
      }
      delivery_status_transitions: {
        Row: {
          from_status: string
          requires_admin: boolean
          requires_reason: boolean
          to_status: string
        }
        Insert: {
          from_status: string
          requires_admin?: boolean
          requires_reason?: boolean
          to_status: string
        }
        Update: {
          from_status?: string
          requires_admin?: boolean
          requires_reason?: boolean
          to_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "delivery_status_transitions_from_status_fkey"
            columns: ["from_status"]
            isOneToOne: false
            referencedRelation: "delivery_status_defs"
            referencedColumns: ["status"]
          },
          {
            foreignKeyName: "delivery_status_transitions_to_status_fkey"
            columns: ["to_status"]
            isOneToOne: false
            referencedRelation: "delivery_status_defs"
            referencedColumns: ["status"]
          },
        ]
      }
      edit_locks: {
        Row: {
          acquired_at: string
          entity_id: string
          entity_type: string
          user_id: string
        }
        Insert: {
          acquired_at?: string
          entity_id: string
          entity_type: string
          user_id: string
        }
        Update: {
          acquired_at?: string
          entity_id?: string
          entity_type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "edit_locks_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      feature_flags: {
        Row: {
          description: string | null
          enabled: boolean
          key: string
          updated_at: string
          updated_by_user_id: string | null
          value: Json | null
        }
        Insert: {
          description?: string | null
          enabled?: boolean
          key: string
          updated_at?: string
          updated_by_user_id?: string | null
          value?: Json | null
        }
        Update: {
          description?: string | null
          enabled?: boolean
          key?: string
          updated_at?: string
          updated_by_user_id?: string | null
          value?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "feature_flags_updated_by_user_id_fkey"
            columns: ["updated_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      locations: {
        Row: {
          aliases: string[] | null
          created_at: string
          id: string
          is_active: boolean
          latitude: number | null
          longitude: number | null
          name: string
        }
        Insert: {
          aliases?: string[] | null
          created_at?: string
          id?: string
          is_active?: boolean
          latitude?: number | null
          longitude?: number | null
          name: string
        }
        Update: {
          aliases?: string[] | null
          created_at?: string
          id?: string
          is_active?: boolean
          latitude?: number | null
          longitude?: number | null
          name?: string
        }
        Relationships: []
      }
      mybot_inbound_messages: {
        Row: {
          created_at: string
          error_text: string | null
          from_phone: string | null
          id: string
          message_id: string
          paired_contractor_id: string | null
          parse_result: Json | null
          parse_status: string
          processed_at: string | null
          raw_payload: Json
          raw_text: string
          received_at: string
          text_fingerprint: string | null
        }
        Insert: {
          created_at?: string
          error_text?: string | null
          from_phone?: string | null
          id?: string
          message_id: string
          paired_contractor_id?: string | null
          parse_result?: Json | null
          parse_status?: string
          processed_at?: string | null
          raw_payload: Json
          raw_text: string
          received_at?: string
          text_fingerprint?: string | null
        }
        Update: {
          created_at?: string
          error_text?: string | null
          from_phone?: string | null
          id?: string
          message_id?: string
          paired_contractor_id?: string | null
          parse_result?: Json | null
          parse_status?: string
          processed_at?: string | null
          raw_payload?: Json
          raw_text?: string
          received_at?: string
          text_fingerprint?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "mybot_inbound_messages_paired_contractor_id_fkey"
            columns: ["paired_contractor_id"]
            isOneToOne: false
            referencedRelation: "bot_inbound_messages"
            referencedColumns: ["id"]
          },
        ]
      }
      product_catalog: {
        Row: {
          aliases: string[] | null
          client_id: string
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          product_name: string
        }
        Insert: {
          aliases?: string[] | null
          client_id: string
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          product_name: string
        }
        Update: {
          aliases?: string[] | null
          client_id?: string
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          product_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_catalog_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      push_tokens: {
        Row: {
          created_at: string
          device_label: string | null
          id: string
          last_seen_at: string
          platform: string | null
          token: string
          user_id: string
        }
        Insert: {
          created_at?: string
          device_label?: string | null
          id?: string
          last_seen_at?: string
          platform?: string | null
          token: string
          user_id: string
        }
        Update: {
          created_at?: string
          device_label?: string | null
          id?: string
          last_seen_at?: string
          platform?: string | null
          token?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_tokens_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_card: {
        Row: {
          agent_payment: number
          charged: number
          created_at: string
          created_by_user_id: string | null
          effective_from: string
          effective_until: string | null
          id: string
          location_id: string
        }
        Insert: {
          agent_payment: number
          charged: number
          created_at?: string
          created_by_user_id?: string | null
          effective_from?: string
          effective_until?: string | null
          id?: string
          location_id: string
        }
        Update: {
          agent_payment?: number
          charged?: number
          created_at?: string
          created_by_user_id?: string | null
          effective_from?: string
          effective_until?: string | null
          id?: string
          location_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rate_card_created_by_user_id_fkey"
            columns: ["created_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rate_card_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      settlements: {
        Row: {
          created_at: string
          deliveries_count: number
          expected_amount: number
          id: string
          note: string | null
          period_date: string
          settled_at: string
          settled_by: string
          snapshot: Json
          subject_id: string
          subject_type: string
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          created_at?: string
          deliveries_count: number
          expected_amount: number
          id?: string
          note?: string | null
          period_date: string
          settled_at?: string
          settled_by: string
          snapshot: Json
          subject_id: string
          subject_type: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          created_at?: string
          deliveries_count?: number
          expected_amount?: number
          id?: string
          note?: string | null
          period_date?: string
          settled_at?: string
          settled_by?: string
          snapshot?: Json
          subject_id?: string
          subject_type?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "settlements_settled_by_fkey"
            columns: ["settled_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "settlements_voided_by_fkey"
            columns: ["voided_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_adjustments: {
        Row: {
          agent_id: string
          client_uuid: string
          created_at: string
          created_by_user_id: string
          id: string
          notes: string | null
          product_catalog_id: string
          quantity_delta: number
          reason: string
          related_adjustment_id: string | null
        }
        Insert: {
          agent_id: string
          client_uuid: string
          created_at?: string
          created_by_user_id: string
          id?: string
          notes?: string | null
          product_catalog_id: string
          quantity_delta: number
          reason: string
          related_adjustment_id?: string | null
        }
        Update: {
          agent_id?: string
          client_uuid?: string
          created_at?: string
          created_by_user_id?: string
          id?: string
          notes?: string | null
          product_catalog_id?: string
          quantity_delta?: number
          reason?: string
          related_adjustment_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stock_adjustments_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_adjustments_created_by_user_id_fkey"
            columns: ["created_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_adjustments_product_catalog_id_fkey"
            columns: ["product_catalog_id"]
            isOneToOne: false
            referencedRelation: "product_catalog"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_adjustments_related_adjustment_id_fkey"
            columns: ["related_adjustment_id"]
            isOneToOne: false
            referencedRelation: "stock_adjustments"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          agent_payment_bonus: number
          created_at: string
          deactivated_at: string | null
          display_name: string
          email: string
          expo_push_token: string | null
          id: string
          is_active: boolean
          notes: string | null
          parent_agent_id: string | null
          phone: string | null
          role: string
          warehouse_id: string | null
        }
        Insert: {
          agent_payment_bonus?: number
          created_at?: string
          deactivated_at?: string | null
          display_name: string
          email: string
          expo_push_token?: string | null
          id: string
          is_active?: boolean
          notes?: string | null
          parent_agent_id?: string | null
          phone?: string | null
          role: string
          warehouse_id?: string | null
        }
        Update: {
          agent_payment_bonus?: number
          created_at?: string
          deactivated_at?: string | null
          display_name?: string
          email?: string
          expo_push_token?: string | null
          id?: string
          is_active?: boolean
          notes?: string | null
          parent_agent_id?: string | null
          phone?: string | null
          role?: string
          warehouse_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "users_parent_agent_id_fkey"
            columns: ["parent_agent_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "users_warehouse_id_fkey"
            columns: ["warehouse_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      available_orders_safe: {
        Row: {
          agent_id: string | null
          agent_name: string | null
          client_id: string | null
          client_name: string | null
          current_status: string | null
          customer_name: string | null
          delivery_id: string | null
          location_id: string | null
          location_name: string | null
          product_catalog_id: string | null
          product_name: string | null
          quantity_ordered: number | null
          scheduled_date: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deliveries_assigned_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_current_status_fkey"
            columns: ["current_status"]
            isOneToOne: false
            referencedRelation: "delivery_status_defs"
            referencedColumns: ["status"]
          },
          {
            foreignKeyName: "deliveries_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "delivery_items_product_catalog_id_fkey"
            columns: ["product_catalog_id"]
            isOneToOne: false
            referencedRelation: "product_catalog"
            referencedColumns: ["id"]
          },
        ]
      }
      current_stock: {
        Row: {
          agent_id: string | null
          product_catalog_id: string | null
          quantity_on_hand: number | null
        }
        Relationships: []
      }
      deliveries_admin: {
        Row: {
          agent_payment_snapshot: number | null
          assigned_agent_id: string | null
          assigned_at: string | null
          bot_raw_message: string | null
          charged_snapshot: number | null
          client_id: string | null
          created_at: string | null
          created_by_user_id: string | null
          created_date: string | null
          created_via: string | null
          current_status: string | null
          customer_name: string | null
          customer_phone: string | null
          customer_phone_alt: string | null
          customer_price: number | null
          deleted_at: string | null
          delivery_instructions: string | null
          id: string | null
          latest_changed_at: string | null
          latest_history_id: string | null
          latest_message_at: string | null
          latest_notified: boolean | null
          location_id: string | null
          margin: number | null
          order_type: string | null
          paid: number | null
          parent_delivery_id: string | null
          payment_method: string | null
          product_catalog_id: string | null
          quantity_delivered: number | null
          quantity_ordered: number | null
          raw_address: string | null
          rolled_from_date: string | null
          rolled_from_status: string | null
          rollover_count: number | null
          scheduled_date: string | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deliveries_assigned_agent_id_fkey"
            columns: ["assigned_agent_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_created_by_user_id_fkey"
            columns: ["created_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_current_status_fkey"
            columns: ["current_status"]
            isOneToOne: false
            referencedRelation: "delivery_status_defs"
            referencedColumns: ["status"]
          },
          {
            foreignKeyName: "deliveries_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_parent_delivery_id_fkey"
            columns: ["parent_delivery_id"]
            isOneToOne: false
            referencedRelation: "available_orders_safe"
            referencedColumns: ["delivery_id"]
          },
          {
            foreignKeyName: "deliveries_parent_delivery_id_fkey"
            columns: ["parent_delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_parent_delivery_id_fkey"
            columns: ["parent_delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries_admin"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_parent_delivery_id_fkey"
            columns: ["parent_delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_product_catalog_id_fkey"
            columns: ["product_catalog_id"]
            isOneToOne: false
            referencedRelation: "product_catalog"
            referencedColumns: ["id"]
          },
        ]
      }
      deliveries_safe: {
        Row: {
          agent_payment_snapshot: number | null
          assigned_agent_id: string | null
          assigned_at: string | null
          bot_raw_message: string | null
          client_id: string | null
          created_at: string | null
          created_by_user_id: string | null
          created_date: string | null
          created_via: string | null
          current_status: string | null
          customer_name: string | null
          customer_phone: string | null
          customer_phone_alt: string | null
          customer_price: number | null
          delivery_instructions: string | null
          id: string | null
          latest_changed_at: string | null
          latest_history_id: string | null
          latest_message_at: string | null
          latest_notified: boolean | null
          location_id: string | null
          order_type: string | null
          paid: number | null
          parent_delivery_id: string | null
          payment_method: string | null
          product_catalog_id: string | null
          quantity_delivered: number | null
          quantity_ordered: number | null
          raw_address: string | null
          rolled_from_date: string | null
          rolled_from_status: string | null
          rollover_count: number | null
          scheduled_date: string | null
          updated_at: string | null
        }
        Relationships: [
          {
            foreignKeyName: "deliveries_assigned_agent_id_fkey"
            columns: ["assigned_agent_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_created_by_user_id_fkey"
            columns: ["created_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_current_status_fkey"
            columns: ["current_status"]
            isOneToOne: false
            referencedRelation: "delivery_status_defs"
            referencedColumns: ["status"]
          },
          {
            foreignKeyName: "deliveries_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_parent_delivery_id_fkey"
            columns: ["parent_delivery_id"]
            isOneToOne: false
            referencedRelation: "available_orders_safe"
            referencedColumns: ["delivery_id"]
          },
          {
            foreignKeyName: "deliveries_parent_delivery_id_fkey"
            columns: ["parent_delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_parent_delivery_id_fkey"
            columns: ["parent_delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries_admin"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_parent_delivery_id_fkey"
            columns: ["parent_delivery_id"]
            isOneToOne: false
            referencedRelation: "deliveries_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliveries_product_catalog_id_fkey"
            columns: ["product_catalog_id"]
            isOneToOne: false
            referencedRelation: "product_catalog"
            referencedColumns: ["id"]
          },
        ]
      }
      recent_edge_function_failures: {
        Row: {
          content_preview: string | null
          created: string | null
          id: number | null
          status_code: number | null
        }
        Insert: {
          content_preview?: never
          created?: string | null
          id?: number | null
          status_code?: number | null
        }
        Update: {
          content_preview?: never
          created?: string | null
          id?: number | null
          status_code?: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      _apply_delivery_items: {
        Args: { p_delivery_id: string; p_items: Json }
        Returns: string
      }
      _apply_delivery_zone: {
        Args: {
          p_audit_reason: string
          p_delivery_id: string
          p_location_id: string
        }
        Returns: {
          agent_payment: number
          charged: number
        }[]
      }
      _apply_item_deliveries: {
        Args: { p_delivery_id: string; p_item_quantities: Json }
        Returns: number
      }
      _assert_holds_lock: {
        Args: { p_entity_id: string; p_entity_type: string }
        Returns: undefined
      }
      _copy_delivery_items: {
        Args: { p_child: string; p_parent: string }
        Returns: undefined
      }
      _delivery_items_sig: { Args: { p_items: Json }; Returns: string }
      _dm_is_terminal_status: { Args: { p_status: string }; Returns: boolean }
      _dm_issue_label: { Args: { p_issue_type: string }; Returns: string }
      _effective_scheduled_date: {
        Args: { p_created_via: string; p_scheduled_date: string }
        Returns: string
      }
      _ensure_workday: { Args: { p_candidate: string }; Returns: string }
      _find_sibling_deliveries: {
        Args: { p_delivery_id: string }
        Returns: {
          agent_payment_snapshot: number | null
          assigned_agent_id: string | null
          assigned_at: string | null
          bot_raw_message: string | null
          cash_pos_fee_snapshot: number | null
          charged_snapshot: number | null
          client_id: string
          created_at: string
          created_by_user_id: string | null
          created_date: string
          created_via: string
          current_status: string
          customer_name: string
          customer_phone: string
          customer_phone_alt: string | null
          customer_phone_normalized: string | null
          customer_price: number
          deleted_at: string | null
          delivery_instructions: string | null
          id: string
          items_fingerprint: string | null
          location_id: string | null
          paid: number | null
          parent_delivery_id: string | null
          payment_method: string | null
          product_catalog_id: string
          quantity_delivered: number | null
          quantity_ordered: number
          raw_address: string
          rolled_from_date: string | null
          rolled_from_status: string | null
          rollover_count: number
          scheduled_date: string
          text_fingerprint: string | null
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "deliveries"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      _items_fingerprint: { Args: { p_delivery_id: string }; Returns: string }
      _items_fingerprint_from_canon: {
        Args: { p_canon: string }
        Returns: string
      }
      _norm_address: { Args: { a: string }; Returns: string }
      _norm_phone: { Args: { p: string }; Returns: string }
      _notify_admins_carry_cap: {
        Args: { p_delivery_id: string }
        Returns: undefined
      }
      _notify_admins_eod_summary: {
        Args: {
          p_cap_hit_count: number
          p_capped_ids: string[]
          p_for_date: string
          p_policy_cancel_count?: number
          p_race_lost_count: number
          p_same_agent_count: number
          p_sibling_resolved_count?: number
        }
        Returns: undefined
      }
      _open_sibling_agents: {
        Args: { p_delivery_id: string }
        Returns: {
          agent_id: string
        }[]
      }
      _text_fingerprint: { Args: { p_text: string }; Returns: string }
      accept_call: {
        Args: { p_call_id: string; p_device_uuid: string }
        Returns: {
          accepted_device_uuid: string | null
          agora_channel: string
          callee_audience: string
          callee_id: string | null
          caller_device_uuid: string
          caller_id: string
          client_uuid: string | null
          created_at: string
          duration_seconds: number | null
          ended_at: string | null
          id: string
          last_token_issued_at: string | null
          related_delivery_id: string | null
          ringing_until: string
          started_at: string | null
          status: string
        }
        SetofOptions: {
          from: "*"
          to: "calls"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      acquire_edit_lock: {
        Args: {
          p_entity_id: string
          p_entity_type: string
          p_takeover?: boolean
        }
        Returns: {
          acquired_at: string
          held_by: string
          holder_name: string
          is_self: boolean
        }[]
      }
      admin_set_user_credentials: {
        Args: {
          p_email?: string
          p_id: string
          p_password?: string
          p_reason?: string
        }
        Returns: undefined
      }
      agent_change_delivery_location: {
        Args: {
          p_client_uuid: string
          p_delivery_id: string
          p_location_id: string
          p_reason: string
        }
        Returns: Json
      }
      agent_earnings_summary: {
        Args: { p_from: string; p_to: string }
        Returns: {
          agent_id: string
          agent_name: string
          deliveries_count: number
          total_collected: number
          total_earnings: number
          total_quantity: number
          total_remit: number
        }[]
      }
      agent_pending_workload: { Args: { p_agent_id: string }; Returns: number }
      approve_location_change: {
        Args: { p_change_id: string; p_reason?: string }
        Returns: undefined
      }
      auto_assign_delivery: { Args: { p_delivery_id: string }; Returns: string }
      bot_create_delivery: {
        Args: {
          p_assigned_agent_id?: string
          p_bot_raw_message?: string
          p_client_id: string
          p_client_uuid: string
          p_customer_name: string
          p_customer_phone: string
          p_customer_phone_alt?: string
          p_customer_price: number
          p_delivery_instructions?: string
          p_items?: Json
          p_location_id?: string
          p_product_catalog_id: string
          p_quantity_ordered: number
          p_raw_address: string
          p_scheduled_date?: string
        }
        Returns: string
      }
      bulk_assign_deliveries: {
        Args: { p_agent_id: string; p_delivery_ids: string[] }
        Returns: number
      }
      bulk_change_delivery_status: {
        Args: {
          p_client_uuid: string
          p_delivery_ids: string[]
          p_reason: string
          p_to_status: string
        }
        Returns: Json
      }
      bulk_delete_deliveries: {
        Args: { p_delivery_ids: string[]; p_reason: string }
        Returns: Json
      }
      cancel_call: {
        Args: { p_call_id: string }
        Returns: {
          accepted_device_uuid: string | null
          agora_channel: string
          callee_audience: string
          callee_id: string | null
          caller_device_uuid: string
          caller_id: string
          client_uuid: string | null
          created_at: string
          duration_seconds: number | null
          ended_at: string | null
          id: string
          last_token_issued_at: string | null
          related_delivery_id: string | null
          ringing_until: string
          started_at: string | null
          status: string
        }
        SetofOptions: {
          from: "*"
          to: "calls"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      change_delivery_status: {
        Args: {
          p_client_uuid: string
          p_delivery_id: string
          p_effective_at?: string
          p_item_quantities?: Json
          p_new_scheduled_date?: string
          p_notes?: string
          p_paid?: number
          p_payment_method?: string
          p_quantity_delivered?: number
          p_reason?: string
          p_to_status: string
        }
        Returns: undefined
      }
      claim_followup: {
        Args: { p_delivery_id: string; p_takeover?: boolean }
        Returns: {
          claimed_at: string
          held_by: string
          holder_name: string
          is_self: boolean
        }[]
      }
      clear_client_ceiling: {
        Args: { p_id: string; p_reason?: string }
        Returns: undefined
      }
      clear_delivery_location: {
        Args: { p_delivery_id: string; p_reason: string }
        Returns: undefined
      }
      client_remit_detail: {
        Args: { p_client_id: string; p_from: string; p_to: string }
        Returns: {
          agent_name: string
          cash_pos_fee: number
          client_rep: string | null
          customer_name: string
          customer_price: number
          delivery_id: string
          location_name: string
          order_type: string | null
          paid: number
          payment_method: string
          product_name: string
          quantity_delivered: number
          quantity_ordered: number
          reda_fee: number
          remit: number
          scheduled_date: string
        }[]
      }
      client_remit_detail_rep: {
        Args: { p_client_id: string; p_from: string; p_to: string }
        Returns: {
          agent_name: string
          cash_pos_fee: number
          client_rep: string | null
          customer_name: string
          delivery_id: string
          location_name: string
          order_type: string | null
          outstanding: number
          payment_method: string
          product_name: string
          quantity_delivered: number
          quantity_ordered: number
          remit: number
          scheduled_date: string
        }[]
      }
      client_remit_summary: {
        Args: { p_from: string; p_to: string }
        Returns: {
          client_id: string
          client_name: string
          deliveries_count: number
          outstanding: number
          total_cash_pos_fee: number
          total_customer_price: number
          total_paid: number
          total_quantity: number
          total_reda_fee: number
          total_remit: number
        }[]
      }
      client_remit_summary_rep: {
        Args: { p_from: string; p_to: string }
        Returns: {
          client_id: string
          client_name: string
          deliveries_count: number
          total_quantity: number
          total_remit: number
        }[]
      }
      correct_delivery_charge: {
        Args: {
          p_delivery_id: string
          p_charged: number
          p_agent_payment: number
          p_reason: string
        }
        Returns: undefined
      }
      correct_delivery_location: {
        Args: { p_delivery_id: string; p_location_id: string; p_reason: string }
        Returns: undefined
      }
      create_waybill: {
        Args: {
          p_client_id: string
          p_charged: number
          p_paid: number
          p_note?: string
          p_label?: string
          p_scheduled_date?: string
        }
        Returns: string
      }
      create_app_user: {
        Args: {
          p_display_name: string
          p_email: string
          p_password: string
          p_phone?: string
          p_role: string
          p_warehouse_id?: string
        }
        Returns: string
      }
      create_client: {
        Args: {
          p_contact_email?: string
          p_contact_phone?: string
          p_name: string
          p_notes?: string
        }
        Returns: string
      }
      create_delivery: {
        Args: {
          p_assigned_agent_id?: string
          p_bot_raw_message?: string
          p_client_id: string
          p_client_uuid: string
          p_created_via?: string
          p_customer_name: string
          p_customer_phone: string
          p_customer_phone_alt?: string
          p_customer_price: number
          p_delivery_instructions?: string
          p_items?: Json
          p_location_id?: string
          p_product_catalog_id: string
          p_quantity_ordered: number
          p_raw_address: string
          p_scheduled_date?: string
        }
        Returns: string
      }
      create_location: {
        Args: {
          p_aliases?: string[]
          p_latitude?: number
          p_longitude?: number
          p_name: string
        }
        Returns: string
      }
      create_product: {
        Args: {
          p_client_id: string
          p_description?: string
          p_product_name: string
        }
        Returns: string
      }
      create_stock_adjustment: {
        Args: {
          p_agent_id: string
          p_client_uuid: string
          p_notes?: string
          p_product_catalog_id: string
          p_quantity_delta: number
          p_reason: string
        }
        Returns: string
      }
      create_stock_transfer: {
        Args: {
          p_allow_inactive_from?: boolean
          p_client_uuid: string
          p_from_user_id: string
          p_notes?: string
          p_product_catalog_id: string
          p_quantity: number
          p_reason: string
          p_to_user_id: string
        }
        Returns: string
      }
      current_rate_for_location: {
        Args: { p_location_id: string }
        Returns: {
          agent_payment: number
          charged: number
        }[]
      }
      current_user_role: { Args: never; Returns: string }
      deactivate_client: {
        Args: { p_id: string; p_reason: string }
        Returns: undefined
      }
      deactivate_location: {
        Args: { p_id: string; p_reason: string }
        Returns: undefined
      }
      deactivate_product: {
        Args: { p_id: string; p_reason: string }
        Returns: undefined
      }
      deactivate_user: {
        Args: { p_id: string; p_reason: string; p_stock_disposition?: string }
        Returns: undefined
      }
      decline_call: {
        Args: { p_call_id: string; p_reason: string }
        Returns: {
          accepted_device_uuid: string | null
          agora_channel: string
          callee_audience: string
          callee_id: string | null
          caller_device_uuid: string
          caller_id: string
          client_uuid: string | null
          created_at: string
          duration_seconds: number | null
          ended_at: string | null
          id: string
          last_token_issued_at: string | null
          related_delivery_id: string | null
          ringing_until: string
          started_at: string | null
          status: string
        }
        SetofOptions: {
          from: "*"
          to: "calls"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      delete_delivery: {
        Args: { p_delivery_id: string; p_reason: string }
        Returns: undefined
      }
      discard_inbound: {
        Args: { p_inbound_id: string; p_reason: string }
        Returns: undefined
      }
      effective_rate: {
        Args: {
          p_agent_id?: string
          p_client_id: string
          p_location_id: string
        }
        Returns: {
          agent_payment: number
          charged: number
        }[]
      }
      end_call: {
        Args: { p_call_id: string }
        Returns: {
          accepted_device_uuid: string | null
          agora_channel: string
          callee_audience: string
          callee_id: string | null
          caller_device_uuid: string
          caller_id: string
          client_uuid: string | null
          created_at: string
          duration_seconds: number | null
          ended_at: string | null
          id: string
          last_token_issued_at: string | null
          related_delivery_id: string | null
          ringing_until: string
          started_at: string | null
          status: string
        }
        SetofOptions: {
          from: "*"
          to: "calls"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      expire_ringing_calls: { Args: never; Returns: number }
      flag_delivery_issue: {
        Args: {
          p_client_uuid: string
          p_delivery_id: string
          p_issue_type: string
          p_new_status: string
          p_note: string
        }
        Returns: {
          author_id: string
          author_role: string
          client_uuid: string | null
          created_at: string
          delivery_id: string
          id: string
          issue_type: string | null
          note: string | null
          read_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "delivery_messages"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      get_ai_config: { Args: { p_key: string }; Returns: Json }
      get_flag: { Args: { p_key: string }; Returns: Json }
      heartbeat_edit_lock: {
        Args: { p_entity_id: string; p_entity_type: string }
        Returns: undefined
      }
      initiate_call: {
        Args: {
          p_callee_audience?: string
          p_callee_id: string
          p_caller_device_uuid: string
          p_client_uuid: string
          p_related_delivery_id: string
        }
        Returns: {
          accepted_device_uuid: string | null
          agora_channel: string
          callee_audience: string
          callee_id: string | null
          caller_device_uuid: string
          caller_id: string
          client_uuid: string | null
          created_at: string
          duration_seconds: number | null
          ended_at: string | null
          id: string
          last_token_issued_at: string | null
          related_delivery_id: string | null
          ringing_until: string
          started_at: string | null
          status: string
        }
        SetofOptions: {
          from: "*"
          to: "calls"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      is_admin: { Args: never; Returns: boolean }
      is_admin_or_dispatcher: { Args: never; Returns: boolean }
      is_manager: { Args: never; Returns: boolean }
      is_warehouse: { Args: never; Returns: boolean }
      list_delivery_history_chain: {
        Args: { p_delivery_id: string }
        Returns: {
          chain_depth: number
          changed_at: string
          changed_by_name: string
          changed_by_user_id: string
          delivery_id: string
          effective_at: string
          from_status: string
          id: string
          is_current: boolean
          notes: string
          reason: string
          scheduled_date: string
          to_status: string
        }[]
      }
      get_sibling_contact: {
        Args: { p_delivery_id: string }
        Returns: {
          agent_id: string
          agent_name: string
          category: string
          sibling_delivery_id: string
          status: string
          status_label: string
          worked_at: string
        }[]
      }
      get_delivery_handoff_state: {
        Args: { p_delivery_id: string }
        Returns: {
          from_agent_name: string | null
          handed_at: string
          handed_by_name: string | null
        }[]
      }
      list_location_changes: {
        Args: { p_states?: string[] }
        Returns: {
          agent_id: string
          agent_name: string
          change_id: string
          created_at: string
          current_status: string
          customer_name: string
          decided_at: string
          delivery_id: string
          from_agent_payment: number
          from_charged: number
          from_location_id: string
          from_location_name: string
          reason: string
          scheduled_date: string
          state: string
          to_agent_payment: number
          to_charged: number
          to_location_id: string
          to_location_name: string
        }[]
      }
      list_movement_actors: {
        Args: { p_holder_id: string }
        Returns: {
          actor_id: string
          actor_name: string
        }[]
      }
      list_movement_counterparties: {
        Args: { p_holder_id: string }
        Returns: {
          counterparty_id: string
          counterparty_name: string
        }[]
      }
      list_settlements_for_date: {
        Args: { p_period_date: string }
        Returns: {
          deliveries_count: number
          expected_amount: number
          note: string
          settled_at: string
          settled_by_name: string
          settlement_id: string
          subject_id: string
          subject_type: string
        }[]
      }
      list_stock_movements: {
        Args: {
          p_actor_id?: string
          p_before_at?: string
          p_before_event_id?: string
          p_counterparty_id?: string
          p_holder_id: string
          p_kinds?: string[]
          p_limit?: number
        }
        Returns: {
          actor_id: string
          actor_name: string
          counterparty_holder_id: string
          counterparty_holder_name: string
          customer_name: string
          delivery_id: string
          event_at: string
          event_id: string
          event_kind: string
          notes: string
          product_catalog_id: string
          product_name: string
          quantity_delta: number
          quantity_ordered: number
          related_adjustment_id: string
          source: string
        }[]
      }
      mark_client_notified: {
        Args: { p_status_history_id: string }
        Returns: {
          delivery_id: string
          holder_name: string
          is_self: boolean
          notified_at: string
          notified_by_user_id: string
          status_history_id: string
        }[]
      }
      mark_inbound_processed: {
        Args: {
          p_delivery_id?: string
          p_error?: string
          p_inbound_id: string
          p_parse: Json
          p_status: string
        }
        Returns: undefined
      }
      mark_messages_read: {
        Args: { p_delivery_id: string }
        Returns: undefined
      }
      mark_token_issued: { Args: { p_call_id: string }; Returns: undefined }
      match_products_by_text: {
        Args: { p_min_similarity?: number; p_text: string }
        Returns: {
          client_id: string
          client_name: string
          id: string
          product_name: string
          score: number
        }[]
      }
      preview_delivery_charge: {
        Args: { p_client_id: string; p_location_id: string }
        Returns: {
          client_ceiling: number
          effective_charged: number
          rate_card_charged: number
          was_clamped: boolean
        }[]
      }
      prune_net_response_log: { Args: never; Returns: number }
      reactivate_client: { Args: { p_id: string }; Returns: undefined }
      reactivate_location: { Args: { p_id: string }; Returns: undefined }
      reactivate_product: { Args: { p_id: string }; Returns: undefined }
      reactivate_user: { Args: { p_id: string }; Returns: undefined }
      reassign_to_sub_agent: {
        Args: {
          p_client_uuid: string
          p_delivery_id: string
          p_sub_agent_id: string
        }
        Returns: undefined
      }
      reject_location_change: {
        Args: { p_change_id: string; p_reason: string }
        Returns: undefined
      }
      release_edit_lock: {
        Args: { p_entity_id: string; p_entity_type: string }
        Returns: undefined
      }
      release_followup: { Args: { p_delivery_id: string }; Returns: undefined }
      release_my_expo_push_token: {
        Args: { p_token: string }
        Returns: undefined
      }
      release_postponed_due: { Args: { p_due_date: string }; Returns: number }
      reply_to_delivery: {
        Args: { p_client_uuid: string; p_delivery_id: string; p_text: string }
        Returns: {
          author_id: string
          author_role: string
          client_uuid: string | null
          created_at: string
          delivery_id: string
          id: string
          issue_type: string | null
          note: string | null
          read_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "delivery_messages"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      resolve_inbound_to_delivery: {
        Args: { p_delivery_id: string; p_inbound_id: string }
        Returns: undefined
      }
      return_delivery_leftover: {
        Args: {
          p_client_uuid: string
          p_delivery_id: string
          p_notes?: string
          p_quantity?: number
        }
        Returns: string
      }
      revert_delivery_to_pending: {
        Args: { p_delivery_id: string; p_reason: string }
        Returns: undefined
      }
      revert_location_change: {
        Args: { p_change_id: string; p_reason: string }
        Returns: undefined
      }
      rollover_delivery: {
        Args: {
          p_client_uuid: string
          p_delivery_id: string
          p_new_scheduled_date?: string
          p_notify?: boolean
          p_reason?: string
        }
        Returns: string
      }
      run_eod_rollover: {
        Args: { p_for_date?: string; p_reason?: string }
        Returns: number
      }
      run_eod_rollover_all_stuck: {
        Args: { p_reason?: string }
        Returns: number
      }
      send_edge_notification: { Args: { p_body: Json }; Returns: undefined }
      set_agent_locations: {
        Args: {
          p_agent_id: string
          p_avoided_ids: string[]
          p_preferred_ids: string[]
        }
        Returns: undefined
      }
      set_feature_flag: {
        Args: { p_enabled: boolean; p_key: string }
        Returns: undefined
      }
      set_my_expo_push_token: {
        Args: { p_device_label?: string; p_platform?: string; p_token: string }
        Returns: undefined
      }
      settle_period: {
        Args: {
          p_note?: string
          p_period_date: string
          p_subject_id: string
          p_subject_type: string
        }
        Returns: string
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      unassign_delivery: {
        Args: { p_delivery_id: string; p_reason: string }
        Returns: undefined
      }
      update_client:
        | {
            Args: {
              p_contact_email: string
              p_contact_phone: string
              p_id: string
              p_max_charge_per_delivery?: number
              p_name: string
              p_notes: string
              p_reason?: string
            }
            Returns: undefined
          }
        | {
            Args: {
              p_auto_cancel_soft_fails?: boolean
              p_contact_email: string
              p_contact_phone: string
              p_id: string
              p_max_charge_per_delivery?: number
              p_name: string
              p_notes: string
              p_reason?: string
            }
            Returns: undefined
          }
      update_delivery_fields: {
        Args: {
          p_assigned_agent_id?: string
          p_client_id?: string
          p_customer_name?: string
          p_customer_phone?: string
          p_customer_phone_alt?: string
          p_customer_price?: number
          p_delivery_id: string
          p_delivery_instructions?: string
          p_items?: Json
          p_location_id?: string
          p_product_catalog_id?: string
          p_quantity_ordered?: number
          p_raw_address?: string
        }
        Returns: undefined
      }
      update_location: {
        Args: {
          p_aliases: string[]
          p_id: string
          p_latitude: number
          p_longitude: number
          p_name: string
          p_reason?: string
        }
        Returns: undefined
      }
      update_product: {
        Args: {
          p_description: string
          p_id: string
          p_product_name: string
          p_reason?: string
        }
        Returns: undefined
      }
      update_self_profile: {
        Args: { p_display_name: string; p_phone: string }
        Returns: undefined
      }
      update_user: {
        Args: {
          p_agent_payment_bonus?: number
          p_display_name: string
          p_id: string
          p_phone: string
          p_reason?: string
          p_role: string
          p_warehouse_id?: string
        }
        Returns: undefined
      }
      upsert_rate_card: {
        Args: {
          p_agent_payment: number
          p_charged: number
          p_location_id: string
          p_reason?: string
        }
        Returns: string
      }
      void_settlement: {
        Args: { p_reason: string; p_settlement_id: string }
        Returns: undefined
      }
      write_audit: {
        Args: {
          p_actor_id?: string
          p_entity_id: string
          p_entity_type: string
          p_new: Json
          p_old: Json
          p_reason?: string
        }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
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
    Enums: {},
  },
} as const
