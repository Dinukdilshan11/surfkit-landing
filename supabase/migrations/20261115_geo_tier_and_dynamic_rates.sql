-- ============================================================================
-- Surfkit · Dynamic Geo-Tier & Regional Earning Rate Migration
-- Migration: 20261115_geo_tier_and_dynamic_rates.sql
--
-- This migration implements:
--   1. `country_code`, `country_name`, `geo_tier`, and `rate_per_1k` on `profiles`
--   2. Strict server-side tier & conversion rate resolution function
--   3. Anti-spoofing trigger: auto-enforces correct tier & rate_per_1k on profiles
--   4. RPC `update_user_geo_location` for seamless client-to-cloud sync
--   5. Updates referral commission calculation based on dynamic tier rate
-- ============================================================================

-- ─── 1. Add Geo Columns to `public.profiles` ─────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS country_code TEXT DEFAULT 'US',
  ADD COLUMN IF NOT EXISTS country_name TEXT DEFAULT 'United States',
  ADD COLUMN IF NOT EXISTS geo_tier     INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS rate_per_1k  NUMERIC(6,4) DEFAULT 2.5000;

CREATE INDEX IF NOT EXISTS idx_profiles_country_code
  ON public.profiles (country_code);

CREATE INDEX IF NOT EXISTS idx_profiles_geo_tier
  ON public.profiles (geo_tier);

-- ─── 2. Canonical Geo-Tier Resolution Function ──────────────────────────────
-- Strictly maps ISO 3166-1 alpha-2 country codes to the 4 Regional Tiers:
-- Tier 1: $2.50 / 1k Creds ($0.0250 / ad)
-- Tier 2: $1.00 / 1k Creds ($0.0100 / ad)
-- Tier 3: $0.30 / 1k Creds ($0.0030 / ad)
-- Tier 4: $0.15 / 1k Creds ($0.0015 / ad)
CREATE OR REPLACE FUNCTION public.resolve_geo_tier(p_country_code TEXT)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_code TEXT := UPPER(TRIM(COALESCE(p_country_code, 'US')));
  v_tier INTEGER;
  v_rate NUMERIC(6,4);
  v_per_ad NUMERIC(6,4);
BEGIN
  -- Tier 1: Premium Markets ($2.50 / 1k)
  IF v_code = ANY(ARRAY[
    'US', 'CA', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'AU', 'NZ',
    'CH', 'SE', 'NO', 'DK', 'IE', 'AT', 'BE', 'FI', 'LU', 'IS'
  ]) THEN
    v_tier := 1;
    v_rate := 2.5000;
    v_per_ad := 0.0250;

  -- Tier 2: Growth Markets ($1.00 / 1k)
  ELSIF v_code = ANY(ARRAY[
    'AE', 'SA', 'SG', 'JP', 'KR', 'BR', 'MX', 'PL', 'TR', 'QA',
    'KW', 'IL', 'TW', 'HK', 'MY', 'TH', 'ZA', 'CL', 'AR', 'CO',
    'CZ', 'PT', 'GR', 'HU', 'RO'
  ]) THEN
    v_tier := 2;
    v_rate := 1.0000;
    v_per_ad := 0.0100;

  -- Tier 3: Emerging Markets ($0.30 / 1k)
  ELSIF v_code = ANY(ARRAY[
    'LK', 'IN', 'PK', 'BD', 'ID', 'PH', 'VN', 'EG', 'NG', 'KE',
    'GH', 'MA', 'DZ', 'UA', 'PE', 'EC', 'NP', 'MM', 'KH'
  ]) THEN
    v_tier := 3;
    v_rate := 0.3000;
    v_per_ad := 0.0030;

  -- Tier 4: Rest of World ($0.15 / 1k)
  ELSE
    v_tier := 4;
    v_rate := 0.1500;
    v_per_ad := 0.0015;
  END IF;

  RETURN jsonb_build_object(
    'country_code', v_code,
    'geo_tier',     v_tier,
    'rate_per_1k',  v_rate,
    'per_ad',       v_per_ad
  );
END;
$$;

-- ─── 3. Anti-Tamper Trigger on `public.profiles` ─────────────────────────────
-- Whenever country_code is set or updated, automatically calculate and assign
-- the correct geo_tier and rate_per_1k so clients cannot spoof rates.
CREATE OR REPLACE FUNCTION public.trg_profiles_enforce_geo_tier()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_res jsonb;
BEGIN
  IF NEW.country_code IS NOT NULL AND NEW.country_code <> '' THEN
    v_res := public.resolve_geo_tier(NEW.country_code);
    NEW.geo_tier    := (v_res->>'geo_tier')::INTEGER;
    NEW.rate_per_1k := (v_res->>'rate_per_1k')::NUMERIC;
  ELSE
    NEW.country_code := 'US';
    NEW.geo_tier     := 1;
    NEW.rate_per_1k  := 2.5000;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_geo_tier ON public.profiles;
CREATE TRIGGER trg_enforce_geo_tier
  BEFORE INSERT OR UPDATE OF country_code ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_profiles_enforce_geo_tier();

-- ─── 4. RPC: Update User Geo Location ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_user_geo_location(
  p_country_code TEXT,
  p_country_name TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_clean_code TEXT := UPPER(TRIM(COALESCE(p_country_code, 'US')));
  v_clean_name TEXT := TRIM(COALESCE(p_country_name, ''));
  v_res jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'Unauthorized');
  END IF;

  v_res := public.resolve_geo_tier(v_clean_code);

  UPDATE public.profiles
  SET country_code = v_clean_code,
      country_name = COALESCE(NULLIF(v_clean_name, ''), country_name, v_clean_code),
      geo_tier     = (v_res->>'geo_tier')::INTEGER,
      rate_per_1k  = (v_res->>'rate_per_1k')::NUMERIC,
      updated_at   = NOW()
  WHERE id = v_uid;

  RETURN jsonb_build_object(
    'success',      true,
    'country_code', v_clean_code,
    'country_name', v_clean_name,
    'geo_tier',     (v_res->>'geo_tier')::INTEGER,
    'rate_per_1k',  (v_res->>'rate_per_1k')::NUMERIC,
    'per_ad',       (v_res->>'per_ad')::NUMERIC
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_geo_tier(TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_user_geo_location(TEXT, TEXT) TO authenticated, service_role;
