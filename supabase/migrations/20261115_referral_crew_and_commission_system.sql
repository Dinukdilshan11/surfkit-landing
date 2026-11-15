-- ============================================================================
-- Surfkit · Referral Crew & 10% Commission System Migration
-- Migration: 20261115_referral_crew_and_commission_system.sql
--
-- This migration implements:
--   1. `referral_code`, `referred_by`, `referral_bonus`, and `referral_earnings`
--      columns on `public.profiles`
--   2. Automatic generation trigger for all newly registered users (`sk_<8_hex>`)
--   3. Backfill of unique referral codes for all existing profiles
--   4. Prerequisite `public.referrals` table with unique constraint on (referrer_id, referred_id)
--   5. `attribute_user_referral` RPC: binds new users to referrer and creates crew entry
--   6. `get_or_create_referral_code` RPC: retrieves/creates code with https://surfkit.cloud/?ref=
--   7. Automated 10% passive commission trigger on ad impressions & rewards
--   8. Row-Level Security (RLS) policies for authenticated crew access
-- ============================================================================

-- ─── 1. Update `public.profiles` table ──────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS referral_code      TEXT,
  ADD COLUMN IF NOT EXISTS referred_by        UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS referral_bonus     NUMERIC(12,6) NOT NULL DEFAULT 0.000000,
  ADD COLUMN IF NOT EXISTS referral_earnings  NUMERIC(12,6) NOT NULL DEFAULT 0.000000;

-- Backfill any existing profiles lacking a referral code
UPDATE public.profiles
SET referral_code = 'sk_' || lower(substr(md5(id::text || clock_timestamp()::text || random()::text), 1, 8))
WHERE referral_code IS NULL OR referral_code = '';

-- Ensure referral_code has UNIQUE constraint & index
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_referral_code_unique'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_referral_code_unique UNIQUE (referral_code);
  END IF;
EXCEPTION
  WHEN duplicate_table OR duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_profiles_referral_code
  ON public.profiles (referral_code);

CREATE INDEX IF NOT EXISTS idx_profiles_referred_by
  ON public.profiles (referred_by);

-- ─── 2. Auto-generate referral code helper & trigger ────────────────────────
CREATE OR REPLACE FUNCTION public.generate_unique_referral_code()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_code   TEXT;
  v_exists BOOLEAN;
BEGIN
  LOOP
    -- Generates an anonymous alphanumeric code: 'sk_' + 8 hex chars (e.g. sk_c84cdf74)
    v_code := 'sk_' || lower(substr(md5(gen_random_uuid()::text || clock_timestamp()::text || random()::text), 1, 8));
    SELECT EXISTS(SELECT 1 FROM public.profiles WHERE referral_code = v_code) INTO v_exists;
    IF NOT v_exists THEN
      RETURN v_code;
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_profiles_assign_referral_code()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.referral_code IS NULL OR NEW.referral_code = '' THEN
    NEW.referral_code := public.generate_unique_referral_code();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assign_referral_code ON public.profiles;
CREATE TRIGGER trg_assign_referral_code
  BEFORE INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_profiles_assign_referral_code();

-- ─── 3. Create or Update `public.referrals` table ────────────────────────────
CREATE TABLE IF NOT EXISTS public.referrals (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id       UUID          NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  referred_id       UUID          NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  referred_handle   TEXT,
  commission_earned NUMERIC(12,6) NOT NULL DEFAULT 0.000000,
  daily_impressions INTEGER       NOT NULL DEFAULT 0,
  status            TEXT          NOT NULL DEFAULT 'Active',
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'referrals_referrer_referred_unique'
  ) THEN
    ALTER TABLE public.referrals
      ADD CONSTRAINT referrals_referrer_referred_unique UNIQUE (referrer_id, referred_id);
  END IF;
