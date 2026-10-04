param()
$ErrorActionPreference = 'Stop'
$launcher = Join-Path (Split-Path -Parent $PSScriptRoot) 'Sync-Catalog.vbs'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'Caveman 모델 목록 동기화.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$hostPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
if ((Test-Path -LiteralPath $shortcutPath) -and ($shortcut.TargetPath -ne $hostPath -or $shortcut.Arguments -ne ('"'+$launcher+'"'))) {
    throw '같은 이름의 다른 바로가기가 있습니다. 기존 바로가기를 확인해 주세요.'
}
$shortcut.TargetPath = $hostPath
$shortcut.Arguments = '"'+$launcher+'"'
$shortcut.WorkingDirectory = Split-Path -Parent $PSScriptRoot
$shortcut.Description = '필요할 때 서버의 모델 목록을 이 PC에 동기화합니다.'
$shortcut.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll')+',238'
$shortcut.Save()
Write-Output $shortcutPath
