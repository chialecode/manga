param([Parameter(Mandatory = $true)][string]$EvidencePath)

$child = Start-Process -FilePath powershell.exe -ArgumentList '-NoLogo', '-NoProfile', '-Command', 'Start-Sleep -Seconds 60' -PassThru -WindowStyle Hidden
$helper = Start-Process -FilePath powershell.exe -ArgumentList '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Resolve-Path 'apps/desktop/src/main/supervisor/job-object.ps1'), '-ParentPid', $PID, '-ChildPid', $child.Id -PassThru -WindowStyle Hidden
[IO.File]::WriteAllText($EvidencePath, "$($child.Id),$($helper.Id)")
while ($true) { Start-Sleep -Seconds 1 }
