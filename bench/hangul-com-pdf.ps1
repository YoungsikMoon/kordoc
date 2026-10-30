param(
  [Parameter(Mandatory=$true)][string]$Src,
  [Parameter(Mandatory=$true)][string]$Out,
  [string]$Format = 'PDF'   # HWPX 면 한컴이 다시 조판해 저장(줄 정보 지운 사본 → 한컴 lineseg)
)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

$tmpDir = Join-Path $env:TEMP ('hwp-com-' + [guid]::NewGuid().ToString('N'))

try {
  [void](New-Item -ItemType Directory -Path $tmpDir -Force)   # 복사가 실패해도 finally 가 지우도록 try 안에서(com-fallback.ts 참고)
  $tmpFile = Join-Path $tmpDir (Split-Path $Src -Leaf)
  Copy-Item -LiteralPath $Src -Destination $tmpFile -Force
  $tmpOut = Join-Path $tmpDir ('out.' + $Format.ToLower())
  $hwp = New-Object -ComObject HWPFrame.HwpObject
  $hwp.RegisterModule('FilePathCheckDLL', 'FilePathCheckerModuleExample') | Out-Null   # 종류 이름은 'FilePathCheckDLL'(com-fallback.ts 참고)
  if ($Format -ne 'PDF') { $hwp.SetMessageBoxMode(0x2FFF1) | Out-Null }   # 저장 확인 대화상자 자동 응답(없으면 HWPX 저장에서 멈춘다)
  $hwp.Open($tmpFile, '', '') | Out-Null
  $pc = $hwp.PageCount
  $hwp.SaveAs($tmpOut, $Format, '') | Out-Null
  $hwp.Clear(1) | Out-Null
  try { $hwp.Quit() | Out-Null } catch { }
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($hwp) | Out-Null
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  Copy-Item -LiteralPath $tmpOut -Destination $Out -Force
  Write-Output ("OK pages=" + $pc)
} catch {
  Write-Output ("ERR " + $_.Exception.Message)
} finally {
  try { Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue } catch { }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
