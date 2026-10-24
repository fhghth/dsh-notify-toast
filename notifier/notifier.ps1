param(
  [switch]$Demo,
  [switch]$CompileOnly,
  [switch]$NotifyHost,
  [string]$DemoFile = ''
)

$ErrorActionPreference = 'Stop'

# Exactly one notifier may run per machine: a freshly started instance retires
# older ones (orphans left by a Host reload). The Host spawns the notifier as
#   powershell.exe ... -File <dir>\notifier.ps1 -NotifyHost
# so a candidate is retired only when its command line ends with that exact
# shape. Matching the bare marker is not enough: any shell whose text merely
# mentions -NotifyHost (a diagnostic, a grep, a doc snippet) would match and be
# force-killed, losing whatever it was doing.
if (-not $CompileOnly -and -not $Demo) {
  try {
    $selfId = $PID
    $targets = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction Stop
    foreach ($proc in $targets) {
      if ($proc.ProcessId -eq $selfId) { continue }
      $cmd = $proc.CommandLine
      if (-not $cmd) { continue }
      if ($cmd -notmatch '-File\s+"?[^"]*notifier\.ps1"?\s+-NotifyHost\s*$') { continue }
      try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop } catch {}
    }
  } catch {}
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$cs = Join-Path $here 'ui.cs'
if (-not (Test-Path $cs)) { throw "ui.cs not found at $cs" }

try {
  Add-Type -Path $cs -ReferencedAssemblies 'System.Windows.Forms', 'System.Drawing'
} catch {
  $refs = @([System.Windows.Forms.Form].Assembly.Location, [System.Drawing.Color].Assembly.Location)
  Add-Type -Path $cs -ReferencedAssemblies $refs
}

if ($CompileOnly) { 'COMPILED OK'; exit 0 }

if ($Demo) {
  if (-not $DemoFile) { $DemoFile = Join-Path $here 'demo.json' }
  if (-not (Test-Path $DemoFile)) { throw "demo file not found at $DemoFile" }
  [DshNotify.Program]::Demo($DemoFile)
  exit 0
}

[DshNotify.Program]::Main()
exit 0
