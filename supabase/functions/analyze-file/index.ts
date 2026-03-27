import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const MAX_IMAGE_BASE64_SIZE = 8 * 1024 * 1024; // 8MB
const MAX_PDF_BASE64_SIZE = 10 * 1024 * 1024; // 10MB

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("No authorization header");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!lovableApiKey) throw new Error("LOVABLE_API_KEY not configured");

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const anonClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await anonClient.auth.getUser(token);
    if (userError || !user) throw new Error("Unauthorized");

    const { fileId, fileName, fileType } = await req.json();
    if (!fileId || !fileName) throw new Error("Missing fileId or fileName");

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

    const model = useVisionModel ? "google/gemini-2.5-flash" : "google/gemini-3-flash-preview";

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lovableApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          ...userMessages,
        ],
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
                        name: { type: "string", description: "Tag name" },
                        confidence: { type: "number", minimum: 0, maximum: 1 },
                      },
                      required: ["name", "confidence"],
                      additionalProperties: false,
                    },
                  },
                  summary: { type: "string", description: "5-8 sentence comprehensive summary with synonyms" },
                  ai_description: { type: "string", description: "Natural language search query to find this document" },
                  expiry_date: { type: "string", nullable: true, description: "ISO date of expiry/renewal/due date, or null" },
                  extracted_text: { type: "string", description: "ALL readable text verbatim. For photos: detailed visual description." },
                  semantic_keywords: { type: "string", description: "40-60 semantic keywords comma-separated. Include English + Hindi + regional synonyms." },
                  entities: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        type: { type: "string", enum: ["person", "company", "date", "amount", "id_number", "phone", "email", "address", "pan", "gst", "aadhaar", "passport", "policy_number", "invoice_number", "account_number", "dob", "issue_date", "expiry_date_entity", "location", "event"] },
                        value: { type: "string" },
                        label: { type: "string" },
                      },
                      required: ["type", "value", "label"],
                      additionalProperties: false,
                    },
                  },
                  original_language: { type: "string", description: "ISO 639-1 language code of the document (e.g., 'en', 'hi', 'ta', 'mr')" },
                  translated_text: { type: "string", nullable: true, description: "English translation of all text if document is non-English, null if already English" },
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
    const toolCall = aiResult.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) {
      await supabase.from("files").update({ file_status: "error" }).eq("id", fileId);
      throw new Error("No tool call in AI response");
    }

    let metadata: any;
    try {
      metadata = JSON.parse(toolCall.function.arguments);
    } catch (parseErr) {
      console.warn("JSON parse failed, attempting recovery:", parseErr);
      let raw = toolCall.function.arguments || "";
      // Try to repair truncated JSON by closing open braces/brackets
      const openBraces = (raw.match(/{/g) || []).length;
      const closeBraces = (raw.match(/}/g) || []).length;
      const openBrackets = (raw.match(/\[/g) || []).length;
      const closeBrackets = (raw.match(/\]/g) || []).length;
      // Remove trailing incomplete key/value
      raw = raw.replace(/,\s*"[^"]*"?\s*:?\s*"?[^"{}[\]]*$/, "");
      raw = raw.replace(/,\s*{[^}]*$/, "");
      for (let i = 0; i < openBrackets - closeBrackets; i++) raw += "]";
      for (let i = 0; i < openBraces - closeBraces; i++) raw += "}";
      try {
        metadata = JSON.parse(raw);
        console.warn("Recovered truncated JSON successfully");
      } catch (recoveryErr) {
        console.error("Cannot recover JSON:", recoveryErr);
        // Fallback: save what we can
        metadata = {
          tags: [{ name: "document", confidence: 0.5 }],
          summary: "AI analysis was truncated. File saved successfully.",
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
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
