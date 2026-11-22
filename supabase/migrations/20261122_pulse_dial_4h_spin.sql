-- ============================================================================
-- Surfkit · Pulse Dial / 4-Hour Spin Feature Migration
-- Migration: 20261122_pulse_dial_4h_spin.sql
--
-- This migration implements:
--   1. Columns on `public.profiles` for spin tracking (pulse_dial_last_spin, pulse_dial_total_spins, pulse_dial_total_skit)
--   2. Dedicated `public.pulse_spins` table for historical audit logs
--   3. Authoritative atomic RPC `claim_pulse_spin_reward` (enforces 4-hour cooldown, validates 1/2/3/5 SKIT, credits available_balance at 1 SKIT = $0.001 USD)
--   4. RLS policies and grants for authenticated & anon access
-- ============================================================================

-- ─── 1. Add Pulse Dial columns to profiles ──────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS pulse_dial_last_spin TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pulse_dial_total_spins INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pulse_dial_total_skit NUMERIC(12, 3) DEFAULT 0;

-- ─── 2. Create `pulse_spins` history table ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pulse_spins (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  skit_reward      NUMERIC(6, 2) NOT NULL CHECK (skit_reward IN (1, 2, 3, 5)),
  usd_reward       NUMERIC(10, 6) NOT NULL,
  spun_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  client_context   JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_pulse_spins_user
  ON public.pulse_spins (user_id, spun_at DESC);

-- Enable RLS
ALTER TABLE public.pulse_spins ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Users can read own pulse spins"
    ON public.pulse_spins FOR SELECT
    USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── 3. Atomic RPC `claim_pulse_spin_reward` ────────────────────────────────
-- Authoritatively checks the 4-hour cooldown and atomically credits balance.
CREATE OR REPLACE FUNCTION public.claim_pulse_spin_reward(
  p_user_id        UUID,
  p_skit_reward    NUMERIC,
  p_client_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_last_spin       TIMESTAMPTZ;
  v_cooldown_secs   INTEGER := 14400; -- 4 hours in seconds
  v_elapsed_secs    INTEGER;
  v_remaining_secs  INTEGER;
  v_usd_reward      NUMERIC(10, 6);
  v_cur_balance     NUMERIC(12, 6);
  v_new_balance     NUMERIC(12, 6);
  v_total_spins     INTEGER;
  v_total_skit      NUMERIC(12, 3);
BEGIN
  -- 1. Validate SKIT reward: strictly 1, 2, 3, or 5
  IF p_skit_reward NOT IN (1, 2, 3, 5) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Invalid reward tier. Must be 1, 2, 3, or 5 SKIT.'
    );
  END IF;

  -- 1 SKIT = $0.001 USD
  v_usd_reward := ROUND((p_skit_reward * 0.001)::NUMERIC, 6);

  -- 2. Lock profile row for update
  SELECT 
    available_balance,
    pulse_dial_last_spin,
    COALESCE(pulse_dial_total_spins, 0),
    COALESCE(pulse_dial_total_skit, 0)
  INTO 
    v_cur_balance,
    v_last_spin,
    v_total_spins,
    v_total_skit
  FROM public.profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'User profile not found.'
    );
  END IF;

  -- 3. Check 4-hour Cooldown
  IF v_last_spin IS NOT NULL THEN
    v_elapsed_secs := EXTRACT(EPOCH FROM (NOW() - v_last_spin))::INTEGER;
    IF v_elapsed_secs < v_cooldown_secs THEN
      v_remaining_secs := v_cooldown_secs - v_elapsed_secs;
      RETURN jsonb_build_object(
        'success', false,
        'cooldown_active', true,
        'remaining_seconds', v_remaining_secs,
        'last_spin_at', v_last_spin,
        'error', 'Pulse Dial is recharging. Cooldown active.'
      );
    END IF;
  END IF;

  -- 4. Apply balance increment & update spin counters
  v_new_balance := COALESCE(v_cur_balance, 0) + v_usd_reward;
  v_total_spins := v_total_spins + 1;
  v_total_skit  := v_total_skit + p_skit_reward;

  UPDATE public.profiles
  SET
    available_balance     = v_new_balance,
    pulse_dial_last_spin  = NOW(),
    pulse_dial_total_spins = v_total_spins,
    pulse_dial_total_skit = v_total_skit,
    updated_at            = NOW()
  WHERE id = p_user_id;

  -- 5. Record in pulse_spins table
  INSERT INTO public.pulse_spins (
    user_id,
    skit_reward,
    usd_reward,
    spun_at,
    client_context
  ) VALUES (
    p_user_id,
    p_skit_reward,
    v_usd_reward,
    NOW(),
    p_client_context
  );

  -- 6. Record in activity_ledger for unified user history
  BEGIN
    INSERT INTO public.activity_ledger (
      user_id,
      type,
      amount,
      method,
      status,
      created_at
    ) VALUES (
      p_user_id,
      'pulse_spin',
      v_usd_reward,
      'Pulse Dial (' || p_skit_reward::TEXT || ' SKIT)',
      'Credited',
      NOW()
    );
  EXCEPTION WHEN OTHERS THEN
    -- non-fatal fallback
    NULL;
  END;

  -- 7. Return detailed success receipt
  RETURN jsonb_build_object(
    'success', true,
    'skit_reward', p_skit_reward,
    'usd_reward', v_usd_reward,
    'new_balance', v_new_balance,
    'total_spins', v_total_spins,
    'total_skit', v_total_skit,
    'last_spin_at', NOW(),
    'next_spin_at', NOW() + INTERVAL '4 hours'
  );
END;
$$;

-- Grant execution permissions
GRANT EXECUTE ON FUNCTION public.claim_pulse_spin_reward(UUID, NUMERIC, JSONB) TO authenticated, anon, service_role;
