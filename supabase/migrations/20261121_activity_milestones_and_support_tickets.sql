-- ============================================================================
-- Surfkit · Activity Milestones & Multi-Category Support Tickets Migration
-- Migration: 20261121_activity_milestones_and_support_tickets.sql
-- ============================================================================

-- 1. Ensure Activity & Milestone tracking columns exist on public.profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS streak_days         INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS surveys_completed   INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS games_played        INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS four_hour_spins     INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_spin_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_active_date    DATE;

-- 2. Create or extend public.support_messages table
CREATE TABLE IF NOT EXISTS public.support_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  user_email    TEXT NOT NULL,
  category      TEXT DEFAULT 'Account/Other',
  subject       TEXT,
  message       TEXT NOT NULL,
  sender_type   TEXT DEFAULT 'user',
  status        TEXT DEFAULT 'open',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Ensure all required columns exist on support_messages (idempotent for existing tables)
ALTER TABLE public.support_messages
  ADD COLUMN IF NOT EXISTS user_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS category     TEXT DEFAULT 'Account/Other',
  ADD COLUMN IF NOT EXISTS subject      TEXT,
  ADD COLUMN IF NOT EXISTS sender_type  TEXT DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS status       TEXT DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ DEFAULT NOW();

-- 3. Performance Indexes
CREATE INDEX IF NOT EXISTS idx_support_messages_user_email ON public.support_messages(user_email);
CREATE INDEX IF NOT EXISTS idx_support_messages_user_id ON public.support_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_support_messages_created_at ON public.support_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_messages_status ON public.support_messages(status);

-- 4. Enable Row Level Security
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;

-- 5. Strict RLS Policies for Multi-Tenant Isolation
-- SELECT Policy: Users can only view messages belonging to their authenticated UID or email
DROP POLICY IF EXISTS "Users can read own support messages" ON public.support_messages;
CREATE POLICY "Users can read own support messages"
  ON public.support_messages
  FOR SELECT
  USING (
    auth.uid() = user_id OR
    user_email = (auth.jwt() ->> 'email') OR
    user_email = (SELECT email FROM auth.users WHERE id = auth.uid())
  );

-- INSERT Policy: Authenticated users can insert their own support messages
DROP POLICY IF EXISTS "Users can insert own support messages" ON public.support_messages;
CREATE POLICY "Users can insert own support messages"
  ON public.support_messages
  FOR INSERT
  WITH CHECK (
    auth.uid() = user_id OR
    user_email = (auth.jwt() ->> 'email') OR
    user_email = (SELECT email FROM auth.users WHERE id = auth.uid()) OR
    auth.uid() IS NULL
  );

-- 6. Helper RPC Function to increment milestone counters atomically without touching wallet balance
CREATE OR REPLACE FUNCTION public.record_user_milestone(
  p_user_id UUID,
  p_milestone_type TEXT,
  p_increment INTEGER DEFAULT 1
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_updated public.profiles%ROWTYPE;
BEGIN
  IF p_milestone_type = 'survey' THEN
    UPDATE public.profiles
    SET surveys_completed = COALESCE(surveys_completed, 0) + p_increment,
        updated_at = NOW()
    WHERE id = p_user_id
    RETURNING * INTO v_updated;
  ELSIF p_milestone_type = 'game' THEN
    UPDATE public.profiles
    SET games_played = COALESCE(games_played, 0) + p_increment,
        updated_at = NOW()
    WHERE id = p_user_id
    RETURNING * INTO v_updated;
  ELSIF p_milestone_type = 'spin' THEN
    UPDATE public.profiles
    SET four_hour_spins = COALESCE(four_hour_spins, 0) + p_increment,
        last_spin_at = NOW(),
        updated_at = NOW()
    WHERE id = p_user_id
    RETURNING * INTO v_updated;
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'Invalid milestone type');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'surveys_completed', v_updated.surveys_completed,
    'games_played', v_updated.games_played,
    'four_hour_spins', v_updated.four_hour_spins
  );
END;
$$;
