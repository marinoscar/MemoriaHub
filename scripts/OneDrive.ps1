#requires -Version 5.1
<#
.SYNOPSIS
    Downloads a OneDrive folder to an external USB drive without making the
    entire OneDrive folder permanently available on the computer.

.DESCRIPTION
    - Detects OneDrive roots for the current Windows user.
    - Detects likely external/USB drives and proposes sensible defaults.
    - Reads OneDrive Files On-Demand placeholders one file at a time.
    - Uses resumable ".onedrive-partial" files.
    - Verifies each completed file by size or SHA-256.
    - Optionally returns each source file to online-only after a successful copy.
    - Preserves folder structure, timestamps, hidden/read-only attributes,
      and empty directories.
    - Produces a run log, CSV manifest, and error log on the destination drive.
    - Keeps Windows awake while the download is running.

.NOTES
    Run this as the same Windows user that is signed into OneDrive.
    Administrator rights are not required and are usually not desirable.

    This approach minimizes internal-drive use, but OneDrive may temporarily
    cache the file currently being copied. Your internal drive should have
    enough free space for the largest single source file plus some headroom.
#>

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$ScriptVersion = '1.1.0'
$script:RunLogPath = $null
$script:ManifestPath = $null
$script:ErrorLogPath = $null
$script:TranscriptStarted = $false

# ----------------------------- UI helpers -----------------------------

function Write-Title {
    param([string]$Text)
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Cyan
    Write-Host ('  ' + $Text) -ForegroundColor Cyan
    Write-Host ('=' * 78) -ForegroundColor Cyan
}

function Write-Info {
    param([string]$Text)
    Write-Host "[INFO] $Text" -ForegroundColor Gray
    if ($script:RunLogPath) {
        Add-Content -LiteralPath $script:RunLogPath -Value "$(Get-Date -Format o) [INFO] $Text" -Encoding UTF8
    }
}

function Write-Ok {
    param([string]$Text)
    Write-Host "[ OK ] $Text" -ForegroundColor Green
    if ($script:RunLogPath) {
        Add-Content -LiteralPath $script:RunLogPath -Value "$(Get-Date -Format o) [OK] $Text" -Encoding UTF8
    }
}

function Write-Warn {
    param([string]$Text)
    Write-Host "[WARN] $Text" -ForegroundColor Yellow
    if ($script:RunLogPath) {
        Add-Content -LiteralPath $script:RunLogPath -Value "$(Get-Date -Format o) [WARN] $Text" -Encoding UTF8
    }
}

function Write-Fail {
    param([string]$Text)
    Write-Host "[FAIL] $Text" -ForegroundColor Red
    if ($script:RunLogPath) {
        Add-Content -LiteralPath $script:RunLogPath -Value "$(Get-Date -Format o) [FAIL] $Text" -Encoding UTF8
    }
}

function Format-Bytes {
    param([UInt64]$Bytes)

    $units = @('B', 'KB', 'MB', 'GB', 'TB', 'PB')
    [double]$value = $Bytes
    $index = 0

    while (($value -ge 1024) -and ($index -lt ($units.Count - 1))) {
        $value = $value / 1024
        $index++
    }

    return ('{0:N2} {1}' -f $value, $units[$index])
}


function Get-LogicalDiskFreeSpace {
    param([string]$DeviceID)

    if ([string]::IsNullOrWhiteSpace($DeviceID)) {
        return $null
    }

    try {
        $escapedDeviceID = $DeviceID.Replace("'", "''")
        $disk = Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='$escapedDeviceID'" -ErrorAction Stop

        if ($disk -and $null -ne $disk.FreeSpace) {
            return [UInt64]$disk.FreeSpace
        }
    }
    catch {
        return $null
    }

    return $null
}

