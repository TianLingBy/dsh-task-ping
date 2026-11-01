# Play the notification sound on the *communications* render endpoint so Windows
# ducks other applications by itself.
#
# Windows already owns "lower other media by 50% while a communication is active"
# (Control Panel -> Sound -> Communications). An app joins that experience by
# rendering to the eCommunications role endpoint: WASAPI renders our WAV there and
# the audio engine applies the user's ducking setting to every other session.
#
# Therefore this file never writes another application's volume. It contains no
# ISimpleAudioVolume at all, so there is no write path to delete later. Our own
# loudness is applied by scaling the PCM samples we push.
#
#   -Action Play   one-shot: play -WavFile (PCM 16-bit) and exit (bounded by -MaxMs)
#   -Action Serve  long-lived helper the Host drives through -CmdFile (~40 ms poll);
#                  exits after 10 min idle, when the parent dies, or on 'exit'
#
# Nothing here persists state: when the stream stops (or this process dies) Windows
# un-ducks on its own, so a crash cannot leave another app quiet.
[CmdletBinding()]
param(
  [ValidateSet('Play', 'Serve')]
  [string]$Action = 'Play',
  [string]$WavFile = '',
  [double]$Volume = 1.0,
  [string]$CmdFile = (Join-Path $env:TEMP 'dsh-task-notify\cmd.json'),
  [string]$AckFile = (Join-Path $env:TEMP 'dsh-task-notify\ack.txt'),
  [int]$MaxMs = 4000,
  [string]$BootId = '',
  [int]$ParentPid = 0,
  # 1 = move the communications default onto the current playback default before each
  # play, so Windows' ducking applies to the device the user is actually listening on.
  # 0 = old behaviour (play on whatever the communications default already is).
  # -1 = auto: on for Serve (the Host's notification helper), off for one-shot Play.
  [int]$SyncComm = -1
)

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $CmdFile
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$LogFile = Join-Path $dir 'play-comm.log'

function Write-Log([string]$text) {
  try {
    $line = '{0:yyyy-MM-dd HH:mm:ss.fff} [{1}] {2}' -f (Get-Date), $Action, $text
    Add-Content -LiteralPath $LogFile -Value $line -Encoding utf8
  } catch {}
}

