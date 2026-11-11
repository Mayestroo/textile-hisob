param(
  [Parameter(Mandatory=$true)][string]$Artifact,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedSha256,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{40}$')][string]$ExpectedSignerThumbprint
)
$ErrorActionPreference = 'Stop'
# Read-only; never signs, installs, changes policy or accesses private keys.
$hash = (Get-FileHash -LiteralPath $Artifact -Algorithm SHA256).Hash
$signature = Get-AuthenticodeSignature -LiteralPath $Artifact
$signer = if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { $null }
$timestamped = $null -ne $signature.TimeStamperCertificate
$passed = $hash -eq $ExpectedSha256 -and [string]$signature.Status -eq 'Valid' `
  -and $signer -eq $ExpectedSignerThumbprint -and $timestamped
[pscustomobject]@{
  Status = if ($passed) { 'PASS' } else { 'FAIL' }
  File = [IO.Path]::GetFileName($Artifact)
  Sha256 = $hash
  HashMatches = $hash -eq $ExpectedSha256
  AuthenticodeStatus = [string]$signature.Status
  SignerThumbprint = $signer
  ExpectedSignerMatches = $signer -eq $ExpectedSignerThumbprint
  TimestampPresent = $timestamped
} | ConvertTo-Json -Compress
if (-not $passed) { exit 1 }
