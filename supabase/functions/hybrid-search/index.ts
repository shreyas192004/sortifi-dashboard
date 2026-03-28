import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { consumeAiBudget } from "../_shared/aiBudget.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Intent detection patterns
const ID_PATTERNS: { type: string; regex: RegExp }[] = [
  { type: "pan", regex: /\b([A-Z]{5}\d{4}[A-Z])\b/ },
  { type: "aadhaar", regex: /\b(\d{4}\s?\d{4}\s?\d{4})\b/ },
  { type: "gst", regex: /\b(\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z\d]{2})\b/ },
  { type: "invoice", regex: /\b(INV[\-\/]?\d{4,})\b/i },
  { type: "date", regex: /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/ },
];

function detectIntent(query: string): { type: string; value: string } | null {
  for (const { type, regex } of ID_PATTERNS) {
    const match = query.match(regex);
    if (match) return { type, value: match[1].replace(/\s/g, "") };
  }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
    const canUseAiGateway = Boolean(lovableApiKey);

    const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await anonClient.auth.getUser(token);
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, serviceKey);
    const { query } = await req.json();
    if (!query?.trim()) throw new Error("Missing query");

    // ── Step 1: Intent Detection ──
    const intent = detectIntent(query);
    let entityResults: any[] = [];

    if (intent) {
      const { data } = await supabase.rpc("search_files_by_entity", {
        _user_id: user.id,
        _entity_value: intent.value,
        _limit: 10,
      });
      entityResults = data || [];
    }

    // ── Step 2: AI Query Expansion ──
    let expandedTerms = "";
    if (canUseAiGateway) {
      try {
        const expandWithinBudget = await consumeAiBudget(supabase, 0.06, 100);
        if (!expandWithinBudget) {
          return new Response(JSON.stringify({ error: "Monthly AI budget limit reached (₹100)", results: [], total: 0 }), {
            status: 402,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const expandResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${lovableApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash-lite",
            messages: [
              {
                role: "system",
                content: `Generate 10-15 search synonyms/related terms for the query. Include Hindi equivalents. Return comma-separated terms only.`,
              },
              { role: "user", content: query },
            ],
            tools: [{
              type: "function",
              function: {
                name: "return_terms",
                description: "Return expanded terms",
                parameters: {
                  type: "object",
                  properties: { terms: { type: "array", items: { type: "string" } } },
                  required: ["terms"],
                  additionalProperties: false,
                },
              },
            }],
            tool_choice: { type: "function", function: { name: "return_terms" } },
          }),
        });

        if (expandResp.ok) {
          const expandData = await expandResp.json();
          const toolCall = expandData.choices?.[0]?.message?.tool_calls?.[0];
          if (toolCall) {
            const { terms } = JSON.parse(toolCall.function.arguments);
            expandedTerms = (terms || []).join(" ");
          }
        }
      } catch (e) {
        console.error("Query expansion error:", e);
      }
    }

    // ── Step 3: PostgreSQL Full-Text Search + Trigram ──
    const { data: ftsResults, error: ftsError } = await supabase.rpc("search_files_hybrid", {
      _user_id: user.id,
      _query: query,
      _expanded_terms: expandedTerms,
      _limit: 20,
    });

    if (ftsError) {
      console.error("FTS error:", ftsError);
    }

    // ── Step 4: Reciprocal Rank Fusion ──
    const scoreMap = new Map<string, { file: any; rrf_score: number }>();

    // Add entity results with high RRF boost
    entityResults.forEach((file, i) => {
      const rrf = 1 / (i + 1); // Higher weight for entity matches
      const existing = scoreMap.get(file.id);
      if (existing) {
        existing.rrf_score += rrf * 2; // Double weight for exact entity matches
      } else {
        scoreMap.set(file.id, { file, rrf_score: rrf * 2 });
      }
    });

    // Add FTS results
    (ftsResults || []).forEach((file: any, i: number) => {
      const rrf = 1 / (i + 1 + 60); // k=60 standard RRF constant
      const ftsBoost = file.fts_rank > 0 ? 1 + file.fts_rank : 1;
      const nameBoost = file.name_similarity > 0.3 ? 1.5 : 1;
      const existing = scoreMap.get(file.id);
      if (existing) {
        existing.rrf_score += rrf * ftsBoost * nameBoost;
        existing.file = { ...existing.file, ...file }; // Merge full data
      } else {
        scoreMap.set(file.id, { file, rrf_score: rrf * ftsBoost * nameBoost });
      }
    });

    // Sort by RRF score
    let mergedResults = Array.from(scoreMap.values())
      .sort((a, b) => b.rrf_score - a.rrf_score)
      .slice(0, 15);

    // ── Step 5: AI Reranking of top results ──
    if (mergedResults.length > 1 && canUseAiGateway) {
      try {
        const rerankWithinBudget = await consumeAiBudget(supabase, 0.06, 100);
        if (!rerankWithinBudget) {
          return new Response(JSON.stringify({ error: "Monthly AI budget limit reached (₹100)", results: [], total: 0 }), {
            status: 402,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const rerankResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${lovableApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash-lite",
            messages: [
              {
                role: "system",
                content: `You are a document relevance ranker. Given a search query and candidate documents, rank them by relevance. Return file IDs ordered by relevance with a confidence score (0-1) for each.`,
              },
              {
                role: "user",
                content: `Query: "${query}"

Documents:
${mergedResults.map(({ file }) => `ID: ${file.id} | Name: ${file.file_name} | Summary: ${(file.ai_summary || "").substring(0, 150)} | Entities: ${JSON.stringify((file.entities || []).slice(0, 5))}`).join("\n")}`,
              },
            ],
            tools: [{
              type: "function",
              function: {
                name: "rank_results",
                description: "Rank search results by relevance",
                parameters: {
                  type: "object",
                  properties: {
                    ranked: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          fileId: { type: "string" },
                          confidence: { type: "number", minimum: 0, maximum: 1 },
                          reason: { type: "string", description: "Brief reason for relevance" },
                        },
                        required: ["fileId", "confidence", "reason"],
                        additionalProperties: false,
                      },
                    },
                  },
                  required: ["ranked"],
                  additionalProperties: false,
                },
              },
            }],
            tool_choice: { type: "function", function: { name: "rank_results" } },
          }),
        });

        if (rerankResp.ok) {
          const rerankData = await rerankResp.json();
          const toolCall = rerankData.choices?.[0]?.message?.tool_calls?.[0];
          if (toolCall) {
            const { ranked } = JSON.parse(toolCall.function.arguments);
            if (ranked?.length > 0) {
              // Re-order results based on AI ranking
              const rankMap = new Map(ranked.map((r: any, i: number) => [r.fileId, { index: i, confidence: r.confidence, reason: r.reason }]));
              mergedResults = mergedResults.map((item) => {
                const rank = rankMap.get(item.file.id);
                return {
                  ...item,
                  ai_confidence: rank?.confidence ?? 0.3,
                  ai_reason: rank?.reason ?? "",
                  ai_rank: rank?.index ?? 999,
                };
              }).sort((a: any, b: any) => {
                // Primary: AI rank, Secondary: RRF score
                if (a.ai_rank !== b.ai_rank) return a.ai_rank - b.ai_rank;
                return b.rrf_score - a.rrf_score;
              });
            }
          }
        }
      } catch (e) {
        console.error("AI reranking error:", e);
        // Fall back to RRF order, assign default confidence
        mergedResults = mergedResults.map((item) => ({
          ...item,
          ai_confidence: Math.min(0.95, item.rrf_score * 2),
          ai_reason: "",
          ai_rank: 0,
        }));
      }
    } else if (mergedResults.length === 1) {
      mergedResults[0] = { ...mergedResults[0], ai_confidence: 0.9, ai_reason: "Only match", ai_rank: 0 } as any;
    }

    // ── Step 6: Format response ──
    const results = mergedResults.map((item: any) => ({
      id: item.file.id,
      file_name: item.file.file_name,
      file_url: item.file.file_url,
      file_type: item.file.file_type,
      file_size: item.file.file_size,
      ai_summary: item.file.ai_summary,
      ai_description: item.file.ai_description,
      entities: item.file.entities,
      expiry_date: item.file.expiry_date,
      upload_date: item.file.upload_date,
      confidence: item.ai_confidence ?? Math.min(0.95, item.rrf_score * 2),
      reason: item.ai_reason ?? "",
      rrf_score: item.rrf_score,
    }));

    return new Response(JSON.stringify({
      results,
      intent: intent ? { type: intent.type, value: intent.value } : null,
      expandedTerms: expandedTerms.split(" ").filter(Boolean).slice(0, 10),
      totalFound: results.length,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("hybrid-search error:", e);
    if (e instanceof Error && e.message === "Unauthorized") {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error", results: [] }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
