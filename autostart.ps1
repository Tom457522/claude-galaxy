# Windows にログオンしたら、Claude Galaxy を画面なしで自動起動するタスクを登録する(-Remove で解除)
#   powershell -ExecutionPolicy Bypass -File autostart.ps1
#   powershell -ExecutionPolicy Bypass -File autostart.ps1 -Remove
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$name = 'Claude Galaxy'

if ($Remove) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
  Write-Host "タスク「$name」を解除しました。動いている本体は止めていません(止めるにはタスク マネージャーで node.exe を終了)。"
  exit 0
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js が見つかりません。' }
$vbs = Join-Path $PSScriptRoot 'background.vbs'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Claude Galaxy を画面なしで起動し、オートメーションを動かします' -Force | Out-Null
Write-Host "タスク「$name」を登録しました。次のログオンから自動で起動します。"
Write-Host "今すぐ起動するには: Start-ScheduledTask -TaskName '$name'(すでに動いていれば何もしません)"
