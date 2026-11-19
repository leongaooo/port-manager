param(
    [Parameter(Mandatory = $true)]
    [int]$TargetProcessId,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedCreationTime,

    [switch]$Tree
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Convert-ToIsoTime {
    param($Value)

    if ($Value -is [datetime]) {
        return $Value.ToUniversalTime().ToString('o')
    }
    return ([System.Management.ManagementDateTimeConverter]::ToDateTime([string]$Value)).ToUniversalTime().ToString('o')
}

$process = Get-CimInstance Win32_Process -Filter "ProcessId = $TargetProcessId" -ErrorAction Stop
if ($null -eq $process) {
    throw "Process $TargetProcessId no longer exists."
}

$actualCreationTime = Convert-ToIsoTime $process.CreationDate
if ($actualCreationTime -ne $ExpectedCreationTime) {
    throw "Process $TargetProcessId was replaced before termination."
}

if ($Tree) {
    & taskkill.exe /PID $TargetProcessId /T /F 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "taskkill failed with exit code $LASTEXITCODE."
    }
} else {
    Stop-Process -Id $TargetProcessId -Force -ErrorAction Stop
}

[ordered]@{
    ok = $true
    pid = $TargetProcessId
    tree = [bool]$Tree
} | ConvertTo-Json -Compress
