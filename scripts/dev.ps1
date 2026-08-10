# Starts the demo: this service, plus a sibling cm_mcp_engine if one is there.
#
# This repo owns the UI, so it owns the "watch the demo" experience. It does not
# own the engine -- it delegates to that repo's own dev.ps1 and only knows where
# the checkout is, via CM_ENGINE_DIR. With no sibling present it starts the BFF
# and UI alone and points them at CM_MCP_URL, which is the deployed shape.
#
# Both checkouts are fast-forwarded to origin/main before anything starts. The
# engine serves the registry pinned in its OWN repository, so a checkout that is
# behind serves yesterday's tool catalog while looking perfectly healthy -- the
# demo comes up green and the tool a human merged an hour ago is simply absent.
# Syncing first makes "what is running" and "what is merged" the same sentence.
#
#   pwsh scripts/dev.ps1              # sync to origin/main, then BFF + UI + engine
#   pwsh scripts/dev.ps1 -NoPull      # run the checkouts exactly as they are
#   pwsh scripts/dev.ps1 -AgentOnly   # never touch the sibling
#   pwsh scripts/dev.ps1 -Stop        # stop everything this script started

param(
    [switch]$Stop,
    [switch]$AgentOnly,
    [switch]$NoPull
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

function Sync-Checkout($name, $dir) {
    # Fast-forward one checkout to origin/main. Every refusal below is a state
    # where the running stack would NOT be origin/main; the whole point is that
    # it never silently is, so each one stops the launch and says which repo and
    # what to do. -NoPull is the deliberate way out.
    if (-not (Test-Path (Join-Path $dir '.git'))) {
        throw "$name at $dir is not a git checkout. Re-run with -NoPull to start it as-is."
    }

    $branch = (& git -C $dir rev-parse --abbrev-ref HEAD 2>$null)
    if ($LASTEXITCODE -ne 0) { throw "$name : could not read the current branch." }
    if ($branch.Trim() -ne 'main') {
        throw "$name is on branch '$($branch.Trim())', not main. Switch to main, or re-run with -NoPull."
    }

    # Untracked build output is ignored by .gitignore, so anything reported here
    # is a real edit that origin/main does not have.
    if (& git -C $dir status --porcelain) {
        throw "$name has uncommitted changes, so it is not what origin/main holds. Commit or stash them, or re-run with -NoPull."
    }

    & git -C $dir fetch --quiet origin main 2>$null
    if ($LASTEXITCODE -ne 0) { throw "$name : could not reach origin to fetch main." }

    $ahead = [int](& git -C $dir rev-list --count 'origin/main..HEAD')
    if ($ahead -gt 0) {
        throw "$name has $ahead local commit(s) not on origin/main. Push them, or re-run with -NoPull."
    }

    $behind = [int](& git -C $dir rev-list --count 'HEAD..origin/main')
    if ($behind -gt 0) {
        & git -C $dir merge --ff-only --quiet origin/main
        if ($LASTEXITCODE -ne 0) { throw "$name : could not fast-forward to origin/main." }
    }

    $head = (& git -C $dir rev-parse --short HEAD).Trim()
    $moved = if ($behind -gt 0) { "pulled $behind commit(s)" } else { 'already current' }
    Write-Host "  $name $head  ($moved)" -ForegroundColor DarkGray
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

    # Before a single process starts: make both checkouts origin/main, or refuse
    # and say why. Sync precedes launch so a stale engine is caught while nothing
    # is listening yet, rather than after a green "Demo is up."
    if ($NoPull) {
        Write-Host 'skipping the origin/main sync (-NoPull)' -ForegroundColor Yellow
    } else {
        Write-Host 'syncing checkouts to origin/main ...' -ForegroundColor DarkGray
        Sync-Checkout 'cm_mcp_agent ' $repo
        if ($engine) { Sync-Checkout 'cm_mcp_engine' $engine }
    }

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
