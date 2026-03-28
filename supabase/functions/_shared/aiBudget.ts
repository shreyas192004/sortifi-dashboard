export async function consumeAiBudget(
  supabase: any,
  incrementInr: number,
  limitInr = 100,
): Promise<boolean> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);

  const { data, error } = await supabase.rpc("consume_ai_budget_inr", {
    p_month_start: monthStart,
    p_increment_inr: incrementInr,
    p_limit_inr: limitInr,
  });

  if (error) {
    throw new Error(`AI budget check failed: ${error.message}`);
  }

  return Boolean(data);
}
