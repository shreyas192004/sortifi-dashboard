import { supabase } from "@/integrations/supabase/client";

export interface AnalyzeFilePayload {
  fileId: string;
  fileName: string;
  fileType?: string;
}

export interface AnalyzeFileResult {
  data: any;
  error: any;
  status?: number;
  simpleMessage?: string;
}

export function getAnalyzeFileSimpleError(err: any): { message: string; status?: number } {
  const status = err?.context?.status ?? err?.status;
  const raw = `${err?.message || ""}`.toLowerCase();

  if (status === 401 || raw.includes("unauthorized") || raw.includes("401")) {
    return {
      status,
      message: "Session expired or token invalid. Please sign in again and retry.",
    };
  }
  if (status === 403 || raw.includes("forbidden") || raw.includes("403")) {
    return {
      status,
      message: "You do not have permission to run AI analysis for this file.",
    };
  }
  if (status === 404 || raw.includes("not found") || raw.includes("404")) {
    return {
      status,
      message: "AI analysis service is not available on this project right now.",
    };
  }
  if ((typeof status === "number" && status >= 500) || raw.includes("non-2xx")) {
    return {
      status,
      message: "AI server error. File uploaded, but tags could not be generated now.",
    };
  }

  return {
    status,
    message: "AI analysis failed. Please retry.",
  };
}

export async function invokeAnalyzeFile(payload: AnalyzeFilePayload): Promise<AnalyzeFileResult> {
  let {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    const { data: refreshed } = await supabase.auth.refreshSession();
    session = refreshed.session;
  }

  if (!session?.access_token) {
    return {
      data: null,
      error: { message: "Unauthorized", status: 401, context: { status: 401 } },
      status: 401,
      simpleMessage: "Session expired or token invalid. Please sign in again and retry.",
    };
  }

  let response = await supabase.functions.invoke("analyze-file", {
    headers: { Authorization: `Bearer ${session.access_token}` },
    body: payload,
  });

  let status = response.error?.context?.status ?? response.error?.status;

  if (response.error && status === 401) {
    const { data: refreshed } = await supabase.auth.refreshSession();
    const retryToken = refreshed.session?.access_token;

    if (retryToken) {
      response = await supabase.functions.invoke("analyze-file", {
        headers: { Authorization: `Bearer ${retryToken}` },
        body: payload,
      });
      status = response.error?.context?.status ?? response.error?.status;
    }
  }

  const simple = response.error ? getAnalyzeFileSimpleError(response.error) : undefined;

  return {
    data: response.data,
    error: response.error,
    status,
    simpleMessage: simple?.message,
  };
}
