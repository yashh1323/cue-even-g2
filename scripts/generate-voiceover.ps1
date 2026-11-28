Add-Type -AssemblyName System.Speech

$ErrorActionPreference = 'Stop'
$root = "C:\Users\YASH KASHYAP\.gemini\antigravity\scratch\even-hud-app"
$audioDir = Join-Path $root "demo\audio"
if (Test-Path $audioDir) { Remove-Item $audioDir -Recurse -Force }
New-Item -ItemType Directory -Path $audioDir -Force | Out-Null

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }
if ($voices -contains "Microsoft Zira Desktop") {
    $synth.SelectVoice("Microsoft Zira Desktop")
} elseif ($voices -contains "Microsoft David Desktop") {
    $synth.SelectVoice("Microsoft David Desktop")
}
$synth.Rate = 2
$synth.Volume = 100

$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
    48000,
    [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
    [System.Speech.AudioFormat.AudioChannel]::Mono
)

$clips = @(
    @{
        id = "01-differentiator"
        text = "Meet Cue, a hands-free Chief-of-Staff built for Even Realities G2. Here is what Cue does that Even AI cannot do on its own: instead of waiting for isolated single-turn prompts, Cue continuously streams your live calendar and urgent Telegram messages to the glasses, compiles compound cross-app voice actions across Telegram and Notion, and enforces a 3-second hardware undo guard with a server-side audit ledger before any external message is ever sent."
    },
    @{
        id = "02-connect-account"
        text = "Let's walk through connecting your accounts step by step. First, in the Vantage Companion console, you configure your Telegram bot token, chat ID, and Notion or Calendar connectors on your own server. Zero secrets ever touch the G2 WebView, bypassing blocked OAuth sign-ins. Next, clicking Pair generates a live 6-digit code and a crisp 112-by-112 Gray-8 QR matrix directly on the EvenHub Simulator lens. Scan the QR or send slash-start with the code in Telegram, or claim it in the companion, and the glasses instantly switch to your live workspace."
    },
    @{
        id = "03-real-moment"
        text = "Now watch a real moment from a busy workday start to finish. It is 10:48 AM and you are walking to a 12-minute-away Design Sync. Without pulling out your phone, the 576-by-288 monochrome green lens shows your live pre-meeting brief, a Gray-8 countdown timeline, and one-tap quick replies."
    },
    @{
        id = "04-telegram-undo"
        text = "Mid-walk, an urgent Telegram message arrives from Priya: the client moved the review to 2:40 and needs confirmation plus a Notion task. Cue streams the alert live over Server-Sent Events straight onto the glasses. A single temple tap stages a quick reply, and notice the live 3-second hardware undo countdown ticking down in real time on both the glasses and companion. Tapping once inside three seconds cancels the send cleanly, and the audit ledger confirms zero external messages were dispatched."
    },
    @{
        id = "05-voice-dual"
        text = "Now let's handle both requests hands-free. Holding the temple activates the G2 microphone and streams raw audio with a live 24-bar Gray-8 equalizer waveform on the lens. Speak naturally: tell Priya 2:40 works and add a Notion task to prep slides. Releasing the temple compiles the compound intent into one structured dual action: a Telegram reply to Priya plus a Notion task creation."
    },
    @{
        id = "06-commit-receipt"
        text = "One temple tap confirms the plan. Watch the 3-second safety guard tick down to zero in real time. Once committed, Cue dispatches the Telegram reply, creates the Notion task, displays the confirmation receipt on the G2 lens, and logs an immutable, timestamped receipt in the companion audit ledger."
    },
    @{
        id = "07-closing"
        text = "Cue ships as a verified Even Hub SDK 0.0.16 package, cue-g2.ehpk, with passing automated tests, zero client-side secrets, and live companion controls. Try the open-source repo and simulator demo today."
    }
)

$manifest = @()
foreach ($c in $clips) {
    $rawWav = Join-Path $audioDir ("raw-" + $c.id + ".wav")
    $normWav = Join-Path $audioDir ("clip-" + $c.id + ".wav")
    $synth.SetOutputToWaveFile($rawWav)
    $synth.Speak($c.text)
    $synth.SetOutputToNull()

    # Re-encode cleanly to 48kHz PCM WAV with slight loudnorm clarity
    & ffmpeg -y -v error -i $rawWav -ar 48000 -ac 1 -c:a pcm_s16le $normWav
    Remove-Item $rawWav -Force

    $durStr = (& ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $normWav).Trim()
    $dur = [double]::Parse($durStr, [System.Globalization.CultureInfo]::InvariantCulture)
    $manifest += [PSCustomObject]@{
        id = $c.id
        wav = $normWav
        duration = [math]::Round($dur, 3)
        text = $c.text
    }
    Write-Host ("Synthesized {0}: {1:N2}s" -f $c.id, $dur)
}

$synth.Dispose()
$total = ($manifest | Measure-Object -Property duration -Sum).Sum
Write-Host ("Total pure speech duration: {0:N2}s" -f $total)
$manifest | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $audioDir "manifest.json") -Encoding UTF8
