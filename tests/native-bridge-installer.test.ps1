# Windows-only lifecycle launcher regression test. Does not register any task.
$ErrorActionPreference = 'Stop'
$installer = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\install-native-bridge.ps1'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($installer, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw ($parseErrors | Out-String) }
foreach ($name in @('New-Launcher', 'New-LaunchCommand', 'Test-OwnedCommand')) {
    $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    if (-not $definition) { throw "Missing installer function: $name" }
    Invoke-Expression $definition.Extent.Text
}
$nodePath = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$cscriptPath = Join-Path $env:SystemRoot 'System32\cscript.exe'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('caveman-bridge-test-' + [Guid]::NewGuid().ToString('N'))
$launcherPath = Join-Path $testRoot 'launcher test.vbs'
$entryPath = Join-Path $testRoot 'entry test.mjs'
$configPath = Join-Path $testRoot 'config test.json'
$resultPath = Join-Path $testRoot 'result.json'
$utf8 = New-Object Text.UTF8Encoding($false)
New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
    [IO.File]::WriteAllText($launcherPath, (New-Launcher ('"' + $nodePath + '" --version')), $utf8)
    & $cscriptPath //nologo $launcherPath
    if ($LASTEXITCODE -ne 0) { throw 'Hidden node --version launcher failed.' }

    [IO.File]::WriteAllText($configPath, ($resultPath | ConvertTo-Json), $utf8)
    [IO.File]::WriteAllText($entryPath, @'
import fs from 'node:fs';
import assert from 'node:assert/strict';
assert.equal(process.argv[2], '--config');
assert.equal(process.argv.length, 4);
fs.writeFileSync(JSON.parse(fs.readFileSync(process.argv[3], 'utf8')), JSON.stringify({ok: true}));
process.exit(17);
'@, $utf8)
    $command = New-LaunchCommand $nodePath $entryPath $configPath
    $extraSeparator = '"' + $nodePath + '"  "' + $entryPath + '" --config "' + $configPath + '"'
    if (-not (Test-OwnedCommand $extraSeparator $command)) { throw 'Ownership comparison rejected WScript argument spacing.' }
    if (Test-OwnedCommand ($command + ' --extra') $command) { throw 'Ownership comparison accepted extra arguments.' }
    if (Test-OwnedCommand $command.Replace('entry test.mjs', 'entry  test.mjs') $command) { throw 'Ownership comparison changed spaces inside a path.' }
    if (Test-OwnedCommand $command.Replace('entry test.mjs', 'entry testXmjs') $command) { throw 'Ownership comparison treated a path character as a regex wildcard.' }
    if (Test-OwnedCommand $command.Replace('"' + $entryPath + '"', $entryPath) $command) { throw 'Ownership comparison accepted an unquoted entry path.' }
    if (Test-OwnedCommand $command.Replace('--config', '--other') $command) { throw 'Ownership comparison accepted a different argument.' }
    [IO.File]::WriteAllText($launcherPath, (New-Launcher $command), $utf8)
    & $cscriptPath //nologo $launcherPath
    if ($LASTEXITCODE -ne 17) { throw 'The launcher failed to preserve its child exit status.' }
    $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    if (-not $result.ok) { throw 'The launcher failed to preserve paths and arguments.' }
    Write-Output 'Installer parse, hidden Node launch, spaced paths, arguments, and exit status passed.'
} finally {
    foreach ($path in @($launcherPath, $entryPath, $configPath, $resultPath)) {
        if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path }
    }
    if (Test-Path -LiteralPath $testRoot -PathType Container) { Remove-Item -LiteralPath $testRoot }
}
