import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type MirrorResult = {
  ok: boolean;
  reason?: string;
  mirroredFileId?: string;
};

function getBackupClient() {
  const backupUrl = Deno.env.get("BACKUP_SUPABASE_URL");
  const backupServiceKey = Deno.env.get("BACKUP_SUPABASE_SERVICE_ROLE_KEY");

  if (!backupUrl || !backupServiceKey) {
    return null;
  }

  return createClient(backupUrl, backupServiceKey);
}

async function mirrorTags(
  primary: ReturnType<typeof createClient>,
  backup: ReturnType<typeof createClient>,
  fileId: string,
) {
  const { data: tagRows, error: tagFetchError } = await primary
    .from("file_tags")
    .select("confidence, tags(name)")
    .eq("file_id", fileId);

  if (tagFetchError || !tagRows?.length) return;

  for (const row of tagRows) {
    const tagName = (row as any)?.tags?.name;
    if (!tagName) continue;

    const { data: backupTag, error: backupTagError } = await backup
      .from("tags")
      .upsert({ name: tagName }, { onConflict: "name" })
      .select("id")
      .single();

    if (backupTagError || !backupTag?.id) continue;

    await backup
      .from("file_tags")
      .upsert(
        {
          file_id: fileId,
          tag_id: backupTag.id,
          confidence: (row as any)?.confidence ?? 0.5,
        },
        { onConflict: "file_id,tag_id" },
      );
  }
}

async function mirrorFileBlob(
  primary: ReturnType<typeof createClient>,
  backup: ReturnType<typeof createClient>,
  fileUrl: string,
  fileType: string,
) {
  const { data: signed, error: signedError } = await primary
    .storage
    .from("files")
    .createSignedUrl(fileUrl, 60);

  if (signedError || !signed?.signedUrl) return;

  const blobResp = await fetch(signed.signedUrl);
  if (!blobResp.ok) return;

  const fileBlob = await blobResp.blob();
  await backup.storage.from("files").upload(fileUrl, fileBlob, {
    upsert: true,
    contentType: fileType || undefined,
  });
}

export async function mirrorFileToBackup(input: {
  primarySupabaseUrl: string;
  primaryServiceRoleKey: string;
  fileId: string;
}): Promise<MirrorResult> {
  const backup = getBackupClient();
  if (!backup) {
    return {
      ok: false,
      reason: "backup-not-configured",
    };
  }

  const primary = createClient(input.primarySupabaseUrl, input.primaryServiceRoleKey);

  const { data: file, error: fileError } = await primary
    .from("files")
    .select("id,user_id,file_name,file_url,file_type,file_size,file_status,ai_summary,ai_description,extracted_text,expiry_date,entities,semantic_keywords,original_language,translated_text,upload_date")
    .eq("id", input.fileId)
    .maybeSingle();

  if (fileError || !file) {
    return {
      ok: false,
      reason: "primary-file-not-found",
    };
  }

  const { error: upsertError } = await backup
    .from("files")
    .upsert(file as any, { onConflict: "id" });

  if (upsertError) {
    return {
      ok: false,
      reason: `backup-file-upsert-failed:${upsertError.message}`,
    };
  }

  await mirrorTags(primary, backup, input.fileId);
  await mirrorFileBlob(primary, backup, file.file_url, file.file_type || "application/octet-stream");

  return {
    ok: true,
    mirroredFileId: input.fileId,
  };
}
