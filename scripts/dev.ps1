# Starts the demo: this service, plus a sibling cm_mcp_engine if one is there.
#
# This repo owns the UI, so it owns the "watch the demo" experience. It does not
# own the engine -- it delegates to that repo's own dev.ps1 and only knows where
# the checkout is, via CM_ENGINE_DIR. With no sibling present it starts the BFF
# and UI alone and points them at CM_MCP_URL, which is the deployed shape.
#
#   pwsh scripts/dev.ps1              # BFF + UI, and the engine if found
#   pwsh scripts/dev.ps1 -AgentOnly   # never touch the sibling
#   pwsh scripts/dev.ps1 -Stop        # stop everything this script started

param(
    [switch]$Stop,
    [switch]$AgentOnly
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $repo '.cache/dev-pids.json'
$ports = @(8000, 5173)

function Resolve-EngineDir {
    $configured = $env:CM_ENGINE_DIR
    if (-not $configured) { $configured = Join-Path (Split-Path -Parent $repo) 'cm_mcp_engine' }
    if (Test-Path (Join-Path $configured 'scripts/dev.ps1')) { return (Resolve-Path $configured).Path }
    return $null
}

function Stop-Stack {
    $engine = Resolve-EngineDir
    if ($engine) {
        Write-Host 'stopping sibling engine ...' -ForegroundColor DarkGray
        & pwsh -NoProfile -File (Join-Path $engine 'scripts/dev.ps1') -Stop | Out-Null
    }
    if (Test-Path $pidFile) {
        foreach ($entry in (Get-Content $pidFile -Raw | ConvertFrom-Json)) {
            $null = & taskkill.exe /PID $entry.ProcessId /T /F 2>&1
            Write-Host "stopped $($entry.Name) (pid $($entry.ProcessId))" -ForegroundColor DarkGray
        }
        Remove-Item $pidFile -Force
    }
    $stray = Get-NetTCPConnection -LocalPort $ports -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($processId in $stray) {
        $null = & taskkill.exe /PID $processId /T /F 2>&1
        Write-Host "stopped stray listener (pid $processId)" -ForegroundColor DarkGray
    }
    Write-Host 'Stack stopped.' -ForegroundColor Green
}

if ($Stop) { Stop-Stack; return }

Push-Location $repo
try {
    if (-not (Test-Path '.env')) { Copy-Item '.env.example' '.env' }
    New-Item -ItemType Directory -Force (Join-Path $repo '.cache') | Out-Null

    $occupied = Get-NetTCPConnection -LocalPort $ports -State Listen -ErrorAction SilentlyContinue
    if ($occupied) {
        $occupied | Select-Object LocalPort, OwningProcess -Unique | ForEach-Object {
            Write-Host "  port $($_.LocalPort) held by pid $($_.OwningProcess)" -ForegroundColor Red
        }
        throw 'Ports in use. Run "pwsh scripts/dev.ps1 -Stop" first.'
    }

    # --- the engine, if we can find it -------------------------------------
    $engine = if ($AgentOnly) { $null } else { Resolve-EngineDir }
    if ($engine) {
        Write-Host "found engine at $engine" -ForegroundColor DarkGray
        & pwsh -NoProfile -File (Join-Path $engine 'scripts/dev.ps1')
        if ($LASTEXITCODE -ne 0) { throw 'The sibling engine failed to start.' }
    } else {
        $target = if ($env:CM_MCP_URL) { $env:CM_MCP_URL } else { 'http://127.0.0.1:8765/mcp' }
        Write-Host "no sibling engine; expecting one already running at $target" -ForegroundColor Yellow
    }

    $started = @()

    function Start-Probed($name, $file, $arguments, $probe, $workingDir) {
        Write-Host "starting $name ..." -NoNewline
        $process = Start-Process -FilePath $file -ArgumentList $arguments `
            -WorkingDirectory $workingDir -PassThru -WindowStyle Hidden
        $script:started += [pscustomobject]@{ Name = $name; ProcessId = $process.Id }
        $script:started | ConvertTo-Json -AsArray | Set-Content $pidFile -Encoding utf8

        $deadline = (Get-Date).AddSeconds(45)
        while ((Get-Date) -lt $deadline) {
            if ($process.HasExited) {
                Write-Host " FAILED (exited $($process.ExitCode))" -ForegroundColor Red
                throw "$name exited during startup."
            }
            try {
                Invoke-WebRequest -Uri $probe -TimeoutSec 2 -UseBasicParsing | Out-Null
                Write-Host " ok (pid $($process.Id))" -ForegroundColor Green; return
            } catch { Start-Sleep -Milliseconds 400 }
        }
        Write-Host ' TIMEOUT' -ForegroundColor Red
        throw "$name did not become healthy at $probe."
    }

    Start-Probed 'BFF :8000' 'uv' @('run', 'python', '-m', 'cm_agent.bff.app') `
        'http://127.0.0.1:8000/healthz' $repo

    $frontend = Join-Path $repo 'frontend'
    if (-not (Test-Path (Join-Path $frontend 'node_modules'))) {
        Write-Host 'installing frontend dependencies (first run) ...' -ForegroundColor DarkGray
        Push-Location $frontend
        try { & npm install --no-audit --no-fund | Out-Null } finally { Pop-Location }
    }

    # Launch Vite's node entrypoint directly: Start-Process cannot resolve a
    # bare 'npm' on Windows, and driving npm.cmd hidden does not reliably start
    # the dev server. Vite must run from frontend/ or it serves the wrong root.
    Start-Probed 'Vite :5173' (Get-Command node).Source `
        @((Join-Path $frontend 'node_modules/vite/bin/vite.js'), '--port', '5173') `
        'http://127.0.0.1:5173/' $frontend

    Write-Host ''
    Write-Host 'Demo is up.' -ForegroundColor Green
    Write-Host '  UI    http://localhost:5173'
    Write-Host '  BFF   http://127.0.0.1:8000/healthz'
    if ($engine) { Write-Host '  MCP   http://127.0.0.1:8765/mcp  (sibling cm_mcp_engine)' }
    Write-Host ''
    Write-Host 'Stop with: pwsh scripts/dev.ps1 -Stop' -ForegroundColor DarkGray
}
finally { Pop-Location }
