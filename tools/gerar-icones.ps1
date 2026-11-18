# Gera os ícones da extensão (círculo vermelho com "C" branco) em icons/.
# Uso (uma vez): powershell -ExecutionPolicy Bypass -File tools\gerar-icones.ps1
Add-Type -AssemblyName System.Drawing

$destino = Join-Path $PSScriptRoot '..\icons'
New-Item -ItemType Directory -Force -Path $destino | Out-Null

foreach ($tam in 16, 48, 128) {
    $bmp = New-Object System.Drawing.Bitmap $tam, $tam
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear([System.Drawing.Color]::Transparent)

    $margem = [Math]::Max(1, [int]($tam * 0.04))
    $pincel = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 229, 38, 43))
    $g.FillEllipse($pincel, $margem, $margem, $tam - 2 * $margem - 1, $tam - 2 * $margem - 1)

    $fonte = New-Object System.Drawing.Font 'Segoe UI', ([single]($tam * 0.58)), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
    $formato = New-Object System.Drawing.StringFormat
    $formato.Alignment = [System.Drawing.StringAlignment]::Center
    $formato.LineAlignment = [System.Drawing.StringAlignment]::Center
    $area = New-Object System.Drawing.RectangleF 0, ([single]($tam * 0.02)), $tam, $tam
    $g.DrawString('C', $fonte, [System.Drawing.Brushes]::White, $area, $formato)

    $arquivo = Join-Path $destino ("icon{0}.png" -f $tam)
    $bmp.Save($arquivo, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose(); $fonte.Dispose(); $pincel.Dispose()
    Write-Host "gerado $arquivo"
}