# ---- WASAPI interop (render only; no session volume interface) --------------
$csharp = @'
using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class DshAudioComm
{
    const int eRender = 0;
    const int eCommunications = 2;
    const int CLSCTX_ALL = 23;
    const int AUDCLNT_SHAREMODE_SHARED = 0;
    const uint AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = 0x80000000;
    const uint AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY = 0x08000000;
    const long BUFFER_DURATION = 2000000; // 200 ms

    // A preview must be replaceable: the caller starts a new sound while the previous
    // one is still ringing (volume slider), and waiting for it to finish is what made
    // repeated clicks feel delayed and out of sync. `Stop` flips this flag and the
    // playing thread exits its loops at the next check, then the stream is closed in
    // `finally`, so Windows un-ducks immediately.
    private static volatile bool _stop;
    public static void Stop() { _stop = true; }
    public static bool IsStopping() { return _stop; }

    /// <summary>Run Play on a background thread so the caller keeps reading commands.</summary>
    public static System.Threading.Thread Start(string wavPath, double volume, int maxMs, string ackPath, int seq, bool syncComm)
    {
        var thread = new System.Threading.Thread(() =>
        {
            try { Play(wavPath, volume, maxMs, ackPath, seq, syncComm); }
            catch (Exception ex) { try { WriteAck(ackPath, seq, false, ex.Message); } catch { } }
        });
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, [MarshalAs(UnmanagedType.IUnknown)] out object devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, [MarshalAs(UnmanagedType.Interface)] out IMMDevice endpoint);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, [MarshalAs(UnmanagedType.Interface)] out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        [PreserveSig] int Activate([In] ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        [PreserveSig] int OpenPropertyStore(int access, out IntPtr store);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out int state);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, uint streamFlags, long hnsBufferDuration, long hnsPeriodicity, [In] ref WAVEFORMATEX format, [In] ref Guid sessionGuid);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint frames);
        [PreserveSig] int IsFormatSupported(int shareMode, [In] ref WAVEFORMATEX format, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService([In] ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioRenderClient
    {
        [PreserveSig] int GetBuffer(uint numFramesRequested, out IntPtr data);
        [PreserveSig] int ReleaseBuffer(uint numFramesWritten, uint flags);
    }

    // Undocumented but long-lived: the shell's own audio device picker goes through
    // this object. Only SetDefaultEndpoint is called, and only when the caller asked
    // for it (-SyncComm), because it rewrites a user setting.
    [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
    class PolicyConfigClient { }

    [ComImport, Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPolicyConfig
    {
        [PreserveSig] int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string id, out IntPtr fmt);
        [PreserveSig] int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, int def, out IntPtr fmt);
        [PreserveSig] int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id);
        [PreserveSig] int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr a, IntPtr b);
        [PreserveSig] int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, int def, out long a, out long b);
        [PreserveSig] int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string id, ref long p);
        [PreserveSig] int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr mode);
        [PreserveSig] int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr mode);
        [PreserveSig] int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr key, IntPtr val);
        [PreserveSig] int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr key, IntPtr val);
        [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
        [PreserveSig] int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string id, int visible);
    }

    static string Hex(int hr) { return "0x" + hr.ToString("X8", CultureInfo.InvariantCulture); }

    // Point the *communications* default at whatever the user is listening on, so the
    // notification (and therefore Windows' ducking) lands on the same endpoint as the
    // game/music. Windows ducks per endpoint: with the two defaults apart the sound is
    // audible but nothing on the playback device is lowered.
    // Never restores: following the playback device is the point.
    public static string SyncCommDevice()
    {
        IMMDeviceEnumerator en = null;
        IMMDevice media = null, comm = null;
        try
        {
            en = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            int hr = en.GetDefaultAudioEndpoint(eRender, 1, out media);
            if (hr != 0 || media == null) return "fail:playEndpoint=" + Hex(hr);
            string mediaId;
            media.GetId(out mediaId);

            hr = en.GetDefaultAudioEndpoint(eRender, eCommunications, out comm);
            if (hr == 0 && comm != null)
            {
                string commId;
                comm.GetId(out commId);
                if (commId == mediaId) return "ok:same";
            }

            var pc = (IPolicyConfig)new PolicyConfigClient();
            hr = pc.SetDefaultEndpoint(mediaId, eCommunications);
            Marshal.ReleaseComObject(pc);
            if (hr != 0) return "fail:set=" + Hex(hr);

            // Read it back: the call can succeed and still leave the old default.
            if (comm != null) { Marshal.ReleaseComObject(comm); comm = null; }
            hr = en.GetDefaultAudioEndpoint(eRender, eCommunications, out comm);
            if (hr != 0 || comm == null) return "fail:reread=" + Hex(hr);
            string now;
            comm.GetId(out now);
            return now == mediaId ? "ok:moved" : "fail:verify";
        }
        catch (Exception ex)
        {
            return "fail:ex=" + ex.GetType().Name + ":" + Hex(ex.HResult);
        }
        finally
        {
            if (comm != null) { try { Marshal.ReleaseComObject(comm); } catch { } }
            if (media != null) { try { Marshal.ReleaseComObject(media); } catch { } }
            if (en != null) { try { Marshal.ReleaseComObject(en); } catch { } }
        }
    }

    // Read-only ack so the Host learns whether the stream is actually running.
    // Written before playback continues, so a silent failure never keeps the page quiet.
    public static void WriteAck(string path, int seq, bool ok, string message)
    {
        if (path == null) return;
        try
        {
            var sb = new StringBuilder();
            sb.Append("seq=").Append(seq).Append('\t').Append("ok=").Append(ok ? 1 : 0)
              .Append('\t').Append((message ?? "").Replace("\r", " ").Replace("\n", " "));
            var tmp = path + ".tmp";
            // No BOM: the Host parses the first field as `seq=`.
            File.WriteAllText(tmp, sb.ToString(), new UTF8Encoding(false));
            if (File.Exists(path)) File.Replace(tmp, path, null);
            else File.Move(tmp, path);
        }
        catch { }
    }

    public static void ParseWav(string path, out byte[] pcm, out int channels, out int rate, out int blockAlign, out int bits)
    {
        pcm = null; channels = 0; rate = 0; blockAlign = 0; bits = 0;
        var all = File.ReadAllBytes(path);
        if (all.Length < 12) throw new InvalidDataException("file too short");
        if (Encoding.ASCII.GetString(all, 0, 4) != "RIFF" || Encoding.ASCII.GetString(all, 8, 4) != "WAVE")
            throw new InvalidDataException("not RIFF/WAVE");
        int pos = 12;
        long dataOff = -1, dataLen = 0;
        int tag = 0;
        while (pos + 8 <= all.Length)
        {
            string id = Encoding.ASCII.GetString(all, pos, 4);
            int size = BitConverter.ToInt32(all, pos + 4);
            if (size < 0) break;
            int body = pos + 8;
            if (body + size > all.Length) size = all.Length - body;
            if (id == "fmt " && size >= 16)
            {
                tag = BitConverter.ToUInt16(all, body);
                channels = BitConverter.ToUInt16(all, body + 2);
                rate = (int)BitConverter.ToUInt32(all, body + 4);
                blockAlign = BitConverter.ToUInt16(all, body + 12);
                bits = BitConverter.ToUInt16(all, body + 14);
                if (tag == 0xFFFE && size >= 40) tag = BitConverter.ToUInt16(all, body + 24);
            }
            else if (id == "data")
            {
                dataOff = body;
                dataLen = size;
            }
            pos = body + size + (size & 1);
        }
        if (tag == 0) throw new InvalidDataException("no fmt chunk");
        if (tag != 1) throw new InvalidDataException("not PCM (wFormatTag=" + tag + ")");
        if (bits != 16) throw new InvalidDataException("not 16-bit PCM (bits=" + bits + ")");
        if (channels <= 0 || rate <= 0) throw new InvalidDataException("bad fmt values");
        if (blockAlign != channels * 2) throw new InvalidDataException("bad blockAlign=" + blockAlign);
        if (dataOff < 0) throw new InvalidDataException("no data chunk");
        if (dataLen <= 0) throw new InvalidDataException("empty data chunk");
        var outBuf = new byte[(int)dataLen];
        Array.Copy(all, dataOff, outBuf, 0, (int)dataLen);
        pcm = outBuf;
    }

    // Play PCM 16-bit on the eCommunications endpoint and return an observation
    // line. Everything is bounded by maxMs; the stream is stopped in finally so
    // Windows unducks immediately even when a step throws.
    public static string Play(string wavPath, double volume, int maxMs, string ackPath, int seq, bool syncComm)
    {
        _stop = false;
        var started = DateTime.UtcNow;
        // Best effort and never fatal: if the device cannot be moved the sound still
        // plays where it used to, only without ducking.
        string sync = syncComm ? SyncCommDevice() : "skip";
        byte[] pcm; int channels, rate, blockAlign, bits;
        ParseWav(wavPath, out pcm, out channels, out rate, out blockAlign, out bits);

        double v = Math.Max(0.0, Math.Min(1.0, volume));
        int sampleCount = pcm.Length / 2;
        var samples = new short[sampleCount];
        for (int i = 0; i < sampleCount; i++)
        {
            int s = (short)(pcm[i * 2] | (pcm[i * 2 + 1] << 8));
            int scaled = (int)Math.Round(s * v);
            if (scaled > 32767) scaled = 32767;
            if (scaled < -32768) scaled = -32768;
            samples[i] = (short)scaled;
        }

        int totalFrames = pcm.Length / blockAlign;
        int maxFrames = (int)((long)rate * Math.Max(50, maxMs) / 1000L);
        if (totalFrames > maxFrames) totalFrames = maxFrames;
        if (totalFrames <= 0) throw new InvalidDataException("nothing to play");

        IMMDevice dev = null;
        object clientObj = null;
        object renderObj = null;
        IAudioClient client = null;
        IAudioRenderClient render = null;
        bool started2 = false;
        try
        {
            var devEnum = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            int hr = devEnum.GetDefaultAudioEndpoint(eRender, eCommunications, out dev);
            if (hr != 0) throw new COMException("GetDefaultAudioEndpoint(eRender, eCommunications) failed hr=" + Hex(hr), hr);
            string devId = "?";
            dev.GetId(out devId);
            // Ducking happens on the endpoint that carries the communication stream, so
            // a distinct communications default device means the sound (and the ducking)
            // land there instead of on the device the user is listening to.
            string mediaId = "";
            try
            {
                IMMDevice media;
                if (devEnum.GetDefaultAudioEndpoint(eRender, 1, out media) == 0 && media != null)
                {
                    media.GetId(out mediaId);
                    Marshal.ReleaseComObject(media);
                }
            }
            catch { }
            string sameDevice = mediaId.Length == 0 ? "?" : (mediaId == devId ? "1" : "0");

            Guid iid = typeof(IAudioClient).GUID;
            hr = dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out clientObj);
            if (hr != 0) throw new COMException("Activate(IAudioClient) failed hr=" + Hex(hr), hr);
            client = (IAudioClient)clientObj;

            var fmt = new WAVEFORMATEX();
            fmt.wFormatTag = 1;
            fmt.nChannels = (ushort)channels;
            fmt.nSamplesPerSec = (uint)rate;
            fmt.nAvgBytesPerSec = (uint)(rate * blockAlign);
            fmt.nBlockAlign = (ushort)blockAlign;
            fmt.wBitsPerSample = (ushort)bits;
            fmt.cbSize = 0;
            Guid sessionGuid = Guid.Empty;
            hr = client.Initialize(AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                BUFFER_DURATION, 0, ref fmt, ref sessionGuid);
            if (hr != 0) throw new COMException("IAudioClient.Initialize failed hr=" + Hex(hr), hr);

            uint bufferFrames;
            hr = client.GetBufferSize(out bufferFrames);
            if (hr != 0 || bufferFrames == 0) throw new COMException("GetBufferSize failed hr=" + Hex(hr), hr);

            Guid rid = typeof(IAudioRenderClient).GUID;
            hr = client.GetService(ref rid, out renderObj);
            if (hr != 0) throw new COMException("GetService(IAudioRenderClient) failed hr=" + Hex(hr), hr);
            render = (IAudioRenderClient)renderObj;

            hr = client.Start();
            if (hr != 0) throw new COMException("IAudioClient.Start failed hr=" + Hex(hr), hr);
            started2 = true;

            int written = 0;
            int startAck = (int)(DateTime.UtcNow - started).TotalMilliseconds;
            // The stream is live now: tell the Host before spending time on frames.
            WriteAck(ackPath, seq, true,
                "role=eCommunications endpoint=" + devId +
                " format=" + rate + "Hz/" + channels + "ch/" + bits + "bit" +
                " frames=" + totalFrames + " volume=" + v.ToString("0.00", CultureInfo.InvariantCulture) +
                " startMs=" + startAck + " mediaDevice=" + mediaId + " sameDevice=" + sameDevice + " sync=" + sync);

            while (written < totalFrames)
            {
                if (_stop) break;
                uint padding;
                if (client.GetCurrentPadding(out padding) != 0) break;
                uint avail = bufferFrames > padding ? bufferFrames - padding : 0;
                if (avail == 0)
                {
                    Thread.Sleep(4);
                }
                else
                {
                    int n = (int)Math.Min((long)avail, (long)(totalFrames - written));
                    IntPtr ptr;
                    hr = render.GetBuffer((uint)n, out ptr);
                    if (hr != 0) break;
                    int bytes = n * blockAlign;
                    var chunk = new byte[bytes];
                    Buffer.BlockCopy(samples, written * channels * 2, chunk, 0, bytes);
                    Marshal.Copy(chunk, 0, ptr, bytes);
                    render.ReleaseBuffer((uint)n, 0);
                    written += n;
                }
                if ((DateTime.UtcNow - started).TotalMilliseconds > maxMs + 500) break;
            }

            // Drain the engine buffer so the very end is audible; still bounded.
            while ((DateTime.UtcNow - started).TotalMilliseconds < maxMs + 1000)
            {
                if (_stop) break;
                uint padding;
                if (client.GetCurrentPadding(out padding) != 0) break;
                if (padding == 0) break;
                Thread.Sleep(10);
            }
            Thread.Sleep(20);
            client.Stop();
            started2 = false;

            int played = (int)(DateTime.UtcNow - started).TotalMilliseconds;
            return "role=eCommunications endpoint=" + devId +
                   " format=" + rate + "Hz/" + channels + "ch/" + bits + "bit" +
                   " frames=" + totalFrames + "/" + written +
                   " durMs=" + (int)((long)totalFrames * 1000L / rate) +
                   " playedMs=" + played +
                   " volume=" + v.ToString("0.00", CultureInfo.InvariantCulture) +
                   " mediaDevice=" + mediaId + " sameDevice=" + sameDevice + " sync=" + sync;
        }
        finally
        {
            if (started2) { try { client.Stop(); } catch { } }
            if (render != null) { try { Marshal.ReleaseComObject(render); } catch { } }
            if (clientObj != null) { try { Marshal.ReleaseComObject(clientObj); } catch { } }
            if (dev != null) { try { Marshal.ReleaseComObject(dev); } catch { } }
        }
    }
}
'@

