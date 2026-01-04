-- Fix the security definer view warning by setting security_invoker = true
-- This makes the view use the permissions of the querying user, not the view creator
ALTER VIEW seat_stats SET (security_invoker = true);