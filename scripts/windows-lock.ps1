param([Parameter(Mandatory=$true)][string]$LockFile)
$ErrorActionPreference = 'Stop'
$deadline = [DateTime]::UtcNow.AddSeconds(10)
$stream = $null
try {
  while ($null -eq $stream) {
    try {
      $stream = [IO.File]::Open($LockFile, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch [IO.IOException] {
      if ([DateTime]::UtcNow -ge $deadline) { exit 1 }
      Start-Sleep -Milliseconds 50
    }
  }
  [Console]::Out.WriteLine('locked')
  [Console]::Out.Flush()
  # The caller owns stdin. EOF releases the OS handle even if the caller crashes.
  [Console]::In.ReadToEnd() | Out-Null
} finally {
  if ($null -ne $stream) { $stream.Dispose() }
}