$hash = [BitConverter]::ToString(
  [System.Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($csharp))
).Replace('-', '').Substring(0, 16)
$dll = Join-Path $dir "DshAudioComm-$hash.dll"
if (-not (Test-Path -LiteralPath $dll)) {
  Add-Type -TypeDefinition $csharp -OutputAssembly $dll -PassThru | Out-Null
} else {
  Add-Type -Path $dll
}

function Invoke-Play([string]$file, [double]$vol, [int]$seq) {
  if (-not $file -or -not (Test-Path -LiteralPath $file)) {
    throw "wav file missing: $file"
  }
  if ($vol -lt 0) { $vol = 0 }
  if ($vol -gt 1) { $vol = 1 }
  if ($MaxMs -le 0) { $MaxMs = 4000 }
  if ($MaxMs -gt 5000) { $MaxMs = 5000 }
  # -SyncComm -1 (default): a long-lived Serve helper follows the playback device;
  # a one-shot Play leaves the user's device settings alone unless asked.
  $sync = if ($SyncComm -lt 0) { $Action -eq 'Serve' } else { $SyncComm -eq 1 }
  return [DshAudioComm]::Play($file, $vol, $MaxMs, $AckFile, $seq, $sync)
}

# Same preparation as Invoke-Play, but starts the sound on a worker thread so the
# Serve loop can keep reading commands and cut it short for the next preview.
function Start-Play([string]$file, [double]$vol, [int]$seq) {
  if (-not $file -or -not (Test-Path -LiteralPath $file)) {
    throw "wav file missing: $file"
  }
  if ($vol -lt 0) { $vol = 0 }
  if ($vol -gt 1) { $vol = 1 }
  if ($MaxMs -le 0) { $MaxMs = 4000 }
  if ($MaxMs -gt 5000) { $MaxMs = 5000 }
  $sync = if ($SyncComm -lt 0) { $Action -eq 'Serve' } else { $SyncComm -eq 1 }
  return [DshAudioComm]::Start($file, $vol, $MaxMs, $AckFile, $seq, $sync)
}

