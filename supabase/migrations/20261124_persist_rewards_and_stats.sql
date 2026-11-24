-- ============================================================================
-- Surfkit · Unified Rewards & Stats Persistence Migration
-- Migration: 20261124_persist_rewards_and_stats.sql
--
-- Ensures:
--   1. completed_activities column exists on public.profiles
--   2. daily_stats table exists with proper indexes and RLS
--   3. pulse_spins table has INSERT RLS policy
--   4. activity_ledger table has INSERT RLS policy
-- ============================================================================

-- 1. Ensure completed_activities and spin columns exist on public.profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS completed_activities     INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS four_hour_spins          INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pulse_dial_total_spins   INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pulse_dial_total_skit    NUMERIC(12, 3) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pulse_dial_last_spin     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_spin_at             TIMESTAMPTZ;

-- 2. Ensure daily_stats table exists
CREATE TABLE IF NOT EXISTS public.daily_stats (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  stat_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  earnings     NUMERIC(14, 6) DEFAULT 0.0,
  impressions  INTEGER DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_stats_user_date
  ON public.daily_stats (user_id, stat_date);

-- Enable RLS on daily_stats
ALTER TABLE public.daily_stats ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Users can manage own daily stats"
    ON public.daily_stats
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3. Ensure pulse_spins has INSERT policy
DO $$ BEGIN
  CREATE POLICY "Users can insert own pulse spins"
    ON public.pulse_spins
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 4. Ensure activity_ledger has INSERT policy
DO $$ BEGIN
  CREATE POLICY "Users can insert own activity ledger"
    ON public.activity_ledger
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 5. Grant permissions to authenticated and service_role
GRANT ALL ON public.daily_stats TO authenticated, service_role;
GRANT SELECT, INSERT ON public.activity_ledger TO authenticated, service_role;
GRANT SELECT, INSERT ON public.pulse_spins TO authenticated, service_role;