EXCEPTION
  WHEN duplicate_table OR duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id
  ON public.referrals (referrer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_referrals_referred_id
  ON public.referrals (referred_id);

ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Referrers can view their own crew" ON public.referrals;
CREATE POLICY "Referrers can view their own crew"
  ON public.referrals
  FOR SELECT
  TO authenticated, anon
  USING (
    referrer_id = auth.uid() OR auth.uid() IS NULL
  );

DROP POLICY IF EXISTS "Service role full access on referrals" ON public.referrals;
CREATE POLICY "Service role full access on referrals"
  ON public.referrals
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ─── 4. RPC: Attribute User Referral ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.attribute_user_referral(
  p_new_user_id    UUID,
  p_ref_identifier TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cleaned_id    TEXT := TRIM(COALESCE(p_ref_identifier, ''));
  v_referrer_id   UUID;
  v_referrer_code TEXT;
  v_referrer_name TEXT;
  v_new_user      RECORD;
  v_already_ref   BOOLEAN;
BEGIN
  IF p_new_user_id IS NULL OR v_cleaned_id = '' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'Missing required user ID or referral identifier');
  END IF;

  -- Verify new user exists
  SELECT * INTO v_new_user FROM public.profiles WHERE id = p_new_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'New user profile not found');
  END IF;

  -- Prevent re-attribution if user already has a referrer
  IF v_new_user.referred_by IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'User is already attributed to a referrer');
  END IF;

  -- 1. Resolve referrer by referral code (e.g. 'sk_c84cdf74')
  SELECT p.id, p.referral_code, COALESCE(p.username, p.display_name, 'Crew Leader')
    INTO v_referrer_id, v_referrer_code, v_referrer_name
  FROM public.profiles p
  WHERE lower(p.referral_code) = lower(v_cleaned_id)
  LIMIT 1;

  -- 2. Fallback: Resolve by username or display_name
  IF v_referrer_id IS NULL THEN
    SELECT p.id, p.referral_code, COALESCE(p.username, p.display_name, 'Crew Leader')
      INTO v_referrer_id, v_referrer_code, v_referrer_name
    FROM public.profiles p
    WHERE lower(p.username) = lower(v_cleaned_id)
       OR lower(p.display_name) = lower(v_cleaned_id)
    LIMIT 1;
  END IF;

  IF v_referrer_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'Referrer not found for identifier');
  END IF;

  -- Prevent self-referral
  IF v_referrer_id = p_new_user_id THEN
    RETURN jsonb_build_object('success', false, 'reason', 'Self-referral is not permitted');
  END IF;

  -- Bind referred_by on new user profile
  UPDATE public.profiles
  SET referred_by = v_referrer_id,
      updated_at  = NOW()
  WHERE id = p_new_user_id
    AND referred_by IS NULL;

  -- Record in public.referrals table
  INSERT INTO public.referrals (
    referrer_id,
    referred_id,
    referred_handle,
    commission_earned,
    daily_impressions,
    status,
    created_at,
    updated_at
  ) VALUES (
    v_referrer_id,
    p_new_user_id,
    COALESCE('@' || NULLIF(v_new_user.username, ''), '@' || NULLIF(v_new_user.display_name, ''), '@crew_mate'),
    0.000000,
    0,
    'Active',
    NOW(),
    NOW()
  )
  ON CONFLICT (referrer_id, referred_id) DO NOTHING;

  -- Send in-app notification to the referrer
  BEGIN
    INSERT INTO public.notifications (user_id, user_email, title, message, is_read, created_at)
    VALUES (
      v_referrer_id,
      (SELECT email FROM public.profiles WHERE id = v_referrer_id),
      'New Crew Member Joined',
      'A new user joined using your invite link! You will earn a passive 10% commission on their browsing rewards.',
      false,
      NOW()
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'success',        true,
    'referrer_id',    v_referrer_id,
    'referral_code',  v_referrer_code,
    'referred_user',  p_new_user_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.attribute_user_referral(UUID, TEXT)
  TO anon, authenticated, service_role;

-- ─── 5. RPC: Get or Create Referral Code on Demand ──────────────────────────
CREATE OR REPLACE FUNCTION public.get_or_create_referral_code(p_user_id UUID)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code TEXT;
BEGIN
  SELECT referral_code INTO v_code FROM public.profiles WHERE id = p_user_id;

  IF v_code IS NULL OR v_code = '' THEN
    v_code := public.generate_unique_referral_code();
    UPDATE public.profiles
    SET referral_code = v_code,
        updated_at    = NOW()
    WHERE id = p_user_id;
  END IF;

  RETURN jsonb_build_object(
    'user_id',       p_user_id,
    'referral_code', v_code,
    'invite_url',    'https://surfkit.cloud/?ref=' || v_code
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_or_create_referral_code(UUID)
  TO anon, authenticated, service_role;

-- ─── 6. Automated 10% Commission Calculation Trigger ────────────────────────
-- Automatically calculates and credits 10% passive commission to the referrer
-- whenever a referred user earns browsing ad impression rewards.
CREATE OR REPLACE FUNCTION public.process_referral_commission()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_referrer_id UUID;
  v_base_earning NUMERIC(12,6);
  v_commission   NUMERIC(12,6);
BEGIN
  -- Check if user has an active referrer
  SELECT referred_by INTO v_referrer_id
  FROM public.profiles
  WHERE id = NEW.user_id;

  IF v_referrer_id IS NOT NULL AND v_referrer_id <> NEW.user_id THEN
    -- Determine the earning amount: either from 'earning', 'amount', or default rate $0.0005/ad
    v_base_earning := COALESCE(
      (CASE WHEN TG_TABLE_NAME = 'ad_impressions' THEN COALESCE(NEW.earning, 0.0005) ELSE NEW.amount END),
      0.0005
    );
    -- 10% passive commission calculation
    v_commission := ROUND(v_base_earning * 0.10, 6);

    IF v_commission > 0 THEN
      -- 1. Credit referrer balance & referral stats
      UPDATE public.profiles
      SET available_balance = available_balance + v_commission,
          referral_bonus    = COALESCE(referral_bonus, 0) + v_commission,
          referral_earnings = COALESCE(referral_earnings, 0) + v_commission,
          lifetime_earnings = lifetime_earnings + v_commission,
          updated_at        = NOW()
      WHERE id = v_referrer_id;

      -- 2. Update stats on public.referrals ledger row
      UPDATE public.referrals
      SET commission_earned = commission_earned + v_commission,
          daily_impressions = daily_impressions + 1,
          status            = 'Online & Earning',
          updated_at        = NOW()
      WHERE referrer_id = v_referrer_id AND referred_id = NEW.user_id;
    END IF;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Non-blocking: ensure ad impression recording never fails due to commission logging
  RETURN NEW;
END;
$$;

-- Attach trigger to ad_impressions if table exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ad_impressions') THEN
    DROP TRIGGER IF EXISTS trg_ad_impressions_referral_commission ON public.ad_impressions;
    CREATE TRIGGER trg_ad_impressions_referral_commission
      AFTER INSERT ON public.ad_impressions
      FOR EACH ROW
      EXECUTE FUNCTION public.process_referral_commission();
  END IF;
END $$;
