$ErrorActionPreference='Stop'
$ref='qsulolldyzdlklhsasza'
$keysText = (supabase projects api-keys --project-ref $ref | Out-String)
$lines = $keysText -split "`n"
$anonLine = $lines | Where-Object { $_ -match '^\s*anon\s*\|' } | Select-Object -First 1
$serviceLine = $lines | Where-Object { $_ -match '^\s*service_role\s*\|' } | Select-Object -First 1
if (-not $anonLine -or -not $serviceLine) { throw 'Could not parse anon/service_role keys from supabase CLI output.' }
$anonKey = (($anonLine -split '\|')[1]).Trim()
$serviceKey = (($serviceLine -split '\|')[1]).Trim()
$baseUrl = "https://$ref.supabase.co"

$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$email = "ai.test.$stamp@example.com"
$pwd = "Test@12345678"
$filename = "ai_test_$stamp.txt"
$content = @"
This is a test analysis file for Sortify.
Owner: QA Bot
Invoice Number: INV-2026-001
Amount: INR 12,450
Date: 28/03/2026
Reminder date: 15-04-2026
Keywords: Aadhaar, GST, insurance renewal, contract.
"@

$adminHeaders = @{ apikey = $serviceKey; Authorization = "Bearer $serviceKey"; "Content-Type" = "application/json" }
$authHeadersAnon = @{ apikey = $anonKey; "Content-Type" = "application/json" }

# 1) Create test auth user
$userPayload = @{ email = $email; password = $pwd; email_confirm = $true } | ConvertTo-Json
$userResp = Invoke-RestMethod -Method Post -Uri "$baseUrl/auth/v1/admin/users" -Headers $adminHeaders -Body $userPayload
$userId = $userResp.id
if (-not $userId) { throw 'Failed to create test user.' }

# 2) Sign in as test user to get access token
$loginPayload = @{ email = $email; password = $pwd } | ConvertTo-Json
$loginResp = Invoke-RestMethod -Method Post -Uri "$baseUrl/auth/v1/token?grant_type=password" -Headers $authHeadersAnon -Body $loginPayload
$accessToken = $loginResp.access_token
if (-not $accessToken) { throw 'Failed to get user access token.' }

# 3) Upload text file to storage bucket 'files'
$uploadPath = "$userId/$filename"
$uploadUri = "$baseUrl/storage/v1/object/files/$uploadPath"
$uploadHeaders = @{ apikey = $serviceKey; Authorization = "Bearer $serviceKey"; "Content-Type" = "text/plain"; "x-upsert" = "true" }
$bytes = [System.Text.Encoding]::UTF8.GetBytes($content)
$null = Invoke-RestMethod -Method Post -Uri $uploadUri -Headers $uploadHeaders -Body $bytes

# 4) Insert DB file row
$dbHeaders = @{ apikey = $serviceKey; Authorization = "Bearer $serviceKey"; "Content-Type" = "application/json"; Prefer = "return=representation" }
$fileInsert = @(
  @{
    user_id = $userId
    file_name = $filename
    file_url = $uploadPath
    file_type = 'text/plain'
    file_size = $bytes.Length
    file_status = 'uploading'
  }
) | ConvertTo-Json
$fileResp = Invoke-RestMethod -Method Post -Uri "$baseUrl/rest/v1/files" -Headers $dbHeaders -Body $fileInsert
$fileId = $fileResp[0].id
if (-not $fileId) { throw 'Failed to insert file row.' }

# 5) Invoke edge function with real user token
$fnHeaders = @{ apikey = $anonKey; Authorization = "Bearer $accessToken"; "Content-Type" = "application/json" }
$fnBody = @{ fileId = $fileId; fileName = $filename; fileType = 'text/plain' } | ConvertTo-Json
$fnRaw = $null
try {
  $fnRaw = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$baseUrl/functions/v1/analyze-file" -Headers $fnHeaders -Body $fnBody -ErrorAction Stop
} catch {
  $errResp = $_.Exception.Response
  if ($errResp -and $errResp.GetResponseStream) {
    $reader = New-Object System.IO.StreamReader($errResp.GetResponseStream())
    $body = $reader.ReadToEnd()
    "FUNCTION_ERROR_STATUS=$($errResp.StatusCode.value__)"
    "FUNCTION_ERROR_BODY=$body"
  }
  throw
}

# 6) Fetch analyzed row
Start-Sleep -Seconds 2
$fileRow = Invoke-RestMethod -Method Get -Uri "$baseUrl/rest/v1/files?id=eq.$fileId&select=id,file_name,file_status,ai_summary,extracted_text,semantic_keywords,updated_at" -Headers @{ apikey = $serviceKey; Authorization = "Bearer $serviceKey" }

$summary = [string]$fileRow[0].ai_summary
$summarySample = if ($summary.Length -gt 180) { $summary.Substring(0,180) } else { $summary }
$summarySample = $summarySample -replace "`r|`n", " "

"TEST_USER_EMAIL=$email"
"TEST_FILE_ID=$fileId"
"FUNCTION_HTTP_STATUS=$($fnRaw.StatusCode)"
"FILE_STATUS=$($fileRow[0].file_status)"
"AI_SUMMARY_PRESENT=$([bool]($fileRow[0].ai_summary))"
"EXTRACTED_TEXT_PRESENT=$([bool]($fileRow[0].extracted_text))"
"SEMANTIC_KEYWORDS_PRESENT=$([bool]($fileRow[0].semantic_keywords))"
"AI_SUMMARY_SAMPLE=$summarySample"