function Wait-ForSourceDriveCapacity {
    param(
        [string]$DeviceID,
        [UInt64]$RequiredFreeBytes,
        [int]$MaximumWaitMinutes,
        [string]$RelativePath
    )

    if ([string]::IsNullOrWhiteSpace($DeviceID)) {
        return $true
    }

    $deadline = (Get-Date).AddMinutes($MaximumWaitMinutes)
    $warningShown = $false

    while ($true) {
        $available = Get-LogicalDiskFreeSpace -DeviceID $DeviceID

        if ($null -eq $available) {
            Write-Warn "Could not read free space for $DeviceID. Continuing without the per-file safety check."
            return $true
        }

        if ([UInt64]$available -ge $RequiredFreeBytes) {
            if ($warningShown) {
                Write-Ok "Internal-drive free space recovered to $(Format-Bytes ([UInt64]$available)). Continuing."
            }
            return $true
        }

        if (-not $warningShown) {
            Write-Warn "Pausing before '$RelativePath' to protect the internal drive."
            Write-Warn "Available: $(Format-Bytes ([UInt64]$available)); required safety level: $(Format-Bytes $RequiredFreeBytes)."
            Write-Info 'Waiting for OneDrive to release previously downloaded file data.'
            $warningShown = $true
        }

        if ((Get-Date) -ge $deadline) {
            Write-Fail "Internal-drive free space did not recover within $MaximumWaitMinutes minute(s)."
            return $false
        }

        Write-Progress -Id 3 `
            -Activity 'Waiting for internal-drive free space' `
            -Status "Available $(Format-Bytes ([UInt64]$available)); need $(Format-Bytes $RequiredFreeBytes)" `
            -PercentComplete 0

        Start-Sleep -Seconds 15
    }
}

function Read-TextWithDefault {
    param(
        [string]$Prompt,
        [string]$Default = ''
    )

    if ([string]::IsNullOrWhiteSpace($Default)) {
        $answer = Read-Host $Prompt
    }
    else {
        $answer = Read-Host "$Prompt [$Default]"
    }

    if ([string]::IsNullOrWhiteSpace($answer)) {
        return $Default
    }

    return $answer.Trim()
}

function Read-YesNo {
    param(
        [string]$Prompt,
        [bool]$Default = $true
    )

    $defaultText = if ($Default) { 'Y' } else { 'N' }

    while ($true) {
        $answer = (Read-Host "$Prompt [Y/N, default $defaultText]").Trim()

        if ([string]::IsNullOrWhiteSpace($answer)) {
            return $Default
        }

        switch -Regex ($answer) {
            '^(y|yes)$' { return $true }
            '^(n|no)$'  { return $false }
            default     { Write-Host 'Please enter Y or N.' -ForegroundColor Yellow }
        }
    }
}

function Read-IntegerWithDefault {
    param(
        [string]$Prompt,
        [int]$Default,
        [int]$Minimum,
        [int]$Maximum
    )

    while ($true) {
        $text = Read-TextWithDefault -Prompt $Prompt -Default ([string]$Default)
        [int]$value = 0

        if ([int]::TryParse($text, [ref]$value) -and $value -ge $Minimum -and $value -le $Maximum) {
            return $value
        }

        Write-Host "Enter a whole number from $Minimum through $Maximum." -ForegroundColor Yellow
    }
}

function Read-MenuChoice {
    param(
        [string]$Prompt,
        [object[]]$Options,
        [int]$DefaultIndex = 0
    )

    for ($i = 0; $i -lt $Options.Count; $i++) {
        $marker = if ($i -eq $DefaultIndex) { '*' } else { ' ' }
        Write-Host (" {0} {1,2}. {2}" -f $marker, ($i + 1), $Options[$i])
    }

    while ($true) {
        $answer = Read-Host "$Prompt [default $($DefaultIndex + 1)]"

        if ([string]::IsNullOrWhiteSpace($answer)) {
            return $DefaultIndex
        }

        [int]$number = 0
        if ([int]::TryParse($answer, [ref]$number) -and $number -ge 1 -and $number -le $Options.Count) {
            return ($number - 1)
        }

        Write-Host "Enter a number from 1 through $($Options.Count)." -ForegroundColor Yellow
    }
}

function Escape-CsvField {
    param([AllowNull()][string]$Value)

    if ($null -eq $Value) {
        return '""'
    }

    return '"' + ($Value -replace '"', '""') + '"'
}

function Add-ManifestRow {
    param(
        [string]$Status,
        [string]$RelativePath,
        [UInt64]$Size,
        [string]$Verification,
        [string]$SourceHash,
        [string]$DestinationHash,
        [string]$Message
    )

    if (-not $script:ManifestPath) {
        return
    }

    $row = @(
        (Escape-CsvField (Get-Date -Format o)),
        (Escape-CsvField $Status),
        (Escape-CsvField $RelativePath),
        (Escape-CsvField ([string]$Size)),
        (Escape-CsvField $Verification),
        (Escape-CsvField $SourceHash),
        (Escape-CsvField $DestinationHash),
        (Escape-CsvField $Message)
    ) -join ','

    Add-Content -LiteralPath $script:ManifestPath -Value $row -Encoding UTF8
}

function Add-ErrorRow {
    param(
        [string]$RelativePath,
        [string]$Stage,
        [string]$Message
    )

    if (-not $script:ErrorLogPath) {
        return
    }

    $row = @(
        (Escape-CsvField (Get-Date -Format o)),
        (Escape-CsvField $RelativePath),
        (Escape-CsvField $Stage),
        (Escape-CsvField $Message)
    ) -join ','

    Add-Content -LiteralPath $script:ErrorLogPath -Value $row -Encoding UTF8
}

# -------------------------- Environment helpers --------------------------

function Test-IsAdministrator {
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    }
    catch {
        return $false
    }
}

function Get-NormalizedPath {
    param([string]$Path)

    return [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Test-PathIsInside {
    param(
        [string]$Child,
        [string]$Parent
    )

    $normalizedChild = (Get-NormalizedPath $Child) + '\'
    $normalizedParent = (Get-NormalizedPath $Parent) + '\'
    return $normalizedChild.StartsWith($normalizedParent, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-RelativePathCompat {
    param(
        [string]$BasePath,
        [string]$FullPath
    )

    $base = (Get-NormalizedPath $BasePath) + '\'
    $full = Get-NormalizedPath $FullPath

    if ($full.Equals($base.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) {
        return ''
    }

    if (-not $full.StartsWith($base, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Path '$FullPath' is not inside '$BasePath'."
    }

    return $full.Substring($base.Length)
}

function Get-OneDriveRoots {
    $results = New-Object System.Collections.ArrayList

    function Add-OneDriveRoot {
        param(
            [string]$Path,
            [string]$Label
        )

        if ([string]::IsNullOrWhiteSpace($Path)) {
            return
        }

        try {
            if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
                return
            }

            $normalized = Get-NormalizedPath $Path

            foreach ($existing in $results) {
                if ($existing.Path.Equals($normalized, [System.StringComparison]::OrdinalIgnoreCase)) {
                    return
                }
            }

            [void]$results.Add([PSCustomObject]@{
                Path  = $normalized
                Label = $Label
            })
        }
        catch {
            # Ignore invalid or inaccessible candidates.
        }
    }

    Add-OneDriveRoot -Path $env:OneDrive -Label 'OneDrive environment variable'
    Add-OneDriveRoot -Path $env:OneDriveConsumer -Label 'Personal OneDrive'
    Add-OneDriveRoot -Path $env:OneDriveCommercial -Label 'Work or school OneDrive'

    try {
        $accountKeys = Get-ChildItem -Path 'HKCU:\Software\Microsoft\OneDrive\Accounts' -ErrorAction SilentlyContinue
        foreach ($key in $accountKeys) {
            $properties = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
            if ($properties -and $properties.UserFolder) {
                $displayName = if ($properties.DisplayName) { $properties.DisplayName } else { $key.PSChildName }
                Add-OneDriveRoot -Path $properties.UserFolder -Label "OneDrive account: $displayName"
            }
        }
    }
    catch {
        # Registry discovery is optional.
    }

    try {
        $profileCandidates = Get-ChildItem -LiteralPath $env:USERPROFILE -Directory -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like 'OneDrive*' }

        foreach ($folder in $profileCandidates) {
            Add-OneDriveRoot -Path $folder.FullName -Label 'Detected under the current user profile'
        }
    }
    catch {
        # Profile discovery is optional.
    }

    return @($results)
}

function Get-UsbLogicalDriveLetters {
    $letters = New-Object System.Collections.ArrayList

    try {
        $usbDisks = Get-CimInstance -ClassName Win32_DiskDrive -ErrorAction Stop |
            Where-Object { $_.InterfaceType -eq 'USB' -or $_.PNPDeviceID -like 'USBSTOR*' }

        foreach ($disk in $usbDisks) {
            $partitions = Get-CimAssociatedInstance -InputObject $disk -Association Win32_DiskDriveToDiskPartition -ErrorAction SilentlyContinue
            foreach ($partition in $partitions) {
                $logicalDisks = Get-CimAssociatedInstance -InputObject $partition -Association Win32_LogicalDiskToPartition -ErrorAction SilentlyContinue
                foreach ($logicalDisk in $logicalDisks) {
                    if ($logicalDisk.DeviceID -and -not ($letters -contains $logicalDisk.DeviceID.ToUpperInvariant())) {
                        [void]$letters.Add($logicalDisk.DeviceID.ToUpperInvariant())
                    }
                }
            }
        }
    }
    catch {
        # USB mapping can fail on restricted systems; other drive detection remains available.
    }

    return @($letters)
}

function Get-DestinationDriveCandidates {
    $usbLetters = Get-UsbLogicalDriveLetters
    $systemDrive = $env:SystemDrive.ToUpperInvariant()
    $items = New-Object System.Collections.ArrayList

    try {
        $logicalDisks = Get-CimInstance -ClassName Win32_LogicalDisk -ErrorAction Stop |
            Where-Object {
                ($_.DriveType -eq 2 -or $_.DriveType -eq 3) -and
                $_.DeviceID -and
                $_.DeviceID.ToUpperInvariant() -ne $systemDrive
            }

        foreach ($disk in $logicalDisks) {
            $deviceId = $disk.DeviceID.ToUpperInvariant()
            $isUsb = $usbLetters -contains $deviceId
            $volumeName = if ($disk.VolumeName) { $disk.VolumeName } else { '(no label)' }
            $fileSystem = if ($disk.FileSystem) { $disk.FileSystem } else { 'unknown filesystem' }

            [void]$items.Add([PSCustomObject]@{
                Root       = "$deviceId\"
                DeviceID   = $deviceId
                VolumeName = $volumeName
                FileSystem = $fileSystem
                Size       = [UInt64]$disk.Size
                FreeSpace  = [UInt64]$disk.FreeSpace
                IsUsb      = $isUsb
                Display    = "$deviceId  $volumeName  $fileSystem  Free: $(Format-Bytes ([UInt64]$disk.FreeSpace)) / $(Format-Bytes ([UInt64]$disk.Size))" +
                             $(if ($isUsb) { '  [USB detected]' } else { '' })
            })
        }
    }
    catch {
        $psDrives = Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue |
            Where-Object { $_.Root -and $_.Root.ToUpperInvariant() -ne "$systemDrive\" }

        foreach ($drive in $psDrives) {
            [void]$items.Add([PSCustomObject]@{
                Root       = $drive.Root
                DeviceID   = ($drive.Name + ':')
                VolumeName = '(unknown)'
                FileSystem = 'unknown'
                Size       = [UInt64]($drive.Used + $drive.Free)
                FreeSpace  = [UInt64]$drive.Free
                IsUsb      = $false
                Display    = "$($drive.Name):  Free: $(Format-Bytes ([UInt64]$drive.Free))"
            })
        }
    }

    return @($items)
}

function Ensure-OneDriveRunning {
    $running = Get-Process -Name OneDrive -ErrorAction SilentlyContinue
    if ($running) {
        return $true
    }

    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Microsoft\OneDrive\OneDrive.exe'),
        (Join-Path $env:ProgramFiles 'Microsoft OneDrive\OneDrive.exe'),
        $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Microsoft OneDrive\OneDrive.exe' } else { $null })
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }

    if ($candidates.Count -eq 0) {
        Write-Warn 'OneDrive.exe was not found in the usual locations. Online-only files may not download.'
        return $false
    }

    if (-not (Read-YesNo -Prompt 'OneDrive is not currently running. Start it now?' -Default $true)) {
        return $false
    }

    try {
        Start-Process -FilePath $candidates[0] | Out-Null
        Start-Sleep -Seconds 5
        return [bool](Get-Process -Name OneDrive -ErrorAction SilentlyContinue)
    }
    catch {
        Write-Warn "Could not start OneDrive: $($_.Exception.Message)"
        return $false
    }
}

# ------------------------ OneDrive state helpers ------------------------

$FILE_ATTRIBUTE_PINNED = [Int64]0x00080000
$FILE_ATTRIBUTE_UNPINNED = [Int64]0x00100000
$FILE_ATTRIBUTE_OFFLINE = [Int64]0x00001000
$FILE_ATTRIBUTE_RECALL_ON_OPEN = [Int64]0x00040000
$FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = [Int64]0x00400000

function Get-OneDriveFileState {
    param([string]$Path)

    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        [Int64]$flags = [Int64]$item.Attributes

        return [PSCustomObject]@{
            WasPinned     = (($flags -band $FILE_ATTRIBUTE_PINNED) -ne 0)
            WasUnpinned   = (($flags -band $FILE_ATTRIBUTE_UNPINNED) -ne 0)
            WasOffline    = (($flags -band $FILE_ATTRIBUTE_OFFLINE) -ne 0)
            RecallOnOpen  = (($flags -band $FILE_ATTRIBUTE_RECALL_ON_OPEN) -ne 0)
            RecallOnData  = (($flags -band $FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS) -ne 0)
            RawFlags      = $flags
        }
    }
    catch {
        return [PSCustomObject]@{
            WasPinned     = $false
            WasUnpinned   = $false
            WasOffline    = $false
            RecallOnOpen  = $false
            RecallOnData  = $false
            RawFlags      = 0
        }
    }
}

function Set-OneDriveFileOnlineOnly {
    param([string]$Path)

    try {
        $attribExe = Join-Path $env:SystemRoot 'System32\attrib.exe'
        $output = & $attribExe '+U' '-P' $Path 2>&1
        $exitCode = $LASTEXITCODE

        if ($exitCode -ne 0) {
            $message = ($output | Out-String).Trim()
            if ([string]::IsNullOrWhiteSpace($message)) {
                $message = "attrib.exe exited with code $exitCode."
            }
            throw $message
        }

        return $true
    }
    catch {
        Write-Warn "Copied successfully, but could not return the source file to online-only: $Path. $($_.Exception.Message)"
        return $false
    }
}

# --------------------------- Copy helpers ---------------------------

function Get-Sha256 {
    param([string]$Path)

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToUpperInvariant()
}

function Get-SafeConflictName {
    param(
        [string]$Path,
        [string]$Tag
    )

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $candidate = "$Path.$Tag-$stamp"
    $counter = 1

    while (Test-Path -LiteralPath $candidate) {
        $candidate = "$Path.$Tag-$stamp-$counter"
        $counter++
    }

    return $candidate
}

function Copy-OneFileResumable {
    param(
        [string]$SourcePath,
        [string]$DestinationPath,
        [UInt64]$ExpectedLength,
        [int]$BufferMegabytes,
        [int]$RetryCount,
        [UInt64]$OverallBytesBefore,
        [UInt64]$OverallTotalBytes,
        [int]$FileNumber,
        [int]$TotalFiles
    )

    $partialPath = "$DestinationPath.onedrive-partial"
    $bufferSize = $BufferMegabytes * 1MB
    $attempt = 0
    $lastError = $null

    while ($attempt -lt $RetryCount) {
        $attempt++
        $sourceStream = $null
        $destinationStream = $null

        try {
            $destinationDirectory = Split-Path -Parent $DestinationPath
            if (-not (Test-Path -LiteralPath $destinationDirectory -PathType Container)) {
                New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
            }

            [UInt64]$resumeOffset = 0

            if (Test-Path -LiteralPath $partialPath -PathType Leaf) {
                $partialItem = Get-Item -LiteralPath $partialPath -Force
                if ([UInt64]$partialItem.Length -le $ExpectedLength) {
                    $resumeOffset = [UInt64]$partialItem.Length
                }
                else {
                    $oversizedName = Get-SafeConflictName -Path $partialPath -Tag 'oversized'
                    Move-Item -LiteralPath $partialPath -Destination $oversizedName -Force
                    $resumeOffset = 0
                }
            }

            $sourceStream = [System.IO.FileStream]::new(
                $SourcePath,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::Read,
                [System.IO.FileShare]::ReadWrite,
                $bufferSize,
                [System.IO.FileOptions]::SequentialScan
            )

            if ([UInt64]$sourceStream.Length -ne $ExpectedLength) {
                $ExpectedLength = [UInt64]$sourceStream.Length
                if ($resumeOffset -gt $ExpectedLength) {
                    $resumeOffset = 0
                }
            }

            $destinationStream = [System.IO.FileStream]::new(
                $partialPath,
                [System.IO.FileMode]::OpenOrCreate,
                [System.IO.FileAccess]::Write,
                [System.IO.FileShare]::None,
                $bufferSize,
                [System.IO.FileOptions]::SequentialScan
            )

            if ([UInt64]$destinationStream.Length -ne $resumeOffset) {
                $destinationStream.SetLength([Int64]$resumeOffset)
            }

            [void]$sourceStream.Seek([Int64]$resumeOffset, [System.IO.SeekOrigin]::Begin)
            [void]$destinationStream.Seek([Int64]$resumeOffset, [System.IO.SeekOrigin]::Begin)

            $buffer = New-Object byte[] $bufferSize
            [UInt64]$copiedForFile = $resumeOffset

            while (($read = $sourceStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $destinationStream.Write($buffer, 0, $read)
                $copiedForFile += [UInt64]$read

                $filePercent = if ($ExpectedLength -gt 0) {
                    [Math]::Min(100, [Math]::Round(($copiedForFile / [double]$ExpectedLength) * 100, 1))
                }
                else {
                    100
                }

                $overallCurrent = $OverallBytesBefore + $copiedForFile
                $overallPercent = if ($OverallTotalBytes -gt 0) {
                    [Math]::Min(100, [Math]::Round(($overallCurrent / [double]$OverallTotalBytes) * 100, 1))
                }
                else {
                    100
                }

                Write-Progress -Id 1 `
                    -Activity "OneDrive to USB: file $FileNumber of $TotalFiles" `
                    -Status "$overallPercent% overall - $(Format-Bytes $overallCurrent) of $(Format-Bytes $OverallTotalBytes)" `
                    -PercentComplete $overallPercent

                Write-Progress -Id 2 -ParentId 1 `
                    -Activity ([System.IO.Path]::GetFileName($SourcePath)) `
                    -Status "$filePercent% - $(Format-Bytes $copiedForFile) of $(Format-Bytes $ExpectedLength)" `
                    -PercentComplete $filePercent
            }

            $destinationStream.Flush()
            $destinationStream.Dispose()
            $destinationStream = $null

            $sourceStream.Dispose()
            $sourceStream = $null

            $partialLength = [UInt64](Get-Item -LiteralPath $partialPath -Force).Length
            if ($partialLength -ne $ExpectedLength) {
                throw "Partial file length is $(Format-Bytes $partialLength); expected $(Format-Bytes $ExpectedLength)."
            }

            if (Test-Path -LiteralPath $DestinationPath) {
                Remove-Item -LiteralPath $DestinationPath -Force
            }

            Move-Item -LiteralPath $partialPath -Destination $DestinationPath -Force

            Write-Progress -Id 2 -ParentId 1 -Activity 'File complete' -Completed

            return [PSCustomObject]@{
                Success       = $true
                Attempts      = $attempt
                ExpectedLength = $ExpectedLength
                ErrorMessage  = $null
            }
        }
        catch {
            $lastError = $_.Exception.Message

            if ($destinationStream) {
                try { $destinationStream.Dispose() } catch {}
            }
            if ($sourceStream) {
                try { $sourceStream.Dispose() } catch {}
            }

            Write-Warn "Attempt $attempt of $RetryCount failed for '$SourcePath': $lastError"

            if ($attempt -lt $RetryCount) {
                $delaySeconds = [Math]::Min(60, [Math]::Pow(2, $attempt))
                Write-Info "Retrying in $delaySeconds seconds. Any partial destination file will be resumed."
                Start-Sleep -Seconds ([int]$delaySeconds)
            }
        }
        finally {
            if ($destinationStream) {
                try { $destinationStream.Dispose() } catch {}
            }
            if ($sourceStream) {
                try { $sourceStream.Dispose() } catch {}
            }
        }
    }

    Write-Progress -Id 2 -ParentId 1 -Activity 'File failed' -Completed

    return [PSCustomObject]@{
        Success        = $false
        Attempts       = $attempt
        ExpectedLength = $ExpectedLength
        ErrorMessage   = $lastError
    }
}

function Set-DestinationMetadata {
    param(
        [System.IO.FileInfo]$SourceItem,
        [string]$DestinationPath
    )

    try {
        $destinationItem = Get-Item -LiteralPath $DestinationPath -Force
        $destinationItem.CreationTimeUtc = $SourceItem.CreationTimeUtc
        $destinationItem.LastWriteTimeUtc = $SourceItem.LastWriteTimeUtc
        $destinationItem.LastAccessTimeUtc = $SourceItem.LastAccessTimeUtc

        $preservedAttributes = [System.IO.FileAttributes]::Archive

        if (($SourceItem.Attributes -band [System.IO.FileAttributes]::Hidden) -ne 0) {
            $preservedAttributes = $preservedAttributes -bor [System.IO.FileAttributes]::Hidden
        }

        if (($SourceItem.Attributes -band [System.IO.FileAttributes]::ReadOnly) -ne 0) {
            $preservedAttributes = $preservedAttributes -bor [System.IO.FileAttributes]::ReadOnly
        }

        $destinationItem.Attributes = $preservedAttributes
    }
    catch {
        Write-Warn "File data was copied, but some metadata could not be preserved for '$DestinationPath': $($_.Exception.Message)"
    }
}

# -------------------------- Keep-awake helper --------------------------

try {
    Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class OneDriveUsbPowerState
{
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
'@ -ErrorAction SilentlyContinue
}
catch {
    # Keeping the system awake is helpful but not mandatory.
}

function Enable-KeepAwake {
    try {
        # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
        [void][OneDriveUsbPowerState]::SetThreadExecutionState(0x80000001)
    }
    catch {}
}

function Disable-KeepAwake {
    try {
        # ES_CONTINUOUS
        [void][OneDriveUsbPowerState]::SetThreadExecutionState(0x80000000)
    }
    catch {}
}

# =============================== MAIN ===============================

$runStart = Get-Date
$exitCode = 1

try {
    Clear-Host
    Write-Title "OneDrive to USB Downloader v$ScriptVersion"

    Write-Host "Windows user: $([Environment]::UserName)"
    Write-Host "User profile: $env:USERPROFILE"
    Write-Host "Computer:     $env:COMPUTERNAME"
    Write-Host ''

    if ($env:OS -ne 'Windows_NT') {
        throw 'This script is designed for Windows.'
    }

    if (Test-IsAdministrator) {
        Write-Warn 'This PowerShell window is elevated. OneDrive normally runs as your standard user. If cloud files fail to open, rerun this script from a normal, non-administrator PowerShell window.'
    }

    [void](Ensure-OneDriveRunning)

    # 1. Choose OneDrive root.
    Write-Title '1. Select the OneDrive account'

    $oneDriveRoots = Get-OneDriveRoots
    if ($oneDriveRoots.Count -eq 0) {
        $manualRoot = Read-TextWithDefault -Prompt 'OneDrive was not detected. Enter the full OneDrive folder path' -Default (Join-Path $env:USERPROFILE 'OneDrive')
        if (-not (Test-Path -LiteralPath $manualRoot -PathType Container)) {
            throw "OneDrive folder not found: $manualRoot"
        }

        $oneDriveRoots = @([PSCustomObject]@{
            Path  = Get-NormalizedPath $manualRoot
            Label = 'Manually entered'
        })
    }

    $rootDisplays = @()
    foreach ($root in $oneDriveRoots) {
        $rootDisplays += "$($root.Path)  [$($root.Label)]"
    }

    $rootIndex = Read-MenuChoice -Prompt 'Choose the OneDrive account' -Options $rootDisplays -DefaultIndex 0
    $oneDriveRoot = $oneDriveRoots[$rootIndex].Path
    Write-Ok "Selected OneDrive root: $oneDriveRoot"

    # 2. Choose source folder.
    Write-Title '2. Select the source folder'

    Write-Host 'Top-level folders currently visible in this OneDrive:'
    try {
        $topFolders = @(Get-ChildItem -LiteralPath $oneDriveRoot -Directory -Force -ErrorAction Stop | Sort-Object Name)
        if ($topFolders.Count -gt 0) {
            foreach ($folder in $topFolders | Select-Object -First 30) {
                Write-Host "  - $($folder.Name)"
            }
            if ($topFolders.Count -gt 30) {
                Write-Host "  ...and $($topFolders.Count - 30) more"
            }
        }
        else {
            Write-Host '  (No top-level folders found.)'
        }
    }
    catch {
        Write-Warn "Could not list top-level folders: $($_.Exception.Message)"
    }

    $defaultRelativeSource = ''

    # Look for common Camera Roll locations, including localized Windows folders.
    $commonRelativeSources = @(
        'Pictures\Camera Roll',
        'Images\Camera Roll',
        'Imágenes\Camera Roll',
        'Fotos\Camera Roll',
        'Camera Roll',
        'Pictures',
        'Images',
        'Imágenes',
        'Photos',
        'Fotos'
    )

    foreach ($commonRelativeSource in $commonRelativeSources) {
        if (Test-Path -LiteralPath (Join-Path $oneDriveRoot $commonRelativeSource) -PathType Container) {
            $defaultRelativeSource = $commonRelativeSource
            break
        }
    }

    # If no common path matched, inspect the first two folder levels for a
    # folder named "Camera Roll" without downloading file contents.
    if ([string]::IsNullOrWhiteSpace($defaultRelativeSource)) {
        try {
            foreach ($topFolder in $topFolders) {
                $cameraRollCandidate = Join-Path $topFolder.FullName 'Camera Roll'
                if (Test-Path -LiteralPath $cameraRollCandidate -PathType Container) {
                    $defaultRelativeSource = Get-RelativePathCompat -BasePath $oneDriveRoot -FullPath $cameraRollCandidate
                    break
                }
            }
        }
        catch {
            # Manual entry remains available.
        }
    }

    $relativeSource = Read-TextWithDefault `
        -Prompt 'Enter the folder relative to the OneDrive root; enter . for the entire OneDrive' `
        -Default $defaultRelativeSource

    if ([string]::IsNullOrWhiteSpace($relativeSource) -or $relativeSource -eq '.' -or $relativeSource -eq '\' -or $relativeSource -eq '/') {
        $sourceFolder = $oneDriveRoot
        $relativeSource = ''
    }
    elseif ([System.IO.Path]::IsPathRooted($relativeSource)) {
        $sourceFolder = Get-NormalizedPath $relativeSource
    }
    else {
        $sourceFolder = Get-NormalizedPath (Join-Path $oneDriveRoot $relativeSource)
    }

    if (-not (Test-Path -LiteralPath $sourceFolder -PathType Container)) {
        throw "Source folder not found: $sourceFolder"
    }

    if (-not (Test-PathIsInside -Child $sourceFolder -Parent $oneDriveRoot) -and
        -not $sourceFolder.Equals($oneDriveRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'The source folder must be inside the selected OneDrive root.'
    }

    # Normalize this even when the user entered an absolute source path.
    $relativeSource = Get-RelativePathCompat -BasePath $oneDriveRoot -FullPath $sourceFolder

    Write-Ok "Source folder: $sourceFolder"

    # 3. Choose destination.
    Write-Title '3. Select the USB destination'

    $driveCandidates = Get-DestinationDriveCandidates
    if ($driveCandidates.Count -eq 0) {
        throw 'No destination drives were detected. Connect the USB drive, wait for it to appear in File Explorer, and run the script again.'
    }

    $defaultDriveIndex = 0
    [UInt64]$bestFreeSpace = 0
    $foundUsb = $false

    for ($i = 0; $i -lt $driveCandidates.Count; $i++) {
        $candidate = $driveCandidates[$i]

        if ($candidate.IsUsb) {
            if (-not $foundUsb -or $candidate.FreeSpace -gt $bestFreeSpace) {
                $defaultDriveIndex = $i
                $bestFreeSpace = $candidate.FreeSpace
                $foundUsb = $true
            }
        }
        elseif (-not $foundUsb -and $candidate.FreeSpace -gt $bestFreeSpace) {
            $defaultDriveIndex = $i
            $bestFreeSpace = $candidate.FreeSpace
        }
    }

    $driveDisplays = @($driveCandidates | ForEach-Object { $_.Display })
    $driveIndex = Read-MenuChoice -Prompt 'Choose the destination drive' -Options $driveDisplays -DefaultIndex $defaultDriveIndex
    $destinationDrive = $driveCandidates[$driveIndex]

    $oneDriveRootName = Split-Path -Leaf $oneDriveRoot
    $defaultDestination = Join-Path $destinationDrive.Root (Join-Path 'OneDrive-Download' $oneDriveRootName)

    if (-not [string]::IsNullOrWhiteSpace($relativeSource)) {
        $defaultDestination = Join-Path $defaultDestination $relativeSource
    }

    $destinationFolderInput = Read-TextWithDefault -Prompt 'Destination folder' -Default $defaultDestination
    $destinationFolder = Get-NormalizedPath $destinationFolderInput

    foreach ($root in $oneDriveRoots) {
        if ((Test-PathIsInside -Child $destinationFolder -Parent $root.Path) -or
            $destinationFolder.Equals($root.Path, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'The destination cannot be inside any OneDrive folder, because that could create a sync loop.'
        }
    }

    if ($destinationFolder.Equals($sourceFolder, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'The source and destination folders cannot be the same.'
    }

    Write-Ok "Destination folder: $destinationFolder"

    # 4. Advanced settings.
    Write-Title '4. Download and verification settings'

    $verificationOptions = @(
        'Size verification (recommended default; fastest)',
        'SHA-256 verification (strongest; reads source and destination again)'
    )
    $verificationIndex = Read-MenuChoice -Prompt 'Choose verification mode' -Options $verificationOptions -DefaultIndex 0
    $verificationMode = if ($verificationIndex -eq 1) { 'SHA256' } else { 'Size' }

    $freeSourceAfterCopy = Read-YesNo `
        -Prompt 'After each successful copy, return the OneDrive source file to online-only to free internal-drive space?' `
        -Default $true

    $unpinPreviouslyPinned = $false
    if ($freeSourceAfterCopy) {
        $unpinPreviouslyPinned = Read-YesNo `
            -Prompt 'Also return files that were already marked "Always keep on this device" to online-only?' `
            -Default $false
    }

    $conflictOptions = @(
        'Rename an existing mismatched destination file, then copy the OneDrive version (safest)',
        'Overwrite an existing mismatched destination file',
        'Skip an existing mismatched destination file'
    )
    $conflictIndex = Read-MenuChoice -Prompt 'How should mismatched destination files be handled?' -Options $conflictOptions -DefaultIndex 0
    $conflictMode = @('Rename', 'Overwrite', 'Skip')[$conflictIndex]

    $retryCount = Read-IntegerWithDefault -Prompt 'Maximum copy attempts per file' -Default 5 -Minimum 1 -Maximum 20
    $bufferMegabytes = Read-IntegerWithDefault -Prompt 'Copy buffer size in MB' -Default 8 -Minimum 1 -Maximum 64
    $minimumLocalReserveGB = Read-IntegerWithDefault -Prompt 'Minimum internal-drive free-space reserve in GB' -Default 5 -Minimum 2 -Maximum 100
    $localSpaceWaitMinutes = Read-IntegerWithDefault -Prompt 'Maximum minutes to wait for OneDrive to release local space' -Default 15 -Minimum 1 -Maximum 120
    $dryRun = Read-YesNo -Prompt 'Perform a dry run only, without downloading files?' -Default $false

    # 5. Inventory.
    Write-Title '5. Scan the source folder'

    Write-Info 'Enumerating folders and files. This reads metadata but should not intentionally download file contents.'

    $enumerationErrors = @()
    $sourceDirectories = @(
        Get-ChildItem -LiteralPath $sourceFolder -Directory -Recurse -Force `
            -ErrorAction SilentlyContinue -ErrorVariable +enumerationErrors |
            Sort-Object FullName
    )

    $sourceFiles = @(
        Get-ChildItem -LiteralPath $sourceFolder -File -Recurse -Force `
            -ErrorAction SilentlyContinue -ErrorVariable +enumerationErrors |
            Sort-Object FullName
    )

    if ($enumerationErrors.Count -gt 0) {
        Write-Warn "$($enumerationErrors.Count) item(s) could not be enumerated. They will be listed in the run log after it is created."
    }

    if ($sourceFiles.Count -eq 0 -and $sourceDirectories.Count -eq 0) {
        throw 'No files or subfolders were found in the selected source folder.'
    }

    [UInt64]$totalBytes = 0
    [UInt64]$largestFileBytes = 0
    $largestFilePath = ''

    foreach ($file in $sourceFiles) {
        [UInt64]$length = [UInt64]$file.Length
        $totalBytes += $length

        if ($length -gt $largestFileBytes) {
            $largestFileBytes = $length
            $largestFilePath = $file.FullName
        }
    }

    Write-Host ''
    Write-Host "Folders:       $($sourceDirectories.Count)"
    Write-Host "Files:         $($sourceFiles.Count)"
    Write-Host "Logical size:  $(Format-Bytes $totalBytes)"
    Write-Host "Largest file:  $(Format-Bytes $largestFileBytes)"
    if ($largestFilePath) {
        Write-Host "                $largestFilePath"
    }

    # FAT32 cannot hold files >= 4 GiB.
    if ($destinationDrive.FileSystem -eq 'FAT32' -and $largestFileBytes -ge 4GB) {
        throw "The selected drive is FAT32, but the source contains a file of $(Format-Bytes $largestFileBytes). FAT32 cannot store a file that large. Reformat the USB drive as NTFS or exFAT, or choose a different drive."
    }

    # Estimate only the additional destination space needed. This makes reruns and
    # interrupted transfers practical: completed same-size files require no new
    # space, and a partial file requires only its remaining bytes.
    [UInt64]$additionalBytesRequired = 0

    foreach ($capacityItem in $sourceFiles) {
        $capacityRelativePath = Get-RelativePathCompat -BasePath $sourceFolder -FullPath $capacityItem.FullName
        $capacityDestinationPath = Join-Path $destinationFolder $capacityRelativePath
        $capacityPartialPath = "$capacityDestinationPath.onedrive-partial"
        [UInt64]$capacitySourceLength = [UInt64]$capacityItem.Length
        $requiresFullCopy = $true

        if (Test-Path -LiteralPath $capacityDestinationPath -PathType Leaf) {
            try {
                [UInt64]$capacityDestinationLength = [UInt64](Get-Item -LiteralPath $capacityDestinationPath -Force).Length
                if ($capacityDestinationLength -eq $capacitySourceLength) {
                    # In SHA-256 mode this is an estimate; a later hash mismatch
                    # could still require space for another copy.
                    $requiresFullCopy = $false
                }
                elseif ($conflictMode -eq 'Skip') {
                    $requiresFullCopy = $false
                }
            }
            catch {
                $requiresFullCopy = $true
            }
        }

        if ($requiresFullCopy) {
            [UInt64]$remainingBytes = $capacitySourceLength

            if (Test-Path -LiteralPath $capacityPartialPath -PathType Leaf) {
                try {
                    [UInt64]$partialBytes = [UInt64](Get-Item -LiteralPath $capacityPartialPath -Force).Length
                    if ($partialBytes -le $capacitySourceLength) {
                        $remainingBytes = $capacitySourceLength - $partialBytes
                    }
                }
                catch {
                    $remainingBytes = $capacitySourceLength
                }
            }

            $additionalBytesRequired += $remainingBytes
        }
    }

    Write-Host "Estimated additional USB space required: $(Format-Bytes $additionalBytesRequired)"
    Write-Host "Current USB free space:                 $(Format-Bytes ([UInt64]$destinationDrive.FreeSpace))"

    if ($destinationDrive.FreeSpace -lt $additionalBytesRequired) {
        $shortfall = $additionalBytesRequired - $destinationDrive.FreeSpace
        throw "The destination drive does not have enough free space for the remaining copy. It is short by approximately $(Format-Bytes $shortfall)."
    }

    # Check local free space against the largest single file.
    $sourceDeviceId = $null
    try {
        $sourceQualifier = Split-Path -Qualifier $sourceFolder
        if ($sourceQualifier) {
            $sourceDeviceId = $sourceQualifier.TrimEnd('\').ToUpperInvariant()
            $sourceDisk = Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='$sourceDeviceId'" -ErrorAction Stop

            if ($sourceDisk) {
                [UInt64]$sourceFreeSpace = [UInt64]$sourceDisk.FreeSpace
                [UInt64]$recommendedLocalFree = $largestFileBytes + ([UInt64]$minimumLocalReserveGB * 1GB)

                Write-Host "Internal/source-drive free space: $(Format-Bytes $sourceFreeSpace)"

                if ($sourceFreeSpace -lt $largestFileBytes) {
                    Write-Warn "The source drive has less free space than the largest single file. OneDrive may be unable to hydrate that file through the local sync folder."
                }
                elseif ($sourceFreeSpace -lt $recommendedLocalFree) {
                    Write-Warn "The source drive has limited headroom. The script copies one file at a time, but OneDrive may temporarily cache the active file."
                }
            }
        }
    }
    catch {
        Write-Warn "Could not determine free space on the source drive: $($_.Exception.Message)"
    }

    # 6. Confirmation.
    Write-Title '6. Confirm'

    Write-Host "Source:                     $sourceFolder"
    Write-Host "Destination:                $destinationFolder"
    Write-Host "Files:                      $($sourceFiles.Count)"
    Write-Host "Total logical size:         $(Format-Bytes $totalBytes)"
    Write-Host "Verification:               $verificationMode"
    Write-Host "Free source files after:    $freeSourceAfterCopy"
    Write-Host "Unpin previously pinned:    $unpinPreviouslyPinned"
    Write-Host "Conflict handling:          $conflictMode"
    Write-Host "Retries per file:           $retryCount"
    Write-Host "Buffer:                     $bufferMegabytes MB"
    Write-Host "Local free-space reserve:   $minimumLocalReserveGB GB"
    Write-Host "Local cleanup wait limit:   $localSpaceWaitMinutes minutes"
    Write-Host "Dry run:                    $dryRun"
    Write-Host ''

    if (-not (Read-YesNo -Prompt 'Proceed with these settings?' -Default $true)) {
        Write-Warn 'Canceled by the user.'
        $exitCode = 2
        return
    }

    if (-not (Test-Path -LiteralPath $destinationFolder -PathType Container)) {
        New-Item -ItemType Directory -Path $destinationFolder -Force | Out-Null
    }

    $runId = Get-Date -Format 'yyyyMMdd-HHmmss'
    $logFolder = Join-Path $destinationFolder '_OneDriveDownloadLogs'
    New-Item -ItemType Directory -Path $logFolder -Force | Out-Null

    $script:RunLogPath = Join-Path $logFolder "run-$runId.log"
    $script:ManifestPath = Join-Path $logFolder "manifest-$runId.csv"
    $script:ErrorLogPath = Join-Path $logFolder "errors-$runId.csv"

    "Timestamp,Status,RelativePath,SizeBytes,Verification,SourceHash,DestinationHash,Message" |
        Set-Content -LiteralPath $script:ManifestPath -Encoding UTF8

    "Timestamp,RelativePath,Stage,Message" |
        Set-Content -LiteralPath $script:ErrorLogPath -Encoding UTF8

    @(
        "OneDrive to USB Downloader v$ScriptVersion",
        "Run started: $(Get-Date -Format o)",
        "Windows user: $([Environment]::UserName)",
        "Computer: $env:COMPUTERNAME",
        "Source: $sourceFolder",
        "Destination: $destinationFolder",
        "File count: $($sourceFiles.Count)",
        "Total bytes: $totalBytes",
        "Verification: $verificationMode",
        "Free source after copy: $freeSourceAfterCopy",
        "Unpin previously pinned: $unpinPreviouslyPinned",
        "Conflict mode: $conflictMode",
        "Retry count: $retryCount",
        "Buffer MB: $bufferMegabytes",
        "Minimum local reserve GB: $minimumLocalReserveGB",
        "Local cleanup wait minutes: $localSpaceWaitMinutes",
        "Dry run: $dryRun",
        ''
    ) | Set-Content -LiteralPath $script:RunLogPath -Encoding UTF8

    foreach ($enumError in $enumerationErrors) {
        Add-ErrorRow -RelativePath '' -Stage 'Enumeration' -Message ($enumError.ToString())
    }

    Enable-KeepAwake

    # Create all directories, including empty directories.
    Write-Title '7. Download'

    if (-not $dryRun) {
        foreach ($sourceDirectory in $sourceDirectories) {
            try {
                $relativeDirectory = Get-RelativePathCompat -BasePath $sourceFolder -FullPath $sourceDirectory.FullName
                $destinationDirectory = Join-Path $destinationFolder $relativeDirectory

                if (-not (Test-Path -LiteralPath $destinationDirectory -PathType Container)) {
                    New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
                }

                try {
                    $destinationDirectoryItem = Get-Item -LiteralPath $destinationDirectory -Force
                    $destinationDirectoryItem.CreationTimeUtc = $sourceDirectory.CreationTimeUtc
                    $destinationDirectoryItem.LastWriteTimeUtc = $sourceDirectory.LastWriteTimeUtc
                }
                catch {
                    Write-Warn "Could not preserve directory timestamps for '$destinationDirectory'."
                }
            }
            catch {
                $relativeForError = try {
                    Get-RelativePathCompat -BasePath $sourceFolder -FullPath $sourceDirectory.FullName
                }
                catch {
                    $sourceDirectory.FullName
                }

                Add-ErrorRow -RelativePath $relativeForError -Stage 'CreateDirectory' -Message $_.Exception.Message
                Write-Warn "Could not create destination directory for '$($sourceDirectory.FullName)': $($_.Exception.Message)"
            }
        }
    }

    [UInt64]$completedBytes = 0
    [int]$copiedCount = 0
    [int]$skippedCount = 0
    [int]$failedCount = 0
    [int]$renamedConflictCount = 0
    [int]$onlineOnlySuccessCount = 0
    [int]$onlineOnlyFailureCount = 0

    for ($index = 0; $index -lt $sourceFiles.Count; $index++) {
        $sourceItem = $sourceFiles[$index]
        $fileNumber = $index + 1
        $relativePath = Get-RelativePathCompat -BasePath $sourceFolder -FullPath $sourceItem.FullName
        $destinationPath = Join-Path $destinationFolder $relativePath
        [UInt64]$sourceLength = [UInt64]$sourceItem.Length

        Write-Info "[$fileNumber/$($sourceFiles.Count)] $relativePath"

        if ($dryRun) {
            Add-ManifestRow -Status 'DRY-RUN' -RelativePath $relativePath -Size $sourceLength `
                -Verification $verificationMode -SourceHash '' -DestinationHash '' -Message 'Would copy.'
            $completedBytes += $sourceLength
            continue
        }

        $sourceState = Get-OneDriveFileState -Path $sourceItem.FullName
        $sourceHash = ''
        $destinationHash = ''
        $fileCompleted = $false
        $fileSkippedAsMatch = $false

        try {
            $destinationDirectory = Split-Path -Parent $destinationPath
            if (-not (Test-Path -LiteralPath $destinationDirectory -PathType Container)) {
                New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
            }

            if (Test-Path -LiteralPath $destinationPath -PathType Leaf) {
                $existingDestination = Get-Item -LiteralPath $destinationPath -Force
                $sameSize = ([UInt64]$existingDestination.Length -eq $sourceLength)

                if ($sameSize -and $verificationMode -eq 'SHA256') {
                    Write-Info 'Destination has the same size. Computing SHA-256 hashes to confirm it is identical.'
                    $sourceHash = Get-Sha256 -Path $sourceItem.FullName
                    $destinationHash = Get-Sha256 -Path $destinationPath
                    $sameSize = $sourceHash -eq $destinationHash
                }

                if ($sameSize) {
                    Write-Ok "Already present and verified by $verificationMode; skipping copy."
                    $fileCompleted = $true
                    $fileSkippedAsMatch = $true
                    $skippedCount++

                    Add-ManifestRow -Status 'SKIPPED-MATCH' -RelativePath $relativePath -Size $sourceLength `
                        -Verification $verificationMode -SourceHash $sourceHash -DestinationHash $destinationHash `
                        -Message 'Destination already matched.'
                }
                else {
                    switch ($conflictMode) {
                        'Rename' {
                            $conflictPath = Get-SafeConflictName -Path $destinationPath -Tag 'preexisting'
                            Move-Item -LiteralPath $destinationPath -Destination $conflictPath -Force
                            $renamedConflictCount++
                            Write-Warn "Existing mismatched file renamed to: $conflictPath"
                        }
                        'Overwrite' {
                            Remove-Item -LiteralPath $destinationPath -Force
                            Write-Warn 'Existing mismatched destination file will be overwritten.'
                        }
                        'Skip' {
                            Write-Warn 'Existing mismatched destination file was skipped by policy.'
                            $failedCount++
                            Add-ManifestRow -Status 'SKIPPED-CONFLICT' -RelativePath $relativePath -Size $sourceLength `
                                -Verification $verificationMode -SourceHash $sourceHash -DestinationHash $destinationHash `
                                -Message 'Destination differed and conflict policy was Skip.'
                            continue
                        }
                    }
                }
            }

            if (-not $fileCompleted) {
                # A cloud-only file may need local room approximately equal to
                # its own size while OneDrive hydrates it. Enforce this before
                # opening every file, because prior files may still be awaiting
                # asynchronous eviction by OneDrive.
                if ($sourceDeviceId) {
                    [UInt64]$requiredLocalFreeBytes = ([UInt64]$minimumLocalReserveGB * 1GB)

                    if ($sourceState.WasOffline -or
                        $sourceState.WasUnpinned -or
                        $sourceState.RecallOnOpen -or
                        $sourceState.RecallOnData) {
                        $requiredLocalFreeBytes += $sourceLength
                    }

                    if (-not (Wait-ForSourceDriveCapacity `
                        -DeviceID $sourceDeviceId `
                        -RequiredFreeBytes $requiredLocalFreeBytes `
                        -MaximumWaitMinutes $localSpaceWaitMinutes `
                        -RelativePath $relativePath)) {
                        throw "Stopped safely because internal-drive free space was below the required level for this file."
                    }

                    Write-Progress -Id 3 -Activity 'Internal-drive free-space check' -Completed
                }

                $copyResult = Copy-OneFileResumable `
                    -SourcePath $sourceItem.FullName `
                    -DestinationPath $destinationPath `
                    -ExpectedLength $sourceLength `
                    -BufferMegabytes $bufferMegabytes `
                    -RetryCount $retryCount `
                    -OverallBytesBefore $completedBytes `
                    -OverallTotalBytes $totalBytes `
                    -FileNumber $fileNumber `
                    -TotalFiles $sourceFiles.Count

                if (-not $copyResult.Success) {
                    throw "Copy failed after $($copyResult.Attempts) attempt(s): $($copyResult.ErrorMessage)"
                }

                $sourceLength = [UInt64]$copyResult.ExpectedLength

                $destinationLength = [UInt64](Get-Item -LiteralPath $destinationPath -Force).Length
                if ($destinationLength -ne $sourceLength) {
                    throw "Destination size is $(Format-Bytes $destinationLength); expected $(Format-Bytes $sourceLength)."
                }

                if ($verificationMode -eq 'SHA256') {
                    Write-Info 'Computing SHA-256 hashes.'
                    $sourceHash = Get-Sha256 -Path $sourceItem.FullName
                    $destinationHash = Get-Sha256 -Path $destinationPath

                    if ($sourceHash -ne $destinationHash) {
                        throw 'SHA-256 verification failed. The source and destination hashes differ.'
                    }
                }

                Set-DestinationMetadata -SourceItem $sourceItem -DestinationPath $destinationPath
                $copiedCount++
                $fileCompleted = $true

                Add-ManifestRow -Status 'COPIED' -RelativePath $relativePath -Size $sourceLength `
                    -Verification $verificationMode -SourceHash $sourceHash -DestinationHash $destinationHash `
                    -Message "Copied successfully in $($copyResult.Attempts) attempt(s)."

                Write-Ok "Copied and verified: $relativePath"
            }

            if ($fileCompleted -and $freeSourceAfterCopy) {
                $shouldUnpin = (-not $sourceState.WasPinned) -or $unpinPreviouslyPinned

                if ($shouldUnpin) {
                    if (Set-OneDriveFileOnlineOnly -Path $sourceItem.FullName) {
                        $onlineOnlySuccessCount++
                        Write-Info 'Source file returned to online-only.'
                    }
                    else {
                        $onlineOnlyFailureCount++
                    }
                }
                else {
                    Write-Info 'Source file was previously pinned; its Always-keep-on-device state was preserved.'
                }
            }
        }
        catch {
            $failedCount++
            $message = $_.Exception.Message
            Write-Fail "$relativePath - $message"
            Add-ManifestRow -Status 'FAILED' -RelativePath $relativePath -Size $sourceLength `
                -Verification $verificationMode -SourceHash $sourceHash -DestinationHash $destinationHash `
                -Message $message
            Add-ErrorRow -RelativePath $relativePath -Stage 'CopyOrVerify' -Message $message
        }
        finally {
            $completedBytes += $sourceLength
        }
    }

    Write-Progress -Id 2 -ParentId 1 -Activity 'Complete' -Completed
    Write-Progress -Id 1 -Activity 'OneDrive to USB' -Completed

    # Reapply directory timestamps after file creation, because creating children
    # can change a directory's LastWriteTime.
    if (-not $dryRun) {
        foreach ($sourceDirectory in ($sourceDirectories | Sort-Object { $_.FullName.Length } -Descending)) {
            try {
                $relativeDirectory = Get-RelativePathCompat -BasePath $sourceFolder -FullPath $sourceDirectory.FullName
                $destinationDirectory = Join-Path $destinationFolder $relativeDirectory
                $destinationDirectoryItem = Get-Item -LiteralPath $destinationDirectory -Force
                $destinationDirectoryItem.CreationTimeUtc = $sourceDirectory.CreationTimeUtc
                $destinationDirectoryItem.LastWriteTimeUtc = $sourceDirectory.LastWriteTimeUtc
            }
            catch {
                # Metadata warning was already non-fatal.
            }
        }
    }

    $runEnd = Get-Date
    $duration = $runEnd - $runStart

    Write-Title 'Completed'

    Write-Host "Copied:                         $copiedCount"
    Write-Host "Skipped because already match: $skippedCount"
    Write-Host "Failed or conflict-skipped:     $failedCount"
    Write-Host "Existing conflicts renamed:     $renamedConflictCount"
    Write-Host "Returned to online-only:        $onlineOnlySuccessCount"
    Write-Host "Online-only reset warnings:     $onlineOnlyFailureCount"
    Write-Host "Duration:                       $($duration.ToString())"
    Write-Host "Destination:                    $destinationFolder"
    Write-Host "Run log:                        $script:RunLogPath"
    Write-Host "Manifest:                       $script:ManifestPath"
    Write-Host "Error log:                      $script:ErrorLogPath"

    Write-Info "Run finished. Copied=$copiedCount; SkippedMatch=$skippedCount; Failed=$failedCount; ConflictsRenamed=$renamedConflictCount; OnlineOnly=$onlineOnlySuccessCount; Duration=$duration"

    if ($failedCount -eq 0) {
        Write-Ok 'The run completed without copy failures.'
        $exitCode = 0
    }
    else {
        Write-Warn 'The run completed with one or more failures. Rerun the script with the same source and destination; completed files will be skipped and partial files will resume.'
        $exitCode = 3
    }
}
catch {
    Write-Fail $_.Exception.Message

    if ($script:ErrorLogPath) {
        Add-ErrorRow -RelativePath '' -Stage 'Fatal' -Message $_.Exception.Message
    }

    $exitCode = 1
}
finally {
    Disable-KeepAwake
    Write-Progress -Id 3 -Activity 'Internal-drive free-space check' -Completed -ErrorAction SilentlyContinue

    if ($script:RunLogPath) {
        Add-Content -LiteralPath $script:RunLogPath -Value "$(Get-Date -Format o) [EXIT] Code=$exitCode" -Encoding UTF8
    }

    Write-Host ''
    Write-Host "Exit code: $exitCode"
    Write-Host 'You may close this window.' -ForegroundColor Gray
}

exit $exitCode
