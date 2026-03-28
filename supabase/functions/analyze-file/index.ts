import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { consumeAiBudget } from "../_shared/aiBudget.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const MAX_IMAGE_BASE64_SIZE = 8 * 1024 * 1024; // 8MB
const MAX_PDF_BASE64_SIZE = 10 * 1024 * 1024; // 10MB

function normalizeMetadata(metadata: any, fileName: string, fileContent: string) {
  const safe = metadata && typeof metadata === "object" ? { ...metadata } : {};

  const tagsRaw = Array.isArray(safe.tags) ? safe.tags : [];
  const normalizedTags = tagsRaw
    .map((t: any) => {
      if (typeof t === "string") {
        return { name: t.trim(), confidence: 0.6 };
      }
      if (t && typeof t === "object") {
        return {
          name: String(t.name || "").trim(),
          confidence: typeof t.confidence === "number" ? t.confidence : 0.6,
        };
      }
      return null;
    })
    .filter((t: any) => t && t.name.length >= 2)
    .map((t: any) => ({ ...t, confidence: Math.max(0, Math.min(1, t.confidence)) }));

  const dedup = new Map<string, { name: string; confidence: number }>();
  for (const t of normalizedTags) {
    const key = t.name.toLowerCase();
    if (!dedup.has(key)) dedup.set(key, t);
  }

  let finalTags = Array.from(dedup.values()).slice(0, 20);
  if (finalTags.length === 0) {
    const fallbackWords = `${fileName} ${safe.semantic_keywords || ""}`
      .replace(/[^a-zA-Z0-9\s]/g, " ")
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 3)
      .slice(0, 6);
    finalTags = fallbackWords.map((w) => ({ name: w, confidence: 0.5 }));
    if (finalTags.length === 0) {
      finalTags = [{ name: "document", confidence: 0.5 }];
    }
  }

  return {
    tags: finalTags,
    summary: String(safe.summary || fileContent || `Document analysis for ${fileName}`).slice(0, 8000),
    ai_description: String(safe.ai_description || fileName).slice(0, 2000),
    expiry_date: safe.expiry_date || null,
    extracted_text: String(safe.extracted_text || fileContent || "").slice(0, 50000),
    semantic_keywords: String(safe.semantic_keywords || finalTags.map((t) => t.name).join(", ")).slice(0, 8000),
    entities: Array.isArray(safe.entities) ? safe.entities : [],
    original_language: String(safe.original_language || "en"),
    translated_text: safe.translated_text || null,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  let currentFileId: string | null = null;
  let currentFileName: string | null = null;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
    const googleAiKey = Deno.env.get("GOOGLE_AI_KEY") || Deno.env.get("GEMINI_API_KEY");
    if (!lovableApiKey && !googleAiKey) {
      throw new Error("No AI provider key configured (set LOVABLE_API_KEY or GOOGLE_AI_KEY/GEMINI_API_KEY)");
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await anonClient.auth.getUser(token);
    if (userError || !user) throw new Error("Unauthorized");

    const { fileId, fileName, fileType } = await req.json();
    if (!fileId || !fileName) throw new Error("Missing fileId or fileName");
    currentFileId = fileId;
    currentFileName = fileName;

    // Set file status to 'analysing'
    await supabase.from("files").update({ file_status: "analysing" }).eq("id", fileId);

    // Download the file from storage
    const filePath = `${user.id}/${fileName}`;
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("files")
      .download(filePath);

    const isImage = fileType?.startsWith("image/");
    const isPdf = fileType === "application/pdf";
    const isDoc = fileType?.includes("word") || fileType?.includes("document") || fileType?.includes("msword");
    const isSpreadsheet = fileType?.includes("sheet") || fileType?.includes("excel") || fileType?.includes("csv");
    const isTextBased = fileType?.includes("text") || fileType?.includes("json") || fileType?.includes("xml") || fileType?.includes("csv");

    let fileContent = "";
    let fileBase64 = "";
    let useVisionModel = false;
    let fileTooLarge = false;

    if (!downloadError && fileData) {
      const arrayBuffer = await fileData.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      const fileSize = bytes.length;

      if (isImage) {
        useVisionModel = true;
        if (fileSize > MAX_IMAGE_BASE64_SIZE) {
          // Image too large for vision - use text-only mode with filename analysis
          fileTooLarge = true;
          console.log(`Image too large (${(fileSize / 1e6).toFixed(1)}MB), skipping vision`);
          fileContent = `[Large image file: ${fileName}, ${(fileSize / 1e6).toFixed(1)}MB - analyze based on filename]`;
          useVisionModel = false;
        } else {
          let binary = "";
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          fileBase64 = btoa(binary);
        }
      } else if (isPdf) {
        useVisionModel = true;
        if (fileSize > MAX_PDF_BASE64_SIZE) {
          // Large PDF: extract text only, skip vision
          fileTooLarge = true;
          console.log(`PDF too large (${(fileSize / 1e6).toFixed(1)}MB), using text-only mode`);
          useVisionModel = false;
          try {
            const textDecoder = new TextDecoder("utf-8", { fatal: false });
            const rawText = textDecoder.decode(bytes);
            const textMatches = rawText.match(/\(([^)]{2,})\)/g);
            if (textMatches) {
              fileContent = textMatches
                .map(m => m.slice(1, -1))
                .filter(t => /[a-zA-Z0-9\u0900-\u097F]{2,}/.test(t))
                .join(" ")
                .substring(0, 20000);
            }
          } catch { /* ignore */ }
          if (!fileContent) fileContent = `[Large PDF: ${fileName}, ${(fileSize / 1e6).toFixed(1)}MB]`;
        } else {
          let binary = "";
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          fileBase64 = btoa(binary);
          // Also try text extraction as supplementary
          try {
            const textDecoder = new TextDecoder("utf-8", { fatal: false });
            const rawText = textDecoder.decode(bytes);
            const textMatches = rawText.match(/\(([^)]{2,})\)/g);
            if (textMatches) {
              fileContent = textMatches
                .map(m => m.slice(1, -1))
                .filter(t => /[a-zA-Z0-9\u0900-\u097F]{2,}/.test(t))
                .join(" ")
                .substring(0, 5000);
            }
          } catch { /* ignore */ }
        }
      } else if (isTextBased) {
        const textDecoder = new TextDecoder("utf-8", { fatal: false });
        fileContent = textDecoder.decode(bytes).substring(0, 15000);
      } else if (isDoc || isSpreadsheet) {
        useVisionModel = true;
        if (fileSize > MAX_PDF_BASE64_SIZE) {
          fileTooLarge = true;
          useVisionModel = false;
        } else {
          let binary = "";
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          fileBase64 = btoa(binary);
        }
        try {
          const textDecoder = new TextDecoder("utf-8", { fatal: false });
          const rawText = textDecoder.decode(bytes);
          const textMatches = rawText.match(/>([^<]{3,})</g);
          if (textMatches) {
            fileContent = textMatches
              .map(m => m.slice(1, -1))
              .filter(t => /[a-zA-Z0-9\u0900-\u097F]{2,}/.test(t))
              .join(" ")
              .substring(0, 8000);
          }
        } catch { /* ignore */ }
      } else {
        try {
          const textDecoder = new TextDecoder("utf-8", { fatal: false });
          fileContent = textDecoder.decode(bytes).substring(0, 8000);
        } catch {
          fileContent = `[Binary file: ${fileName}]`;
        }
      }
    }

    // Build system prompt with multilingual + enhanced image analysis
    const systemPrompt = `You are an expert document analysis AI for Cluedox. Extract MAXIMUM useful metadata.

CRITICAL RULES:
1. Generate a COMPREHENSIVE summary (5-8 sentences) with ALL key info: numbers, names, dates, amounts.
2. Summary must be searchable - include synonyms and related terms.
3. Extract EVERY entity: person names, companies, dates, amounts, ID numbers (PAN, GST, Aadhaar, SSN, passport), phones, emails, addresses.
4. AI description: natural language search query someone would use to find this.
5. Detect expiry/renewal/due dates.
6. Tags should cover ALL relevant categories generously.
7. **extracted_text is MOST CRITICAL**: Every readable word, line, number from the document/image. For images, thorough OCR of ALL text including headers, body, captions, watermarks, stamps, handwritten text, numbers, dates, any language.
8. Include dates in EVERY format: DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD, "15 March 1999", "March 15, 1999".

**MULTILINGUAL SUPPORT (CRITICAL):**
9. Detect the document's language. Set original_language to the ISO 639-1 code (e.g., "hi" for Hindi, "ta" for Tamil, "en" for English).
10. If the document is NOT in English, provide a full English translation of all text in the translated_text field.
11. Generate semantic_keywords in BOTH the original language AND English, plus multilingual synonyms.

**AI IMAGE/ILLUSTRATION ANALYSIS (CRITICAL FOR ALL IMAGES):**
12. For AI-generated images, illustrations, graphics, or any non-photo image: describe the style (digital art, watercolor, vector, 3D render, cartoon, sketch), subjects, colors, mood, composition, and any visible text. Generate keywords for searchability.
13. For photos with PEOPLE: describe gender, age range, build, hair, clothing (color + type), glasses, beard, expression, pose. Use names from filename if present.
14. For EVERY image: describe scene, background, location type (indoor/outdoor), landscape features, weather/lighting, objects, event context, photo style.
15. Include ALL descriptions in summary, ai_description, extracted_text, AND semantic_keywords with many synonyms.`;

    const userMessages: any[] = [];
    const visionMime = isPdf ? "application/pdf" : fileType;

    if (useVisionModel && fileBase64) {
      const supplementaryText = fileContent ? `\n\nSupplementary extracted text: ${fileContent}` : "";
      userMessages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `Analyze this ${isPdf ? "PDF document" : isDoc ? "document" : isImage ? "image/photo" : "file"} thoroughly.

File Name: ${fileName}
MIME Type: ${fileType}
${supplementaryText}

${isImage ? `**IMAGE ANALYSIS INSTRUCTIONS:**
- If this is an AI-generated image, illustration, or graphic: describe the art style, technique, subjects, color palette, mood, composition, and visible text
- If this is a photo with people: describe each person (gender, age, clothing color+type, hair, glasses, expression, pose)
- Describe the BACKGROUND/SCENE in extreme detail
- Include ALL descriptions in summary, extracted_text, and semantic_keywords
` : ""}
**MULTILINGUAL:** Detect the language. If non-English, provide English translation in translated_text field.

CRITICAL: "extracted_text" must contain EVERY piece of text from this ${isPdf ? "document (all pages)" : "image"}, line by line. Include dates in multiple formats.`,
          },
          {
            type: "image_url",
            image_url: { url: `data:${visionMime};base64,${fileBase64}` },
          },
        ],
      });
    } else {
      userMessages.push({
        role: "user",
        content: `Analyze this file thoroughly:
Name: ${fileName}
MIME Type: ${fileType}
${fileTooLarge ? `Note: File is too large for vision analysis (${fileName}). Analyze based on available text and filename.` : ""}
Content: ${fileContent || "[No text content available - analyze based on filename and type]"}

**MULTILINGUAL:** Detect the language. If non-English, provide English translation in translated_text field.

CRITICAL: "extracted_text" must contain ALL key text verbatim. Include dates in multiple formats.`,
      });
    }

    let metadata: any;
    let rawMetadata = "";

    const withinBudget = await consumeAiBudget(supabase, 0.6, 100);
    if (!withinBudget) {
      await supabase.from("files").update({ file_status: "error" }).eq("id", fileId);
      return new Response(JSON.stringify({ error: "Monthly AI budget limit reached (₹100)" }), {
        status: 402,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (lovableApiKey) {
      const model = useVisionModel ? "google/gemini-2.5-flash" : "google/gemini-3-flash-preview";

      const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${lovableApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: systemPrompt }, ...userMessages],
          tools: [
            {
              type: "function",
              function: {
                name: "extract_metadata",
                description: "Extract comprehensive structured metadata from a document or image",
                parameters: {
                  type: "object",
                  properties: {
                    tags: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          confidence: { type: "number", minimum: 0, maximum: 1 },
                        },
                        required: ["name", "confidence"],
                        additionalProperties: false,
                      },
                    },
                    summary: { type: "string" },
                    ai_description: { type: "string" },
                    expiry_date: { type: "string", nullable: true },
                    extracted_text: { type: "string" },
                    semantic_keywords: { type: "string" },
                    entities: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          type: { type: "string" },
                          value: { type: "string" },
                          label: { type: "string" },
                        },
                        required: ["type", "value", "label"],
                        additionalProperties: false,
                      },
                    },
                    original_language: { type: "string" },
                    translated_text: { type: "string", nullable: true },
                  },
                  required: ["tags", "summary", "ai_description", "expiry_date", "extracted_text", "semantic_keywords", "entities", "original_language", "translated_text"],
                  additionalProperties: false,
                },
              },
            },
          ],
          tool_choice: { type: "function", function: { name: "extract_metadata" } },
        }),
      });

      if (!aiResponse.ok) {
        const errorText = await aiResponse.text();
        console.error("AI gateway error:", aiResponse.status, errorText);
        await supabase.from("files").update({ file_status: "error" }).eq("id", fileId);
        if (aiResponse.status === 429) {
          return new Response(JSON.stringify({ error: "Rate limited" }), {
            status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        if (aiResponse.status === 402) {
          return new Response(JSON.stringify({ error: "AI credits exhausted" }), {
            status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        throw new Error(`AI error: ${aiResponse.status}`);
      }

      const aiResult = await aiResponse.json();
      const toolCall = aiResult?.choices?.[0]?.message?.tool_calls?.[0];
      rawMetadata = toolCall?.function?.arguments || "";
      if (!rawMetadata) {
        await supabase.from("files").update({ file_status: "error" }).eq("id", fileId);
        throw new Error("No metadata returned from AI gateway");
      }
    } else {
      const fastSystemPrompt = `Extract useful metadata quickly and accurately.
    Return ONLY valid JSON with keys: tags, summary, ai_description, expiry_date, extracted_text, semantic_keywords, entities, original_language, translated_text.
    Rules:
    - summary: 3-5 concise sentences with key dates/amounts/names
    - ai_description: one natural-language search sentence
    - tags: 6-15 tags max
    - semantic_keywords: comma-separated keywords and synonyms
    - entities: include people, company, date, amount, id numbers, phone, email when present
    - original_language: ISO code
    - translated_text: English translation if source is non-English else null`;

      const promptText = `${fastSystemPrompt}\n\nUse only the provided content.`;
      const firstUserText = typeof userMessages?.[0]?.content === "string"
        ? userMessages[0].content
        : userMessages?.[0]?.content?.[0]?.text || "";

      const parts: any[] = [{ text: `${promptText}\n\n${firstUserText}` }];
      // Direct Gemini fallback path is more stable with image inline data only.
      if (useVisionModel && fileBase64 && isImage) {
        parts.push({ inline_data: { mime_type: visionMime, data: fileBase64 } });
      }

      const geminiModel = "gemini-2.5-flash-lite";
      const geminiResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${encodeURIComponent(googleAiKey!)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: fastSystemPrompt }] },
          contents: [{ role: "user", parts }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json",
            maxOutputTokens: 2500,
          },
        }),
      });

      if (!geminiResp.ok) {
        const errorText = await geminiResp.text();
        console.error("Gemini API error:", geminiResp.status, errorText);
        if (geminiResp.status === 429) {
          // Graceful fallback when provider is rate-limited.
          rawMetadata = JSON.stringify({
            tags: [{ name: "document", confidence: 0.6 }],
            summary: `Quick analysis fallback applied due to temporary AI rate limit. File: ${fileName}.`,
            ai_description: `Document ${fileName}`,
            expiry_date: null,
            extracted_text: fileContent || "",
            semantic_keywords: (fileName || "document").replace(/[._-]/g, " "),
            entities: [],
            original_language: "en",
            translated_text: null,
          });
        } else {
          await supabase.from("files").update({ file_status: "error" }).eq("id", fileId);
          throw new Error(`Gemini API error: ${geminiResp.status}`);
        }
      } else {
        const geminiJson = await geminiResp.json();
        rawMetadata = geminiJson?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text || "").join("\n") || "";
        if (!rawMetadata) {
          await supabase.from("files").update({ file_status: "error" }).eq("id", fileId);
          throw new Error("No metadata returned from Gemini API");
        }
      }
    }

    try {
      metadata = JSON.parse(rawMetadata);
    } catch (parseErr) {
      console.warn("JSON parse failed, attempting recovery:", parseErr);
      let raw = rawMetadata
        .replace(/^```json\s*/i, "")
        .replace(/^```/i, "")
        .replace(/```$/i, "");
      const openBraces = (raw.match(/{/g) || []).length;
      const closeBraces = (raw.match(/}/g) || []).length;
      const openBrackets = (raw.match(/\[/g) || []).length;
      const closeBrackets = (raw.match(/\]/g) || []).length;
      raw = raw.replace(/,\s*"[^"]*"?\s*:?\s*"?[^"{}[\]]*$/, "");
      raw = raw.replace(/,\s*{[^}]*$/, "");
      for (let i = 0; i < openBrackets - closeBrackets; i++) raw += "]";
      for (let i = 0; i < openBraces - closeBraces; i++) raw += "}";

      try {
        metadata = JSON.parse(raw);
        console.warn("Recovered truncated JSON successfully");
      } catch (recoveryErr) {
        console.error("Cannot recover JSON:", recoveryErr);
        metadata = {
          tags: [{ name: "document", confidence: 0.5 }],
          summary: "AI analysis fallback used. File saved successfully.",
          ai_description: fileName,
          expiry_date: null,
          extracted_text: "",
          semantic_keywords: fileName.replace(/[._-]/g, " "),
          entities: [],
          original_language: "en",
          translated_text: null,
        };
      }
    }

    metadata = normalizeMetadata(metadata, fileName, fileContent);

    // Update the file record with AI metadata + multilingual data + status
    const { error: updateError } = await supabase
      .from("files")
      .update({
        ai_summary: metadata.summary,
        ai_description: metadata.ai_description,
        extracted_text: metadata.extracted_text,
        expiry_date: metadata.expiry_date || null,
        entities: metadata.entities || [],
        semantic_keywords: metadata.semantic_keywords || "",
        original_language: metadata.original_language || "en",
        translated_text: metadata.translated_text || null,
        file_status: "ready",
      })
      .eq("id", fileId);

    if (updateError) {
      console.error("Update error:", updateError);
      await supabase.from("files").update({ file_status: "error" }).eq("id", fileId);
      throw new Error("Failed to update file metadata");
    }

    // Insert tags
    for (const tag of metadata.tags) {
      const { data: tagData, error: tagError } = await supabase
        .from("tags")
        .upsert({ name: tag.name }, { onConflict: "name" })
        .select("id")
        .single();

      if (tagError || !tagData) continue;

      await supabase.from("file_tags").upsert(
        { file_id: fileId, tag_id: tagData.id, confidence: tag.confidence },
        { onConflict: "file_id,tag_id" }
      );
    }

    return new Response(JSON.stringify({ success: true, metadata }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("analyze-file error:", e);

    // For any runtime failure after file identification, always return a safe fallback
    // to prevent client-facing 500 errors during upload/reanalyze flows.
    if (currentFileId) {
      try {
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const sb = createClient(supabaseUrl, supabaseServiceKey);
        const fallbackName = currentFileName || "document";

        await sb
          .from("files")
          .update({
            ai_summary: `File saved. AI analysis fallback used for ${fallbackName}.`,
            ai_description: fallbackName,
            file_status: "ready",
          })
          .eq("id", currentFileId);

        return new Response(JSON.stringify({
          success: true,
          fallback: true,
          message: "AI fallback saved",
          error: e instanceof Error ? e.message : String(e),
          metadata: {
            tags: [{ name: "document", confidence: 0.5 }],
            summary: `File saved. AI analysis fallback used for ${fallbackName}.`,
            ai_description: fallbackName,
            extracted_text: "",
            semantic_keywords: fallbackName.replace(/[._-]/g, " "),
            entities: [],
          },
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (fallbackErr) {
        console.error("fallback write failed:", fallbackErr);

        // Even if DB update fails, avoid hard failing the HTTP request.
        return new Response(JSON.stringify({
          success: true,
          fallback: true,
          message: "AI fallback returned (DB update failed)",
          error: e instanceof Error ? e.message : String(e),
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Prevent stuck "analysing" state when any unexpected error occurs.
    if (currentFileId) {
      try {
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const sb = createClient(supabaseUrl, supabaseServiceKey);
        await sb.from("files").update({ file_status: "error" }).eq("id", currentFileId);
      } catch (statusErr) {
        console.error("failed to set file_status=error:", statusErr);
      }
    }

    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
