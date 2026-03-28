CREATE TABLE IF NOT EXISTS public.ai_monthly_budget_usage (
  month_start date PRIMARY KEY,
  spent_inr numeric(12, 4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_monthly_budget_usage ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.consume_ai_budget_inr(
  p_month_start date,
  p_increment_inr numeric,
  p_limit_inr numeric DEFAULT 100
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_increment_inr <= 0 THEN
    RETURN true;
  END IF;

  INSERT INTO public.ai_monthly_budget_usage (month_start, spent_inr)
  VALUES (p_month_start, 0)
  ON CONFLICT (month_start) DO NOTHING;

  UPDATE public.ai_monthly_budget_usage
  SET spent_inr = spent_inr + p_increment_inr,
      updated_at = now()
  WHERE month_start = p_month_start
    AND (spent_inr + p_increment_inr) <= p_limit_inr;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_ai_budget_inr(date, numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_ai_budget_inr(date, numeric, numeric) TO service_role;
