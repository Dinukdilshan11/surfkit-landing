-- ============================================================
-- Surfkit — Referral Commission System Migration
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================

-- 1. Ensure referrals table has needed columns
ALTER TABLE public.referrals
  ADD COLUMN IF NOT EXISTS commission_earned   NUMERIC(14, 6) DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS daily_impressions   INTEGER        DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status              TEXT           DEFAULT 'Active',
  ADD COLUMN IF NOT EXISTS referred_handle     TEXT,
  ADD COLUMN IF NOT EXISTS joined_at           TIMESTAMPTZ    DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMPTZ    DEFAULT NOW();

-- Unique index so upserts work
CREATE UNIQUE INDEX IF NOT EXISTS referrals_referrer_referred_idx
  ON public.referrals (referrer_id, referred_id);

-- 2. Ensure profiles table has referred_by and referral_bonus columns
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS referred_by      UUID REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS referral_bonus   NUMERIC(14, 6) DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS referral_code    TEXT;

-- ============================================================
-- 3. credit_referral_commission RPC
--    Called by the frontend after every ad impression.
--    Credits 10% of the impression earning to the referrer.
-- ============================================================
CREATE OR REPLACE FUNCTION public.credit_referral_commission(
  p_referrer_id  UUID,
  p_referred_id  UUID,
  p_commission   NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Guard: commission must be positive
  IF p_commission <= 0 THEN RETURN; END IF;

  -- Update referrer's profile balance atomically
  UPDATE public.profiles
  SET
    available_balance  = COALESCE(available_balance, 0) + p_commission,
    lifetime_earnings  = COALESCE(lifetime_earnings, 0) + p_commission,
    referral_bonus     = COALESCE(referral_bonus, 0)    + p_commission,
    updated_at         = NOW()
  WHERE id = p_referrer_id;

  -- Upsert referrals row: increment commission_earned
  INSERT INTO public.referrals (referrer_id, referred_id, commission_earned, status, updated_at)
  VALUES (p_referrer_id, p_referred_id, p_commission, 'Active', NOW())
  ON CONFLICT (referrer_id, referred_id)
  DO UPDATE SET
    commission_earned = public.referrals.commission_earned + EXCLUDED.commission_earned,
    status            = 'Active',
    updated_at        = NOW();
END;
$$;

-- ============================================================
-- 4. increment_referral_commission RPC (alias / fallback)
-- ============================================================
CREATE OR REPLACE FUNCTION public.increment_referral_commission(
  p_referrer_id  UUID,
  p_referred_id  UUID,
  p_amount       NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM public.credit_referral_commission(p_referrer_id, p_referred_id, p_amount);
END;
$$;

-- ============================================================
-- 5. Auto-trigger: credit commission whenever ad_impressions row is inserted
--    This runs server-side so even extension-only users get commissions tracked.
-- ============================================================
CREATE OR REPLACE FUNCTION public.trg_credit_referral_on_impression()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_referrer_id  UUID;
  v_earn         NUMERIC;
  v_commission   NUMERIC;
BEGIN
  -- Get the earning value from the new impression row
  v_earn := COALESCE(NEW.earning_usd, NEW.earn, NEW.earnings, 0);
  IF v_earn <= 0 THEN RETURN NEW; END IF;

  -- Look up if this user was referred by someone
  SELECT referred_by INTO v_referrer_id
  FROM public.profiles
  WHERE id = NEW.user_id
  LIMIT 1;

  IF v_referrer_id IS NULL THEN RETURN NEW; END IF;

  v_commission := ROUND(v_earn * 0.10, 6);

  -- Credit the commission
  PERFORM public.credit_referral_commission(v_referrer_id, NEW.user_id, v_commission);

  RETURN NEW;
END;
$$;

-- Attach trigger to ad_impressions table (safe — only creates if ad_impressions exists)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ad_impressions'
  ) THEN
    DROP TRIGGER IF EXISTS trg_referral_commission ON public.ad_impressions;
    CREATE TRIGGER trg_referral_commission
      AFTER INSERT ON public.ad_impressions
      FOR EACH ROW EXECUTE FUNCTION public.trg_credit_referral_on_impression();
  END IF;
END;
$$;

-- ============================================================
-- 6. Grant execute permissions to authenticated role
-- ============================================================
GRANT EXECUTE ON FUNCTION public.credit_referral_commission(UUID, UUID, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.increment_referral_commission(UUID, UUID, NUMERIC) TO authenticated;

-- ============================================================
-- Done. Run this once in Supabase SQL Editor.
-- ============================================================
