$ErrorActionPreference='Stop'
$ref='qsulolldyzdlklhsasza'
$txt=(supabase projects api-keys --project-ref $ref | Out-String)
$lines=$txt -split "`n"
$pubLine = $lines | Where-Object { $_ -match 'sb_publishable_' } | Select-Object -First 1
$serviceLine = $lines | Where-Object { $_ -match '^\s*service_role\s*\|' } | Select-Object -First 1
if(-not $pubLine -or -not $serviceLine){ throw 'Could not parse publishable/service role keys' }
$pubKey=(($pubLine -split '\|')[1]).Trim()
$serviceKey=(($serviceLine -split '\|')[1]).Trim()
$baseUrl="https://$ref.supabase.co"

$stamp=Get-Date -Format 'yyyyMMddHHmmss'
$email="ai.pubtest.$stamp@example.com"
$pwd="Test@12345678"
$filename="ai_pubtest_$stamp.txt"
$content="publishable key auth test - 28/03/2026"

$adminHeaders=@{apikey=$serviceKey;Authorization="Bearer $serviceKey";"Content-Type"="application/json"}
$pubHeaders=@{apikey=$pubKey;"Content-Type"="application/json"}

$userPayload=@{email=$email;password=$pwd;email_confirm=$true}|ConvertTo-Json
$userResp=Invoke-RestMethod -Method Post -Uri "$baseUrl/auth/v1/admin/users" -Headers $adminHeaders -Body $userPayload
$userId=$userResp.id

$loginPayload=@{email=$email;password=$pwd}|ConvertTo-Json
$loginResp=Invoke-RestMethod -Method Post -Uri "$baseUrl/auth/v1/token?grant_type=password" -Headers $pubHeaders -Body $loginPayload
$token=$loginResp.access_token
if(-not $token){ throw 'No access token returned' }

$uploadPath="$userId/$filename"
$upHeaders=@{apikey=$serviceKey;Authorization="Bearer $serviceKey";"Content-Type"="text/plain";"x-upsert"="true"}
$bytes=[System.Text.Encoding]::UTF8.GetBytes($content)
$null=Invoke-RestMethod -Method Post -Uri "$baseUrl/storage/v1/object/files/$uploadPath" -Headers $upHeaders -Body $bytes

$dbHeaders=@{apikey=$serviceKey;Authorization="Bearer $serviceKey";"Content-Type"="application/json";Prefer="return=representation"}
$insert=@(@{user_id=$userId;file_name=$filename;file_url=$uploadPath;file_type='text/plain';file_size=$bytes.Length;file_status='uploading'})|ConvertTo-Json
$row=Invoke-RestMethod -Method Post -Uri "$baseUrl/rest/v1/files" -Headers $dbHeaders -Body $insert
$fileId=$row[0].id

$fnHeaders=@{apikey=$pubKey;Authorization="Bearer $token";"Content-Type"="application/json"}
$body=@{fileId=$fileId;fileName=$filename;fileType='text/plain'}|ConvertTo-Json
$resp=Invoke-WebRequest -Method Post -Uri "$baseUrl/functions/v1/analyze-file" -Headers $fnHeaders -Body $body

"TEST_USER_EMAIL=$email"
"FUNCTION_STATUS=$($resp.StatusCode)"
