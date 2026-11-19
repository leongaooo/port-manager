$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Convert-ToIsoTime {
    param($Value)

    if ($null -eq $Value) { return $null }
    try {
        if ($Value -is [datetime]) {
            return $Value.ToUniversalTime().ToString('o')
        }
        return ([System.Management.ManagementDateTimeConverter]::ToDateTime([string]$Value)).ToUniversalTime().ToString('o')
    } catch {
        return $null
    }
}

$endpoints = New-Object System.Collections.Generic.List[object]

try {
    Get-NetTCPConnection -State Listen -ErrorAction Stop | ForEach-Object {
        $endpoints.Add([pscustomobject]@{
            protocol = 'TCP'
            localAddress = [string]$_.LocalAddress
            localPort = [int]$_.LocalPort
            pid = [int]$_.OwningProcess
        })
    }
} catch {
    # Continue with process data if the TCP provider is temporarily unavailable.
}

try {
    Get-NetUDPEndpoint -ErrorAction Stop | ForEach-Object {
        $endpoints.Add([pscustomobject]@{
            protocol = 'UDP'
            localAddress = [string]$_.LocalAddress
            localPort = [int]$_.LocalPort
            pid = [int]$_.OwningProcess
        })
    }
} catch {
    # UDP endpoints are optional; TCP listeners remain useful on their own.
}

$allProcesses = @(Get-CimInstance Win32_Process -ErrorAction Stop)
$processById = @{}
foreach ($process in $allProcesses) {
    $processById[[int]$process.ProcessId] = $process
}

$endpointsByPid = @{}
foreach ($endpoint in $endpoints) {
    $key = [int]$endpoint.pid
    if (-not $endpointsByPid.ContainsKey($key)) {
        $endpointsByPid[$key] = New-Object System.Collections.Generic.List[object]
    }
    $endpointsByPid[$key].Add($endpoint)
}

$visiblePids = New-Object 'System.Collections.Generic.HashSet[int]'
foreach ($pidValue in $endpointsByPid.Keys) {
    [void]$visiblePids.Add([int]$pidValue)
}
foreach ($process in $allProcesses) {
    if ([string]$process.Name -ieq 'node.exe') {
        [void]$visiblePids.Add([int]$process.ProcessId)
    }
}

$records = foreach ($pidValue in $visiblePids) {
    $process = $processById[[int]$pidValue]
    $processEndpoints = @()
    if ($endpointsByPid.ContainsKey([int]$pidValue)) {
        $processEndpoints = @($endpointsByPid[[int]$pidValue] | Sort-Object protocol, localPort, localAddress -Unique | ForEach-Object {
            [ordered]@{
                protocol = $_.protocol
                localAddress = $_.localAddress
                localPort = $_.localPort
            }
        })
    }

    if ($null -eq $process) {
        [ordered]@{
            pid = [int]$pidValue
            parentPid = $null
            name = '未知进程'
            executablePath = $null
            commandLine = $null
            startedAt = $null
            parentName = $null
            parentCommandLine = $null
            isNode = $false
            endpoints = $processEndpoints
        }
        continue
    }

    $parent = $processById[[int]$process.ParentProcessId]
    [ordered]@{
        pid = [int]$process.ProcessId
        parentPid = [int]$process.ParentProcessId
        name = [string]$process.Name
        executablePath = if ($process.ExecutablePath) { [string]$process.ExecutablePath } else { $null }
        commandLine = if ($process.CommandLine) { [string]$process.CommandLine } else { $null }
        startedAt = Convert-ToIsoTime $process.CreationDate
        parentName = if ($parent) { [string]$parent.Name } else { $null }
        parentCommandLine = if ($parent -and $parent.CommandLine) { [string]$parent.CommandLine } else { $null }
        isNode = ([string]$process.Name -ieq 'node.exe')
        endpoints = $processEndpoints
    }
}

[ordered]@{
    generatedAt = [datetime]::UtcNow.ToString('o')
    processes = @($records | Sort-Object @{ Expression = { $_.endpoints.Count -eq 0 } }, @{ Expression = { if ($_.endpoints.Count -gt 0) { $_.endpoints[0].localPort } else { 2147483647 } } }, name, pid)
} | ConvertTo-Json -Depth 7 -Compress
