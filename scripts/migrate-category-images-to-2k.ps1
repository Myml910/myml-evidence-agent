param(
  [switch]$Apply,
  [switch]$Force,
  [string]$DataDir = (Join-Path $PSScriptRoot '..\server\data')
)

$ErrorActionPreference = 'Stop'

$resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
$imageDir = Join-Path $resolvedDataDir 'category-images'
$overridesPath = Join-Path $resolvedDataDir 'category-catalog-overrides.json'
$backupRoot = Join-Path $resolvedDataDir 'category-image-migration-backups'

if (-not (Test-Path $imageDir)) {
  throw "Category image directory not found: $imageDir"
}

if (-not (Test-Path $overridesPath)) {
  throw "Category catalog overrides not found: $overridesPath"
}

Add-Type -AssemblyName System.Drawing

function Get-CategoryImageFilenameFromUrl {
  param([string]$Url)

  if ([string]::IsNullOrWhiteSpace($Url)) {
    return ''
  }

  $pathValue = $Url
  try {
    $uri = [System.Uri]::new($Url)
    $pathValue = $uri.AbsolutePath
  } catch {
    $pathValue = $Url
  }

  $decodedPath = [System.Uri]::UnescapeDataString($pathValue)
  $marker = '/category-images/'
  $markerIndex = $decodedPath.IndexOf($marker, [System.StringComparison]::OrdinalIgnoreCase)
  if ($markerIndex -lt 0) {
    return ''
  }

  $filename = $decodedPath.Substring($markerIndex + $marker.Length)
  if ([string]::IsNullOrWhiteSpace($filename) -or $filename.Contains('/') -or $filename.Contains('\')) {
    return ''
  }

  return $filename
}

function Set-CategoryImageFilenameInUrl {
  param(
    [string]$Url,
    [string]$Filename
  )

  $encodedFilename = [System.Uri]::EscapeDataString($Filename)
  return [System.Text.RegularExpressions.Regex]::Replace(
    $Url,
    '(/category-images/)[^?#]+',
    "`${1}$encodedFilename",
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
  )
}

function Get-CanvasSpec {
  param(
    [int]$Width,
    [int]$Height
  )

  $ratio = $Width / [Math]::Max(1, $Height)
  if ($ratio -gt 1.08) {
    return [pscustomobject]@{
      Kind = 'landscape'
      Width = 2048
      Height = 1024
    }
  }
  if ($ratio -lt 0.92) {
    return [pscustomobject]@{
      Kind = 'portrait'
      Width = 1024
      Height = 2048
    }
  }

  return [pscustomobject]@{
    Kind = 'square'
    Width = 2048
    Height = 2048
  }
}

function Get-MigratedFilename {
  param(
    [string]$Filename,
    [object]$Spec
  )

  $baseName = [System.IO.Path]::GetFileNameWithoutExtension($Filename)
  if ([string]::IsNullOrWhiteSpace($baseName)) {
    $baseName = 'category-image'
  }

  $baseName = $baseName -replace '-2k-(square|landscape|portrait)-\d+x\d+$', ''
  return "$baseName-2k-$($Spec.Kind)-$($Spec.Width)x$($Spec.Height).jpg"
}

function Add-ReferencedImageFilename {
  param(
    [object]$Node,
    [System.Collections.Generic.HashSet[string]]$Filenames
  )

  if ($null -eq $Node) {
    return
  }

  if ($Node -is [System.Collections.IEnumerable] -and $Node -isnot [string]) {
    foreach ($item in $Node) {
      Add-ReferencedImageFilename -Node $item -Filenames $Filenames
    }
    return
  }

  if ($Node -is [pscustomobject]) {
    foreach ($property in $Node.PSObject.Properties) {
      if ($property.Name -eq 'image_url') {
        $filename = Get-CategoryImageFilenameFromUrl -Url ([string]$property.Value)
        if ($filename) {
          [void]$Filenames.Add($filename)
        }
      } else {
        Add-ReferencedImageFilename -Node $property.Value -Filenames $Filenames
      }
    }
  }
}

function Update-ImageReferences {
  param(
    [object]$Node,
    [hashtable]$FilenameMap
  )

  if ($null -eq $Node) {
    return
  }

  if ($Node -is [System.Collections.IEnumerable] -and $Node -isnot [string]) {
    foreach ($item in $Node) {
      Update-ImageReferences -Node $item -FilenameMap $FilenameMap
    }
    return
  }

  if ($Node -is [pscustomobject]) {
    $imageUrlProperty = $Node.PSObject.Properties['image_url']
    if ($imageUrlProperty) {
      $oldFilename = Get-CategoryImageFilenameFromUrl -Url ([string]$imageUrlProperty.Value)
      if ($oldFilename -and $FilenameMap.ContainsKey($oldFilename)) {
        $newFilename = [string]$FilenameMap[$oldFilename]
        $imageUrlProperty.Value = Set-CategoryImageFilenameInUrl -Url ([string]$imageUrlProperty.Value) -Filename $newFilename
        $imageFilenameProperty = $Node.PSObject.Properties['image_filename']
        if ($imageFilenameProperty) {
          $imageFilenameProperty.Value = $newFilename
        }
      }
    }

    foreach ($property in $Node.PSObject.Properties) {
      if ($property.Name -ne 'image_url' -and $property.Name -ne 'image_filename') {
        Update-ImageReferences -Node $property.Value -FilenameMap $FilenameMap
      }
    }
  }
}

function Save-PaddedJpeg {
  param(
    [string]$SourcePath,
    [string]$TargetPath,
    [object]$Spec
  )

  $sourceImage = $null
  $bitmap = $null
  $graphics = $null
  $encoderParams = $null

  try {
    $sourceImage = [System.Drawing.Image]::FromFile($SourcePath)
    $bitmap = [System.Drawing.Bitmap]::new([int]$Spec.Width, [int]$Spec.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.Clear([System.Drawing.Color]::White)
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality

    $scale = [Math]::Min($Spec.Width / $sourceImage.Width, $Spec.Height / $sourceImage.Height)
    $drawWidth = [Math]::Max(1, [Math]::Round($sourceImage.Width * $scale))
    $drawHeight = [Math]::Max(1, [Math]::Round($sourceImage.Height * $scale))
    $drawX = [Math]::Round(($Spec.Width - $drawWidth) / 2)
    $drawY = [Math]::Round(($Spec.Height - $drawHeight) / 2)

    $graphics.DrawImage($sourceImage, [int]$drawX, [int]$drawY, [int]$drawWidth, [int]$drawHeight)

    $jpegEncoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
      Where-Object { $_.MimeType -eq 'image/jpeg' } |
      Select-Object -First 1
    $encoderParams = [System.Drawing.Imaging.EncoderParameters]::new(1)
    $encoderParams.Param[0] = [System.Drawing.Imaging.EncoderParameter]::new(
      [System.Drawing.Imaging.Encoder]::Quality,
      [int64]88
    )
    $bitmap.Save($TargetPath, $jpegEncoder, $encoderParams)
  } finally {
    if ($encoderParams) {
      $encoderParams.Dispose()
    }
    if ($graphics) {
      $graphics.Dispose()
    }
    if ($bitmap) {
      $bitmap.Dispose()
    }
    if ($sourceImage) {
      $sourceImage.Dispose()
    }
  }
}

$rawJson = Get-Content -Path $overridesPath -Raw -Encoding UTF8
$catalogEntries = $rawJson | ConvertFrom-Json
$referencedFilenames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
Add-ReferencedImageFilename -Node $catalogEntries -Filenames $referencedFilenames

$supportedExtensions = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
@('.jpg', '.jpeg', '.png', '.gif') | ForEach-Object { [void]$supportedExtensions.Add($_) }

$migrationRows = New-Object System.Collections.Generic.List[object]
$skippedRows = New-Object System.Collections.Generic.List[object]

foreach ($filename in $referencedFilenames) {
  $sourcePath = Join-Path $imageDir $filename
  if (-not (Test-Path $sourcePath)) {
    $skippedRows.Add([pscustomobject]@{
      File = $filename
      Reason = 'file not found'
    })
    continue
  }

  $extension = [System.IO.Path]::GetExtension($sourcePath)
  if (-not $supportedExtensions.Contains($extension)) {
    $skippedRows.Add([pscustomobject]@{
      File = $filename
      Reason = "unsupported extension $extension"
    })
    continue
  }

  $image = $null
  try {
    $image = [System.Drawing.Image]::FromFile($sourcePath)
    $spec = Get-CanvasSpec -Width $image.Width -Height $image.Height
    $outputFilename = Get-MigratedFilename -Filename $filename -Spec $spec
    $outputPath = Join-Path $imageDir $outputFilename
    $alreadyTargetSize = $image.Width -eq $spec.Width -and $image.Height -eq $spec.Height

    if ($alreadyTargetSize -and ([System.IO.Path]::GetExtension($filename).ToLowerInvariant() -eq '.jpg' -or [System.IO.Path]::GetExtension($filename).ToLowerInvariant() -eq '.jpeg')) {
      $skippedRows.Add([pscustomobject]@{
        File = $filename
        Reason = "already $($spec.Width)x$($spec.Height)"
      })
      continue
    }

    $migrationRows.Add([pscustomobject]@{
      SourceFile = $filename
      OutputFile = $outputFilename
      SourceSize = "$($image.Width)x$($image.Height)"
      TargetSize = "$($spec.Width)x$($spec.Height)"
      Layout = $spec.Kind
      OutputPath = $outputPath
    })
  } catch {
    $skippedRows.Add([pscustomobject]@{
      File = $filename
      Reason = $_.Exception.Message
    })
  } finally {
    if ($image) {
      $image.Dispose()
    }
  }
}

Write-Host "Category image 2K padding migration"
Write-Host "Data dir: $resolvedDataDir"
Write-Host "Referenced local images: $($referencedFilenames.Count)"
Write-Host "To migrate: $($migrationRows.Count)"
Write-Host "Skipped: $($skippedRows.Count)"

if ($migrationRows.Count -gt 0) {
  $migrationRows |
    Select-Object SourceFile,SourceSize,Layout,TargetSize,OutputFile |
    Format-Table -AutoSize
}

if ($skippedRows.Count -gt 0) {
  Write-Host ''
  Write-Host 'Skipped files:'
  $skippedRows | Format-Table -AutoSize
}

if (-not $Apply) {
  Write-Host ''
  Write-Host 'Dry run only. Re-run with -Apply to create backups, write padded 2K images, and update category-catalog-overrides.json.'
  exit 0
}

if ($migrationRows.Count -eq 0) {
  Write-Host 'No images need migration.'
  exit 0
}

$backupDir = Join-Path $backupRoot (Get-Date -Format 'yyyyMMdd-HHmmss')
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
Copy-Item -Path $overridesPath -Destination (Join-Path $backupDir 'category-catalog-overrides.json') -Force
Copy-Item -Path $imageDir -Destination (Join-Path $backupDir 'category-images') -Recurse -Force
Write-Host "Backup written: $backupDir"

$filenameMap = @{}
foreach ($row in $migrationRows) {
  $sourcePath = Join-Path $imageDir $row.SourceFile
  if ((Test-Path $row.OutputPath) -and -not $Force) {
    Write-Host "Using existing output: $($row.OutputFile)"
  } else {
    Save-PaddedJpeg -SourcePath $sourcePath -TargetPath $row.OutputPath -Spec ([pscustomobject]@{
      Kind = $row.Layout
      Width = [int]($row.TargetSize.Split('x')[0])
      Height = [int]($row.TargetSize.Split('x')[1])
    })
    Write-Host "Wrote: $($row.OutputFile)"
  }
  $filenameMap[$row.SourceFile] = $row.OutputFile
}

Update-ImageReferences -Node $catalogEntries -FilenameMap $filenameMap
$updatedJson = $catalogEntries | ConvertTo-Json -Depth 24
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($overridesPath, $updatedJson + [Environment]::NewLine, $utf8NoBom)

Write-Host "Updated overrides: $overridesPath"
Write-Host "Done."
