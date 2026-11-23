-- ============================================================================
-- Surfkit · Update Pulse Dial Spin Rewards to 0, 0.5, 1, 2, 3, 5 SKIT
-- Migration: 20261123_update_spin_rewards_0_5.sql
--
-- This migration updates:
--   1. The check constraint on `public.pulse_spins` to allow 0, 0.5, 1, 2, 3, and 5 SKIT
--   2. Authoritative atomic RPC `claim_pulse_spin_reward` to validate and credit 0, 0.5, 1, 2, 3, 5 SKIT
-- ============================================================================

-- 1. Update check constraint on pulse_spins
ALTER TABLE public.pulse_spins
  DROP CONSTRAINT IF EXISTS pulse_spins_skit_reward_check;

ALTER TABLE public.pulse_spins
  ADD CONSTRAINT pulse_spins_skit_reward_check
  CHECK (skit_reward IN (0, 0.5, 1, 2, 3, 5));

-- 2. Update claim_pulse_spin_reward RPC
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
  -- 1. Validate SKIT reward: strictly 0, 0.5, 1, 2, 3, or 5
  IF p_skit_reward NOT IN (0, 0.5, 1, 2, 3, 5) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Invalid reward tier. Must be 0, 0.5, 1, 2, 3, or 5 SKIT.'
    );
  END IF;

  -- 1 SKIT = $0.001 USD (0.5 SKIT = $0.0005 USD, 0 SKIT = $0.0000 USD)
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
    available_balance      = v_new_balance,
    lifetime_earnings      = COALESCE(lifetime_earnings, 0) + v_usd_reward,
    daily_earnings         = COALESCE(daily_earnings, 0) + v_usd_reward,
    completed_activities   = COALESCE(completed_activities, 0) + 1,
    four_hour_spins        = v_total_spins,
    pulse_dial_last_spin   = NOW(),
    last_spin_at           = NOW(),
    pulse_dial_total_spins = v_total_spins,
    pulse_dial_total_skit  = v_total_skit
  WHERE id = p_user_id;

  -- 5. Record to audit ledger
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

  RETURN jsonb_build_object(
    'success', true,
    'skit_reward', p_skit_reward,
    'usd_reward', v_usd_reward,
    'new_balance', v_new_balance,
    'total_spins', v_total_spins,
    'total_skit', v_total_skit,
    'spun_at', NOW()
  );
END;
$$;