# A play failure must always be reported to the Host, otherwise the page waits for
# an ack that never comes and would stay silent.
function Fail-Ack([int]$seq, [string]$message) {
  try { [DshAudioComm]::WriteAck($AckFile, $seq, $false, $message) } catch {}
}

try {
  switch ($Action) {
    'Play' {
      $seq = 0
      try {
        $report = Invoke-Play $WavFile $Volume $seq
        Write-Log $report
        $report
      } catch {
        $msg = $_.Exception.Message
        Fail-Ack $seq $msg
        Write-Log ("play failed: " + $msg)
        [Console]::Error.WriteLine($msg)
        exit 3
      }
    }
    'Serve' {
      # One helper only: CreateNew is atomic, so two Host reloads cannot both own it.
      $lock = Join-Path $dir 'helper.pid'
      $acquired = $false
      for ($attempt = 0; $attempt -lt 2 -and -not $acquired; $attempt++) {
        try {
          $fs = [System.IO.File]::Open($lock, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
          $bytes = [Text.Encoding]::UTF8.GetBytes("$PID")
          $fs.Write($bytes, 0, $bytes.Length)
          $fs.Dispose()
          $acquired = $true
        } catch {
          $old = ''
          try { $old = (Get-Content -LiteralPath $lock -Raw -ErrorAction Stop) -replace '\s', '' } catch {}
          if ($old -match '^\d+$' -and $old -ne "$PID") {
            $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$old" -ErrorAction SilentlyContinue).CommandLine
            if ($cl -and $cl -match 'play-comm\.ps1') { Write-Log "another helper ($old) is alive, exiting"; exit 0 }
          }
          try { Remove-Item -LiteralPath $lock -Force -ErrorAction Stop } catch {}
        }
      }
      if (-not $acquired) { Write-Log 'helper lock not acquired, exiting'; exit 0 }
      Write-Log "helper $PID started (parent=$ParentPid boot=$BootId)"

      $lastSeq = -1
      $lastWrite = [datetime]::MinValue
      $lastCommand = Get-Date
      $ticks = 0
      $running = $true
      $playThread = $null
      try {
        while ($running) {
          $cmd = $null
          try {
            if (Test-Path -LiteralPath $CmdFile) {
              $mtime = (Get-Item -LiteralPath $CmdFile).LastWriteTimeUtc
              if ($mtime -ne $lastWrite) {
                $lastWrite = $mtime
                $cmd = Get-Content -LiteralPath $CmdFile -Raw | ConvertFrom-Json
              }
            }
          } catch { $cmd = $null }

          if ($null -ne $cmd -and [int]$cmd.seq -gt $lastSeq -and ($BootId -eq '' -or [string]$cmd.bootId -eq $BootId)) {
            $lastSeq = [int]$cmd.seq
            $lastCommand = Get-Date
            switch ([string]$cmd.op) {
              'play' {
                $seq = [int]$cmd.seq
                $vol = 1.0
                try { $vol = [double]$cmd.volume } catch {}
                if ($vol -gt 1) { $vol = $vol / 100.0 }
                try {
                  # New sounds replace the one that is ringing: stop it, let the thread
                  # close its stream (so ducking is released), then start the new one.
                  [DshAudioComm]::Stop()
                  if ($playThread -and $playThread.IsAlive) { [void]$playThread.Join(600) }
                  $playThread = Start-Play ([string]$cmd.wav) $vol $seq
                  Write-Log ("play seq=" + $seq + " volume=" + $vol.ToString('0.00'))
                } catch {
                  $msg = $_.Exception.Message
                  Fail-Ack $seq $msg
                  Write-Log ("play failed: " + $msg)
                }
              }
              'drop' {
                [DshAudioComm]::Stop()
                if ($playThread -and $playThread.IsAlive) { [void]$playThread.Join(300) }
                Write-Log 'drop requested'
              }
              'exit' { [DshAudioComm]::Stop(); Write-Log 'exit requested'; $running = $false }
            }
          }

          if (((Get-Date) - $lastCommand).TotalMinutes -ge 10) { Write-Log 'idle 10 min, exiting'; $running = $false }
          $ticks++
          if ($ParentPid -gt 0 -and ($ticks % 25) -eq 0) {
            if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { Write-Log 'parent gone, exiting'; break }
          }
          Start-Sleep -Milliseconds 40
        }
      } finally {
        try { Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue } catch {}
      }
    }
  }
} catch {
  Write-Log ("FATAL: " + $_.Exception.Message)
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 3
}
