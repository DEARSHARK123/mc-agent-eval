$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
while ($null -ne ($path = [Console]::ReadLine())) {
  $player = $null
  $status = 'done '
  try {
    $player = New-Object System.Media.SoundPlayer($path)
    $player.PlaySync()
  } catch {
    $status = 'failed '
  } finally {
    if ($null -ne $player) { $player.Dispose() }
    [Console]::Out.WriteLine($status + $path)
    [Console]::Out.Flush()
  }
}
