param([switch]$Check, [string]$CodexHome)
$ErrorActionPreference = 'Stop'
if (!$CodexHome) {
    $CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
}
function Start-CatalogSync {
    $settings = Get-Content -LiteralPath (Join-Path $CodexHome 'caveman-client.json') -Encoding UTF8 -Raw | ConvertFrom-Json
    if (!(Test-Path -LiteralPath $settings.node -PathType Leaf)) { throw 'Node 실행 파일을 찾을 수 없습니다. 연결 설정을 다시 실행해 주세요.' }
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $settings.node
    $info.Arguments = '"' + (Join-Path $PSScriptRoot 'manual-sync.mjs') + '" --json'
    $info.EnvironmentVariables['CODEX_HOME'] = $CodexHome
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $info.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    [void]$process.Start()
    return @{ Process=$process; Output=$process.StandardOutput.ReadToEndAsync(); Error=$process.StandardError.ReadToEndAsync(); Started=[DateTime]::UtcNow }
}
function Read-CatalogResult($job) {
    $job.Process.WaitForExit()
    $result = $job.Output.GetAwaiter().GetResult() | ConvertFrom-Json
    if (!$result.message) { throw '동기화 결과를 읽을 수 없습니다.' }
    return $result
}
if ($Check) {
    $job = Start-CatalogSync
    try {
        if (!$job.Process.WaitForExit(45000)) { $job.Process.Kill(); throw '동기화 응답 시간이 초과되었습니다.' }
        $result = Read-CatalogResult $job
        $result | ConvertTo-Json -Compress
        if (!$result.ok) { exit 1 }
    } finally { $job.Process.Dispose() }
    exit 0
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CatalogWindow {
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
}
'@
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Caveman 모델 목록 동기화'
$form.ClientSize = New-Object System.Drawing.Size(540,220)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font('맑은 고딕',10)
$label = New-Object System.Windows.Forms.Label
$label.SetBounds(22,22,490,100)
$label.Text = "서버의 모델 목록을 이 PC로 가져옵니다.`r`n동기화가 끝나면 결과를 표시합니다."
$button = New-Object System.Windows.Forms.Button
$button.SetBounds(22,145,180,40)
$button.Text = '지금 동기화'
$close = New-Object System.Windows.Forms.Button
$close.SetBounds(392,145,125,40)
$close.Text = '닫기'
$close.Add_Click({$form.Close()})
$form.Controls.AddRange(@($label,$button,$close))
$script:job = $null
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 150
$start = {
    if ($script:job) { return }
    try {
        $button.Enabled = $false
        $label.Text = '모델 목록을 확인하고 있습니다…'
        $script:job = Start-CatalogSync
        $timer.Start()
    } catch {
        $label.Text = '연결 설정을 읽거나 실행할 수 없습니다. client.mjs configure 또는 reconfigure를 먼저 실행해 주세요.'
        $button.Enabled = $true
    }
}
$button.Add_Click($start)
$form.Add_Shown($start)
$form.Add_Shown({ [void][CatalogWindow]::ShowWindow($form.Handle,1); $form.Activate() })
$timer.Add_Tick({
    if (!$script:job) { return }
    if (!$script:job.Process.HasExited -and ([DateTime]::UtcNow-$script:job.Started).TotalSeconds -lt 45) { return }
    $timer.Stop()
    try {
        if (!$script:job.Process.HasExited) { $script:job.Process.Kill(); throw 'timeout' }
        $result = Read-CatalogResult $script:job
        $label.Text = $result.message
    } catch { $label.Text = '동기화에 실패했습니다. 기존 목록은 유지됩니다. 서버 연결을 확인하고 다시 시도해 주세요.' }
    finally { $script:job.Process.Dispose(); $script:job=$null; $button.Enabled=$true }
})
$form.Add_FormClosing({param($sender,$eventArgs)
    if ($script:job) { $eventArgs.Cancel=$true; $label.Text='동기화가 끝날 때까지 잠시 기다려 주세요.' }
})
try { [void]$form.ShowDialog() } finally { $timer.Dispose(); $form.Dispose() }
