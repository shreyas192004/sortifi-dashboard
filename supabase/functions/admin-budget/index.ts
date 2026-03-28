import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const anonClient = createClient(supabaseUrl, anonKey);
    const token = authHeader.replace("Bearer ", "");
    const {
      data: { user },
      error: userError,
    } = await anonClient.auth.getUser(token);

    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const serviceClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: roleRows, error: roleError } = await serviceClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .eq("role", "admin")
      .limit(1);

    if (roleError) throw roleError;
    if (!roleRows || roleRows.length === 0) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      .toISOString()
      .slice(0, 10);

    const budgetLimitInr = Number(Deno.env.get("AI_BUDGET_LIMIT_INR") || "100");

    const { data: current, error: currentError } = await serviceClient
      .from("ai_monthly_budget_usage")
      .select("month_start, spent_inr, updated_at")
      .eq("month_start", monthStart)
      .maybeSingle();

    if (currentError) throw currentError;

    const { data: history, error: historyError } = await serviceClient
      .from("ai_monthly_budget_usage")
      .select("month_start, spent_inr")
      .order("month_start", { ascending: false })
      .limit(6);

    if (historyError) throw historyError;

    const spentInr = Number(current?.spent_inr || 0);
    const remainingInr = Math.max(0, budgetLimitInr - spentInr);
    const utilizationPercent = budgetLimitInr > 0
      ? Math.min(100, (spentInr / budgetLimitInr) * 100)
      : 0;

    return new Response(
      JSON.stringify({
        monthStart,
        budgetLimitInr,
        spentInr,
        remainingInr,
        utilizationPercent,
        lastUpdated: current?.updated_at || null,
        history: history || [],
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("admin-budget error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
