$ErrorActionPreference = 'Stop'

$sourceDir = $PSScriptRoot
$pluginDir = Split-Path -Parent $sourceDir
$outputDir = Join-Path $pluginDir 'bin'
$sourceFile = Join-Path $sourceDir 'Program.cs'
$outputFile = Join-Path $outputDir 'DesktopCoverCarousel.exe'

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) {
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}

if (-not (Test-Path $csc)) {
    throw 'Cannot find .NET Framework C# compiler csc.exe'
}

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

& $csc `
    /nologo `
    /codepage:65001 `
    /target:winexe `
    /out:$outputFile `
    /reference:System.dll `
    /reference:System.Drawing.dll `
    /reference:System.Windows.Forms.dll `
    /reference:System.Web.Extensions.dll `
    $sourceFile
