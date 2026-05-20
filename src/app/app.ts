import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  OnDestroy,
  ViewChild,
  signal,
  computed,
  effect
} from '@angular/core';
import { CommonModule, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';

// Simple interface for signal analysis logs
interface LogEntry {
  timestamp: number;
  timeFormatted: string;
  type: 'info' | 'match' | 'warn' | 'error';
  message: string;
}

// Interface for Audio Signal Profiles (custom & preset)
interface AudioProfile {
  id: string;
  name: string;
  targetFreq: number; // Hz
  tolerance: number;  // ± Hz
  requiredDuration: number; // ms
  isPreset?: boolean;
}

interface VUSegment {
  dbLimit: number;
  color: string;
}

interface RecordedFile {
  id: string;
  url: string;
  name: string;
  date: string;
  duration: number;
  sizeStr: string;
  source: string;
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-root',
  imports: [CommonModule, FormsModule, MatIconModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
  providers: [DecimalPipe]
})
export class App implements OnInit, OnDestroy {
  @ViewChild('canvasElement', { static: false }) canvasElement!: ElementRef<HTMLCanvasElement>;

  // Preset Profiles
  private readonly DEFAULT_PROFILES: AudioProfile[] = [
    { id: 'pres-hum-50', name: 'Mains Hum 50Hz', targetFreq: 50, tolerance: 5, requiredDuration: 400, isPreset: true },
    { id: 'pres-hum-60', name: 'Mains Hum 60Hz', targetFreq: 60, tolerance: 5, requiredDuration: 400, isPreset: true },
    { id: 'pres-call-440', name: 'Standard Call A440', targetFreq: 440, tolerance: 15, requiredDuration: 300, isPreset: true },
    { id: 'pres-beacon-1200', name: 'Radar Beacon 1200Hz', targetFreq: 1200, tolerance: 30, requiredDuration: 400, isPreset: true },
    { id: 'pres-siren-1800', name: 'Siren Emergency 1.8k', targetFreq: 1800, tolerance: 45, requiredDuration: 350, isPreset: true },
  ];

  // VU Levels configuration segments
  readonly vuSegments: VUSegment[] = [
    { dbLimit: -60, color: 'bg-green-500' },
    { dbLimit: -50, color: 'bg-green-500' },
    { dbLimit: -40, color: 'bg-green-500' },
    { dbLimit: -30, color: 'bg-green-500' },
    { dbLimit: -24, color: 'bg-yellow-500' },
    { dbLimit: -18, color: 'bg-yellow-500' },
    { dbLimit: -12, color: 'bg-orange-500 animate-pulse' },
    { dbLimit: -6, color: 'bg-red-500 animate-pulse' },
  ];

  // Active inputs & states
  readonly activeFeed = signal<'none' | 'mic' | 'osc' | 'pid-8422' | 'pid-9901' | 'pid-4401'>('none');
  readonly isListening = signal<boolean>(false);
  readonly isSynthesizing = signal<boolean>(false);
  readonly scopeType = signal<'fft' | 'wave'>('fft');

  // Filter configuration states
  readonly filterEnabled = signal<boolean>(false);
  readonly filterType = signal<'lowpass' | 'highpass' | 'bandpass'>('lowpass');
  readonly filterCutoff = signal<number>(1000);
  readonly filterQ = signal<number>(1.5);

  // Audio Profiles management signals
  readonly profiles = signal<AudioProfile[]>([]);
  readonly selectedProfileId = signal<string>('pres-call-440');
  readonly currentActiveProfile = computed(() => 
    this.profiles().find(p => p.id === this.selectedProfileId()) || null
  );

  // Sound and alarm signals
  readonly muteSynth = signal<boolean>(true);
  readonly soundActivatedAlert = signal<boolean>(true);

  // Real-time audio characteristics signals
  readonly currentPeakFreq = signal<number>(0);
  readonly currentVolumeDb = signal<number>(-96);
  readonly vectorMatch = signal<number>(0);
  readonly isMatched = signal<boolean>(false);
  readonly lastMatchFreq = signal<number>(0);
  readonly lastMatchDb = signal<number>(0);
  readonly signalClassification = signal<string>('SILENCE / IDLE');

  // Visualizer customization signals
  readonly visualizerSensitivity = signal<number>(1.2);
  readonly visualizerDecay = signal<number>(0.65);
  readonly visualizerColorScheme = signal<'classic' | 'amber' | 'neon' | 'cyan'>('classic');

  // Multi-source routing matrix states
  readonly activeSources = signal<Record<string, boolean>>({
    'pid-8422': false,
    'pid-9901': false,
    'pid-4401': false,
    'osc': false,
    'mic': false,
  });

  readonly sourceChainMap = signal<Record<string, 'direct' | 'filter' | 'echo' | 'distortion'>>({
    'pid-8422': 'direct',
    'pid-9901': 'echo',
    'pid-4401': 'filter',
    'osc': 'distortion',
    'mic': 'direct',
  });

  readonly chainDestinationMap = signal<Record<string, Record<'speaker' | 'decoder' | 'recorder' | 'scope', boolean>>>({
    'direct': { speaker: true, decoder: true, recorder: true, scope: true },
    'filter': { speaker: true, decoder: false, recorder: true, scope: true },
    'echo': { speaker: true, decoder: false, recorder: true, scope: true },
    'distortion': { speaker: true, decoder: false, recorder: true, scope: true },
  });

  readonly delayTime = signal<number>(0.35); // seconds
  readonly delayFeedback = signal<number>(0.45); // feedback ratio (0 to 0.95)
  readonly distortionAmount = signal<number>(50); // distortion drive

  // Tab state inside center workstation panel
  readonly centerPanelTab = signal<'payload' | 'routing'>('routing');

  // Drag-and-drop visual patching states (W-09)
  readonly activeDragType = signal<'source' | 'chain' | null>(null);
  readonly activeDragId = signal<string | null>(null);
  readonly currentDragOverZone = signal<string | null>(null);

  readonly activeColorClass = computed(() => {
    const s = this.visualizerColorScheme();
    if (s === 'amber') return 'text-[#FFB000]';
    if (s === 'neon') return 'text-[#FF007F]';
    if (s === 'cyan') return 'text-[#00F0FF]';
    return 'text-[#00FF41]';
  });

  readonly activeBgClass = computed(() => {
    const s = this.visualizerColorScheme();
    if (s === 'amber') return 'bg-[#FFB000]';
    if (s === 'neon') return 'bg-[#FF007F]';
    if (s === 'cyan') return 'bg-[#00F0FF]';
    return 'bg-[#00FF41]';
  });

  readonly activeBorderClass = computed(() => {
    const s = this.visualizerColorScheme();
    if (s === 'amber') return 'border-[#FFB000]';
    if (s === 'neon') return 'border-[#FF007F]';
    if (s === 'cyan') return 'border-[#00F0FF]';
    return 'border-[#00FF41]';
  });

  readonly activeAccentClass = computed(() => {
    const s = this.visualizerColorScheme();
    if (s === 'amber') return 'accent-[#FFB000]';
    if (s === 'neon') return 'accent-[#FF007F]';
    if (s === 'cyan') return 'accent-[#00F0FF]';
    return 'accent-[#00FF41]';
  });

  // Dynamic system telemetry
  readonly cpuString = signal<string>('12.4');
  readonly ramString = signal<string>('442');
  readonly uptimeSeconds = signal<number>(0);
  readonly testBuffer = signal<number>(1024);

  // Recording & Live Capture properties
  readonly isRecording = signal<boolean>(false);
  readonly recordingDuration = signal<number>(0);
  readonly recordingSource = signal<'inside' | 'outside' | 'hybrid'>('hybrid');
  readonly recordedFiles = signal<RecordedFile[]>([]);
  readonly currentlyPlayingId = signal<string | null>(null);
  readonly liveFps = signal<number>(0.0);
  readonly liveBitrateVariance = signal<number>(0.0);
  readonly recordingSpeedMultiplier = signal<number>(1);
  readonly decryptedPayload = signal<string>('GATEWAY SYSTEM STATUS // IDLE READY. WAITING FOR ENCRYPTED CARRIER.');

  readonly activeSourceIP = computed(() => {
    return this.activeFeedDetails().ip;
  });

  formatDurationDesc(durationSecs: number): string {
    if (durationSecs < 60) {
      return `${durationSecs}s (${(durationSecs / 60).toFixed(2)}m)`;
    }
    const mins = Math.floor(durationSecs / 60);
    const secs = durationSecs % 60;
    return `${mins}m ${secs}s (${(durationSecs / 60).toFixed(1)}m)`;
  }

  readonly recordingDurationString = computed(() => {
    const total = this.recordingDuration();
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    const decimalMins = (total / 60).toFixed(1);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')} (${decimalMins}m)`;
  });

  readonly activeFeedDetails = computed(() => {
    const feed = this.activeFeed();
    const defaults = {
      name: 'SYSTEM RECEIVER STANDBY',
      type: 'N/A',
      ip: 'DISCONNECTED',
      audioCodec: 'N/A',
      videoCodec: 'N/A',
      sampleRate: '0 Hz',
      resolution: 'N/A',
      fps: '0.00',
      bitrate: '0.0 kbps',
      networkState: 'STANDBY',
      security: 'SSL NONE'
    };

    if (feed === 'pid-8422') {
      const fpsWiggle = this.liveFps();
      const brWiggle = (144.0 + this.liveBitrateVariance()).toFixed(1);
      return {
        name: 'CHROME BROWSER WINDOW',
        type: 'Hidden Video Ad Beacon Process',
        ip: '142.250.190.46:443 (Google Edge Node)',
        audioCodec: 'OPUS Stereo (48kHz)',
        videoCodec: 'H.264 AVC1 Main',
        sampleRate: '48,000 Hz',
        resolution: '1920 x 1080 (HD)',
        fps: fpsWiggle > 0 ? fpsWiggle.toFixed(2) : '60.00',
        bitrate: `${brWiggle} kbps VBR`,
        networkState: 'STABLE STREAMING',
        security: 'TLS v1.3 AES_256_GCM'
      };
    }
    if (feed === 'pid-9901') {
      const fpsWiggle = this.liveFps();
      const brWiggle = (96.0 + this.liveBitrateVariance()).toFixed(1);
      return {
        name: 'MICROSOFT EDGE ENGINE',
        type: 'Silent Tab Audio / Media Stream',
        ip: '204.79.197.200:443 (MSN Services)',
        audioCodec: 'AAC-LC Mono (44.1kHz)',
        videoCodec: 'VP9 WebM Live',
        sampleRate: '44,100 Hz',
        resolution: '1280 x 720 (SD)',
        fps: fpsWiggle > 0 ? fpsWiggle.toFixed(2) : '30.00',
        bitrate: `${brWiggle} kbps CBR`,
        networkState: 'RECEIVING / SWEPT',
        security: 'TLS v1.3 Chacha20-Poly1305'
      };
    }
    if (feed === 'pid-4401') {
      const fpsWiggle = this.liveFps();
      const brWiggle = (384.0 + this.liveBitrateVariance()).toFixed(1);
      return {
        name: 'SECURE ALARM DAEMON',
        type: 'WebRTC Siren Gateway',
        ip: '127.0.0.1:8080 (Localhost Server)',
        audioCodec: 'Uncompressed LPCM 16-bit',
        videoCodec: 'AV1 Matrix Feed',
        sampleRate: '48,000 Hz',
        resolution: '2560 x 1440 (2K)',
        fps: fpsWiggle > 0 ? fpsWiggle.toFixed(2) : '59.94',
        bitrate: `${brWiggle} kbps RAW`,
        networkState: 'BURST SECURE TRANSMIT',
        security: 'DTLS v1.2 SRTP ENC'
      };
    }
    if (feed === 'osc') {
      const fpsWiggle = this.liveFps();
      const brWiggle = (1536.0 + this.liveBitrateVariance()).toFixed(1);
      return {
        name: 'CUSTOM SIGNAL OSCILLATOR',
        type: 'Direct Waveform Synthesis Model',
        ip: '127.0.0.1:3000 (Local Dev Node)',
        audioCodec: 'LPCM Float32 Uncompressed',
        videoCodec: 'SVG Plotter Vector Grid',
        sampleRate: '48,000 Hz',
        resolution: '1024 x 1024 (Vector Matrix)',
        fps: fpsWiggle > 0 ? fpsWiggle.toFixed(2) : '120.00',
        bitrate: `${brWiggle} kbps Linear`,
        networkState: 'SYNTHESIS LOOPBACK',
        security: 'INTERNAL BYPASS SECURITY'
      };
    }
    if (feed === 'mic') {
      const brWiggle = (768.0 + this.liveBitrateVariance()).toFixed(1);
      return {
        name: 'HARDWARE CONSOLE STREAM',
        type: 'Physical Acoustic Input Port',
        ip: '192.168.1.144:49410 (Client NIC Adapter)',
        audioCodec: 'Device Native RAW PCM',
        videoCodec: 'Live Camera Capture (STANDBY)',
        sampleRate: `${this.audioCtx?.sampleRate || 48000} Hz`,
        resolution: 'N/A (Acoustic Feed Only)',
        fps: '0.00',
        bitrate: `${brWiggle} kbps Direct`,
        networkState: 'AOT TRANSMITTING',
        security: 'HARDWARE GATE PIN'
      };
    }

    return defaults;
  });

  readonly uptimeString = computed(() => {
    const total = this.uptimeSeconds();
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  });

  // Profile creator form parameters
  readonly showProfileCreator = signal<boolean>(false);
  readonly creatorName = signal<string>('');
  readonly creatorFreq = signal<number>(440);
  readonly creatorTolerance = signal<number>(10);
  readonly creatorDuration = signal<number>(300);

  // Logs stream
  readonly logs = signal<LogEntry[]>([]);

  // Web Audio Variables (Managed safely)
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private micStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;

  // Custom multi-source nodes state lists
  private activeOscillators: { id: string; node: OscillatorNode; interval?: ReturnType<typeof setInterval> | number }[] = [];
  private activeBuses: AudioNode[] = [];
  private echoDelayNode: DelayNode | null = null;
  private echoFeedbackGain: GainNode | null = null;
  private distortionNode: WaveShaperNode | null = null;
  
  // Simulated oscillator/modulators
  private synthOsc: OscillatorNode | null = null;
  private synthGain: GainNode | null = null;
  private biquadFilter: BiquadFilterNode | null = null;
  private lfoOsc: OscillatorNode | null = null; // for pulse/drift sweeps
  private driftInterval: ReturnType<typeof setInterval> | null = null;

  // Real-time matching loop variables
  private animationFrameId: number | null = null;
  private matchLockStart: number | null = null;
  private lastAlertTriggerTime = 0;
  private lastSignalUpdateTime = 0;
  private statsInterval: ReturnType<typeof setInterval> | null = null;

  // Recorder state engine properties
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private recordInterval: ReturnType<typeof setInterval> | null = null;
  private recordDestination: MediaStreamAudioDestinationNode | null = null;
  private playbackAudio: HTMLAudioElement | null = null;

  // Manual Injector frequency parameter
  readonly manualSynthFreq = signal<number>(440);

  constructor() {
    // Unified reactive effect that automatically maps any routing matrix, source, effect, or volume choices to our live Web Audio graph!
    effect(() => {
      // Read the signals to register reactive tracking list under Angular:
      this.activeSources();
      this.sourceChainMap();
      this.chainDestinationMap();
      this.filterEnabled();
      this.filterType();
      this.filterCutoff();
      this.filterQ();
      this.delayTime();
      this.delayFeedback();
      this.distortionAmount();
      this.muteSynth();
      this.manualSynthFreq();

      // Invoke dynamic pipeline assembly
      this.rebuildAudioGraph();
    });

    // Dynamic smoothing time constant parameter adjustment
    effect(() => {
      const decay = this.visualizerDecay();
      if (this.analyser) {
        this.analyser.smoothingTimeConstant = decay;
      }
    });
  }

  ngOnInit() {
    this.appendLog('info', 'System Analytics Engine Initializing...');
    this.loadAllProfiles();
    this.startSystemTelemetry();
    this.appendLog('info', 'Hardware Hook Ready. Hook global browser audio feeds.');
  }

  ngOnDestroy() {
    this.stopAudioSource();
    if (this.driftInterval) clearInterval(this.driftInterval);
    if (this.statsInterval) clearInterval(this.statsInterval);
    if (this.recordInterval) clearInterval(this.recordInterval);
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
  }

  // Initializing or retrieving the local storage profiles combined with presets
  private loadAllProfiles() {
    try {
      const stored = localStorage.getItem('signal_scan_profiles');
      let custom: AudioProfile[] = [];
      if (stored) {
        custom = JSON.parse(stored);
      }
      this.profiles.set([...this.DEFAULT_PROFILES, ...custom]);
    } catch {
      this.profiles.set(this.DEFAULT_PROFILES);
      this.appendLog('error', 'Failed loading custom profiles from local storage database.');
    }
  }

  isPresetProfile(id: string): boolean {
    return id.startsWith('pres-');
  }

  // Real-time fluctuating hardware statistics for retro cyber telemetry feel
  private startSystemTelemetry() {
    this.statsInterval = setInterval(() => {
      // Fluctuate stats
      const cpuVal = (10.5 + Math.random() * 4.5).toFixed(1);
      const ramVal = Math.floor(438 + Math.random() * 8).toString();
      this.cpuString.set(cpuVal);
      this.ramString.set(ramVal);
      this.uptimeSeconds.update(u => u + 1);

      // Fluctuate live streaming telemetry
      const feed = this.activeFeed();
      if (feed !== 'none') {
        const baseFps = feed === 'pid-8422' || feed === 'osc' ? 60.0 : (feed === 'pid-9901' ? 30.0 : (feed === 'pid-4401' ? 59.94 : 0.0));
        if (baseFps > 0) {
          this.liveFps.set(parseFloat((baseFps - (Math.random() > 0.82 ? Math.random() * 0.35 : 0)).toFixed(2)));
        } else {
          this.liveFps.set(0.0);
        }
        this.liveBitrateVariance.set(parseFloat((Math.random() * 14 - 7).toFixed(1)));

        // Live decrypted payload stream simulator
        const hexGroup = Array.from({ length: 6 }, () => 
          Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase()
        ).join(' ');
        
        this.decryptedPayload.update(p => {
          const currentLines = p.includes('IDLE READY') ? [] : p.split('\n');
          if (currentLines.length > 5) {
            currentLines.shift();
          }
          currentLines.push(`[${new Date().toLocaleTimeString()}] PORT_3000 // PKT_DEC // ${hexGroup} // CRC_OK`);
          return currentLines.join('\n');
        });

      } else {
        this.liveFps.set(0.0);
        this.liveBitrateVariance.set(0.0);
        this.decryptedPayload.set('GATEWAY SYSTEM STATUS // IDLE READY. WAITING FOR ENCRYPTED CARRIER.');
      }
    }, 1000);
  }

  // Complete clean audio pipeline stop action
  stopAudioSource() {
    if (this.isRecording()) {
      this.stopRecording();
    }

    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    if (this.driftInterval) {
      clearInterval(this.driftInterval);
      this.driftInterval = null;
    }

    // Toggle off all sources
    this.activeSources.set({
      'pid-8422': false,
      'pid-9901': false,
      'pid-4401': false,
      'osc': false,
      'mic': false,
    });

    this.teardownActiveGraph(true);

    this.activeFeed.set('none');
    this.vectorMatch.set(0);
    this.isMatched.set(false);
    this.currentPeakFreq.set(0);
    this.currentVolumeDb.set(-96);
    this.appendLog('warn', 'Receiver and audio matrix disconnected.');
  }

  // Lazy initialise the Context
  private initAudioContext(): boolean {
    if (!this.audioCtx) {
      try {
        const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.audioCtx = new AudioContextClass();
        this.appendLog('info', 'Active Web Audio pipeline channel established.');
      } catch {
        this.appendLog('error', 'Browser blocks audio graph creation.');
        return false;
      }
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    return true;
  }

  // Toggle active source
  toggleSource(srcId: string) {
    this.activeSources.update(srcs => {
      const updated = { ...srcs };
      updated[srcId] = !updated[srcId];
      
      const statusLabel = updated[srcId] ? 'ONLINE' : 'OFFLINE';
      this.appendLog('info', `Routing grid source toggle: '${srcId}' is now ${statusLabel}`);
      return updated;
    });
  }

  // Real-time dynamic Web Audio Graph creator and patch-bay routing assembler
  rebuildAudioGraph() {
    const sources = this.activeSources();
    const hasAnyActive = Object.values(sources).some(v => v);

    if (!hasAnyActive) {
      this.teardownActiveGraph(true);
      return;
    }

    const ok = this.initAudioContext();
    if (!ok) return;

    const ctx = this.audioCtx!;

    // Teardown previous active connections safely but keep the mic stream object alive
    this.teardownActiveGraph(false);

    try {
      // 1. Create intermediate mixing buses for processing chains
      const directGain = ctx.createGain();
      const filterGain = ctx.createGain();
      const echoGain = ctx.createGain();
      const distortionGain = ctx.createGain();

      this.activeBuses.push(directGain, filterGain, echoGain, distortionGain);

      // 2. Configure Effect Nodes in each respective chain
      // A. Biquad Dynamic Filter
      this.biquadFilter = ctx.createBiquadFilter();
      this.biquadFilter.type = this.filterType();
      this.biquadFilter.frequency.setValueAtTime(this.filterCutoff(), ctx.currentTime);
      this.biquadFilter.Q.setValueAtTime(this.filterQ(), ctx.currentTime);
      filterGain.connect(this.biquadFilter);

      // B. Delay / Feedback Echo Loop
      this.echoDelayNode = ctx.createDelay(2.0);
      this.echoDelayNode.delayTime.setValueAtTime(this.delayTime(), ctx.currentTime);

      this.echoFeedbackGain = ctx.createGain();
      this.echoFeedbackGain.gain.setValueAtTime(this.delayFeedback(), ctx.currentTime);

      echoGain.connect(this.echoDelayNode);
      this.echoDelayNode.connect(this.echoFeedbackGain);
      this.echoFeedbackGain.connect(this.echoDelayNode); // feedback loop

      // C. WaveShaper Saturation / Distortion
      this.distortionNode = ctx.createWaveShaper();
      this.distortionNode.curve = this.makeDistortionCurve(this.distortionAmount());
      distortionGain.connect(this.distortionNode);

      // 3. Create destination mixing buses
      // Master Speaker Monitor Bus
      const speakerMix = ctx.createGain();
      const mVol = this.muteSynth() ? 0 : 0.08;
      speakerMix.gain.setValueAtTime(mVol, ctx.currentTime);
      speakerMix.connect(ctx.destination);
      this.synthGain = speakerMix; // bound for legacy compatibility

      // Spectrum Scanner Analyser Bus
      if (!this.analyser) {
        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = 2048;
        this.analyser.smoothingTimeConstant = this.visualizerDecay();
      }
      const scopeMix = ctx.createGain();
      scopeMix.connect(this.analyser);

      // WAV Recorder MediaStream Destination Bus
      if (!this.recordDestination) {
        this.recordDestination = ctx.createMediaStreamDestination();
      }
      const recorderMix = ctx.createGain();
      recorderMix.connect(this.recordDestination);

      // Decoder stream Bus
      const decoderMix = ctx.createGain();

      this.activeBuses.push(speakerMix, scopeMix, recorderMix, decoderMix);

      // 4. Hook Processing chains to mixed destinations based on Routing Matrix choices
      const destMap = this.chainDestinationMap();

      const connectChainToDest = (chainId: 'direct' | 'filter' | 'echo' | 'distortion', oNode: AudioNode) => {
        const mapping = destMap[chainId];
        if (mapping.speaker) oNode.connect(speakerMix);
        if (mapping.scope) oNode.connect(scopeMix);
        if (mapping.recorder) oNode.connect(recorderMix);
        if (mapping.decoder) oNode.connect(decoderMix);
      };

      // Connect Direct
      connectChainToDest('direct', directGain);

      // Connect Filter
      connectChainToDest('filter', this.biquadFilter);

      // Connect Echo (wet only) and mix in dry parallel signal to keep spectrum clean
      connectChainToDest('echo', this.echoDelayNode);
      const dryEchoMix = ctx.createGain();
      dryEchoMix.gain.setValueAtTime(0.4, ctx.currentTime);
      echoGain.connect(dryEchoMix);
      if (destMap['echo'].speaker) dryEchoMix.connect(speakerMix);
      if (destMap['echo'].scope) dryEchoMix.connect(scopeMix);
      if (destMap['echo'].recorder) dryEchoMix.connect(recorderMix);
      if (destMap['echo'].decoder) dryEchoMix.connect(decoderMix);

      // Connect Distortion (wet only) and mix in dry parallel signal
      connectChainToDest('distortion', this.distortionNode);
      const dryDistMix = ctx.createGain();
      dryDistMix.gain.setValueAtTime(0.4, ctx.currentTime);
      distortionGain.connect(dryDistMix);
      if (destMap['distortion'].speaker) dryDistMix.connect(speakerMix);
      if (destMap['distortion'].scope) dryDistMix.connect(scopeMix);
      if (destMap['distortion'].recorder) dryDistMix.connect(recorderMix);
      if (destMap['distortion'].decoder) dryDistMix.connect(decoderMix);

      // 5. Initialize active sources and route them to their assigned chains
      const chainMap = this.sourceChainMap();
      const targetChains = {
        'direct': directGain,
        'filter': filterGain,
        'echo': echoGain,
        'distortion': distortionGain
      };

      // Source A: Chrome Hum (pid-8422)
      if (sources['pid-8422']) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440, ctx.currentTime);
        
        const chainNode = targetChains[chainMap['pid-8422']];
        osc.connect(chainNode);
        osc.start();
        this.activeOscillators.push({ id: 'pid-8422', node: osc });
      }

      // Source B: MS Edge WebRTC Pulses (pid-9901)
      if (sources['pid-9901']) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1200, ctx.currentTime);

        const driftInterval = setInterval(() => {
          if (osc && this.audioCtx) {
            const modFreq = 1200 + Math.sin(this.audioCtx.currentTime * 4) * 15;
            osc.frequency.setValueAtTime(modFreq, this.audioCtx.currentTime);
          }
        }, 50);

        const chainNode = targetChains[chainMap['pid-9901']];
        osc.connect(chainNode);
        osc.start();
        this.activeOscillators.push({ id: 'pid-9901', node: osc, interval: driftInterval });
      }

      // Source C: System Alarm Beacon (pid-4401)
      if (sources['pid-4401']) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1800, ctx.currentTime);

        const alarmGain = ctx.createGain();
        let pulsedOn = false;
        const pulseInterval = setInterval(() => {
          if (alarmGain && this.audioCtx) {
            pulsedOn = !pulsedOn;
            alarmGain.gain.setValueAtTime(pulsedOn ? 1.0 : 0.0, this.audioCtx.currentTime);
          }
        }, 800);

        osc.connect(alarmGain);
        const chainNode = targetChains[chainMap['pid-4401']];
        alarmGain.connect(chainNode);
        osc.start();
        this.activeOscillators.push({ id: 'pid-4401', node: osc, interval: pulseInterval });
      }

      // Source D: Custom Waves Tuner Oscillator (osc)
      if (sources['osc']) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(this.manualSynthFreq(), ctx.currentTime);

        const chainNode = targetChains[chainMap['osc']];
        osc.connect(chainNode);
        osc.start();
        this.activeOscillators.push({ id: 'osc', node: osc });
      }

      // Source E: Hardware Microphone Input (mic)
      if (sources['mic']) {
        if (!this.micStream) {
          this.appendLog('info', 'Requesting microphone hardware authorization...');
          navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
          }).then(stream => {
            this.micStream = stream;
            this.rebuildAudioGraph();
          }).catch(() => {
            this.activeSources.update(s => ({ ...s, 'mic': false }));
            this.appendLog('error', 'Microphone capture blocked or device offline.');
          });
        } else {
          try {
            this.sourceNode = ctx.createMediaStreamSource(this.micStream);
            const chainNode = targetChains[chainMap['mic']];
            this.sourceNode.connect(chainNode);
          } catch {
            this.appendLog('error', 'Coupling user microphone source failed.');
          }
        }
      } else {
        // Stop microphone stream tracks if micrometers untoggled
        if (this.micStream) {
          this.micStream.getTracks().forEach(track => track.stop());
          this.micStream = null;
        }
      }

      // Add low level background line-noise for high fidelity oscilloscope display look
      const bufferSize = ctx.sampleRate * 2;
      const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      const whiteNoise = ctx.createBufferSource();
      whiteNoise.buffer = noiseBuffer;
      whiteNoise.loop = true;
      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.003, ctx.currentTime);
      whiteNoise.connect(noiseGain);
      noiseGain.connect(scopeMix); // Feed directly to spectrum scope analyser
      whiteNoise.start();
      this.activeOscillators.push({ id: 'whitenoise', node: whiteNoise as unknown as OscillatorNode });

      this.isListening.set(sources['mic']);
      this.isSynthesizing.set(sources['pid-8422'] || sources['pid-9901'] || sources['pid-4401'] || sources['osc']);

      // Setup active feed display prioritized key
      const activeKey = (['mic', 'osc', 'pid-8422', 'pid-9901', 'pid-4401'] as const).find(k => sources[k]) || 'none';
      this.activeFeed.set(activeKey);

      if (!this.animationFrameId) {
        this.startRealtimeAnalysisLoop();
      }

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendLog('error', `Audio Graph Assembly aborted error: ${msg}`);
    }
  }

  // Teardown previous active nodes to prevent overlaps or multiple threads
  private teardownActiveGraph(stopMicStream = true) {
    for (const item of this.activeOscillators) {
      try {
        item.node.stop();
        item.node.disconnect();
      } catch {
        /* safe fallback */
      }
      if (item.interval) {
        clearInterval(item.interval);
      }
    }
    this.activeOscillators = [];

    if (stopMicStream && this.micStream) {
      this.micStream.getTracks().forEach(track => track.stop());
      this.micStream = null;
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.biquadFilter) {
      this.biquadFilter.disconnect();
      this.biquadFilter = null;
    }

    if (this.echoDelayNode) {
      this.echoDelayNode.disconnect();
      this.echoDelayNode = null;
    }

    if (this.echoFeedbackGain) {
      this.echoFeedbackGain.disconnect();
      this.echoFeedbackGain = null;
    }

    if (this.distortionNode) {
      this.distortionNode.disconnect();
      this.distortionNode = null;
    }

    for (const bus of this.activeBuses) {
      try {
        bus.disconnect();
      } catch {
        /* safe cleanup */
      }
    }
    this.activeBuses = [];

    this.isListening.set(false);
    this.isSynthesizing.set(false);
  }

  // WaveShaper saturation curve calculator
  private makeDistortionCurve(amount: number) {
    const k = typeof amount === 'number' ? amount : 50;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const deg = Math.PI / 180;
    for (let i = 0; i < n_samples; ++i) {
      const x = (i * 2) / n_samples - 1;
      curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  // Backward-compatible triggers that link perfectly to our multi-source state togglers
  async startMicInput(): Promise<boolean> {
    if (this.micStream) {
      if (!this.activeSources()['mic']) {
        this.toggleSource('mic');
      }
      return true;
    }
    try {
      this.appendLog('info', 'Requesting microphone hardware authorization...');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
      this.micStream = stream;
      this.activeSources.update(s => ({ ...s, 'mic': true }));
      return true;
    } catch {
      this.activeSources.update(s => ({ ...s, 'mic': false }));
      this.appendLog('error', 'Microphone capture blocked or device offline.');
      return false;
    }
  }

  isDestMapped(chainId: string, destinationId: string): boolean {
    const row = this.chainDestinationMap()[chainId] as Record<string, boolean> | undefined;
    return row ? !!row[destinationId] : false;
  }

  injectSimulatedFeed(feedId: 'pid-8422' | 'pid-9901' | 'pid-4401') {
    this.toggleSource(feedId);
  }

  injectDynamicOscillator() {
    this.toggleSource('osc');
  }

  toggleSoundMute() {
    this.muteSynth.set(!this.muteSynth());
    this.appendLog('info', this.muteSynth() ? 'Local synth speakers channel muted.' : 'Local synth channel connected to speakers.');
  }

  updateManualFreq(hz: number) {
    this.manualSynthFreq.set(hz);
  }

  toggleDestMapping(chainId: string, destinationId: string) {
    this.chainDestinationMap.update(map => {
      const updated = { ...map };
      const chainRow = { ...updated[chainId] } as Record<string, boolean>;
      chainRow[destinationId] = !chainRow[destinationId];
      updated[chainId] = chainRow as Record<'speaker' | 'decoder' | 'recorder' | 'scope', boolean>;
      return updated;
    });
    this.appendLog('info', `Routing Matrix Patch updated: ${chainId.toUpperCase()} -> ${destinationId.toUpperCase()}`);
  }

  getSliderValue(event: Event): number {
    return parseFloat((event.target as HTMLInputElement).value);
  }

  updateSourceChain(srcId: string, chain: string) {
    if (chain === 'direct' || chain === 'filter' || chain === 'echo' || chain === 'distortion') {
      this.sourceChainMap.update(map => {
        const updated = { ...map };
        updated[srcId] = chain;
        return updated;
      });
      this.appendLog('info', `Source assignment mutated: '${srcId}' routed to '${chain.toUpperCase()}' processor.`);
    }
  }

  onDragStart(event: DragEvent, type: 'source' | 'chain', id: string) {
    this.activeDragType.set(type);
    this.activeDragId.set(id);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'copyMove';
      event.dataTransfer.setData('text/plain', id);
      
      try {
        const dragIcon = document.createElement('div');
        dragIcon.style.padding = '3px 6px';
        dragIcon.style.background = '#00FF41';
        dragIcon.style.color = '#000000';
        dragIcon.style.fontSize = '8px';
        dragIcon.style.fontFamily = 'monospace';
        dragIcon.style.fontWeight = 'bold';
        dragIcon.style.borderRadius = '2px';
        dragIcon.style.border = '1px solid #000';
        const labelText = id.startsWith('pid-') ? `PID ${id.replace('pid-', '')}` : id.toUpperCase();
        dragIcon.innerText = `⚡ PATCH: ${labelText}`;
        dragIcon.style.position = 'absolute';
        dragIcon.style.top = '-999px';
        document.body.appendChild(dragIcon);
        event.dataTransfer.setDragImage(dragIcon, 0, 0);
        setTimeout(() => { if (dragIcon.parentNode) dragIcon.parentNode.removeChild(dragIcon); }, 0);
      } catch (err) {
        console.debug('Custom drag image bypass:', err);
      }
    }
    this.appendLog('info', `DND PATCHING GRABBED: Selected '${type.toUpperCase()}' node [${id.toUpperCase()}]`);
  }

  onDragEnd() {
    this.activeDragType.set(null);
    this.activeDragId.set(null);
    this.currentDragOverZone.set(null);
  }

  onDragOver(event: DragEvent, zoneId: string) {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    this.currentDragOverZone.set(zoneId);
  }

  onDragLeave(zoneId: string) {
    if (this.currentDragOverZone() === zoneId) {
      this.currentDragOverZone.set(null);
    }
  }

  onDrop(event: DragEvent, targetType: 'chain' | 'destination', targetId: string) {
    event.preventDefault();
    const dragType = this.activeDragType();
    const dragId = this.activeDragId();
    this.onDragEnd();

    if (!dragType || !dragId) return;

    if (targetType === 'chain' && dragType === 'source') {
      const sourceId = dragId;
      const chainId = targetId;
      this.updateSourceChain(sourceId, chainId);
      this.appendLog('info', `DND PATCH CONNECTED: Source [${sourceId.toUpperCase()}] ➔ [${chainId.toUpperCase()}]`);
    } else if (targetType === 'destination' && dragType === 'chain') {
      const chainId = dragId;
      const destId = targetId;
      this.toggleDestMapping(chainId, destId);
      this.appendLog('info', `DND PATHWAY PLUGGED: [${chainId.toUpperCase()}] ➔ Output Terminals [${destId.toUpperCase()}]`);
    }
  }

  // Equalizer filters adjustments
  toggleFilterEnabled(enabled: boolean) {
    this.filterEnabled.set(enabled);
    this.appendLog('info', enabled ? `Filter Network Enabled: ${this.filterType().toUpperCase()} mode.` : 'Filter Network Bypassed.');
  }

  changeFilterType(type: string) {
    if (type === 'lowpass' || type === 'highpass' || type === 'bandpass') {
      this.filterType.set(type);
    }
    this.appendLog('info', `Filter Mode set to ${type.toUpperCase()}`);
  }

  changeColorScheme(scheme: string) {
    if (scheme === 'classic' || scheme === 'amber' || scheme === 'neon' || scheme === 'cyan') {
      this.visualizerColorScheme.set(scheme);
      this.appendLog('info', `Visualizer Color Scheme updated to: ${scheme.toUpperCase()}`);
    }
  }

  updateFilterCutoff(cutoff: number) {
    this.filterCutoff.set(cutoff);
  }

  updateFilterQ(q: number) {
    this.filterQ.set(q);
  }

  // Select profile matching target
  selectProfile(profId: string) {
    this.selectedProfileId.set(profId);
    this.appendLog('info', `Scanning targeting: '${this.currentActiveProfile()?.name}' (${this.currentActiveProfile()?.targetFreq} Hz)`);
    this.isMatched.set(false);
    this.matchLockStart = null;
  }

  // Delete saved profiles
  deleteProfile(id: string) {
    try {
      const stored = localStorage.getItem('signal_scan_profiles');
      if (stored) {
        let list: AudioProfile[] = JSON.parse(stored);
        list = list.filter(p => p.id !== id);
        localStorage.setItem('signal_scan_profiles', JSON.stringify(list));
        this.appendLog('info', 'Custom pattern profile purged from memory.');
        this.loadAllProfiles();
        this.selectedProfileId.set('pres-call-440');
      }
    } catch {
      this.appendLog('error', 'Purge database failed.');
    }
  }

  // Save new custom dynamic profile parameters
  saveCustomProfile() {
    const nameStr = this.creatorName().trim();
    const freqVal = this.creatorFreq();
    const tolVal = this.creatorTolerance();
    const durVal = this.creatorDuration();

    if (!nameStr) {
      this.appendLog('error', 'Profile Name missing.');
      return;
    }

    const payload: AudioProfile = {
      id: 'cust-' + Date.now(),
      name: nameStr,
      targetFreq: freqVal,
      tolerance: tolVal,
      requiredDuration: durVal
    };

    try {
      const stored = localStorage.getItem('signal_scan_profiles');
      const list: AudioProfile[] = stored ? JSON.parse(stored) : [];
      list.push(payload);
      localStorage.setItem('signal_scan_profiles', JSON.stringify(list));
      
      this.appendLog('info', `Saved custom pattern profile: '${nameStr}' targeting ${freqVal}Hz`);
      this.loadAllProfiles();
      this.selectedProfileId.set(payload.id);
      
      this.creatorName.set('');
      this.showProfileCreator.set(false);
    } catch {
      this.appendLog('error', 'Failed saving profile to storage.');
    }
  }

  // Real-time calculation math & CRT scope animation drawing loop
  private startRealtimeAnalysisLoop() {
    const canvas = this.canvasElement?.nativeElement;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bufferLength = this.analyser?.frequencyBinCount || 1024;
    const dataArray = new Uint8Array(bufferLength);
    const waveArray = new Uint8Array(bufferLength);

    const draw = () => {
      this.animationFrameId = requestAnimationFrame(draw);

      if (!this.analyser || !this.audioCtx) return;

      // Ensure canvas is properly sized on resize transitions
      if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
        canvas.width = canvas.clientWidth;
        canvas.height = canvas.clientHeight;
      }

      const width = canvas.width;
      const height = canvas.height;

      // Extract raw audio metrics
      this.analyser.getByteFrequencyData(dataArray);
      this.analyser.getByteTimeDomainData(waveArray);

      // 1. Calculate Peak Frequency via max FFT magnitude index bin
      let maxVal = -1;
      let peakBin = -1;
      let energySum = 0;

      for (let i = 0; i < bufferLength; i++) {
        energySum += dataArray[i];
        if (dataArray[i] > maxVal) {
          maxVal = dataArray[i];
          peakBin = i;
        }
      }

      const nyquist = this.audioCtx.sampleRate / 2;
      let calculatedPeak = 0;
      if (maxVal > 12) { // Ensure minimum magnitude to rule out background noise floor
        if (peakBin > 0 && peakBin < bufferLength - 1) {
          // Quadratic interpolation of spectral peak for high precision estimation (up to 0.1Hz frequency accuracy)
          const alpha = dataArray[peakBin];
          const beta = dataArray[peakBin - 1];
          const gamma = dataArray[peakBin + 1];
          const denom = beta - 2 * alpha + gamma;
          let d = 0;
          if (denom !== 0) {
            d = 0.5 * (beta - gamma) / denom;
          }
          calculatedPeak = ((peakBin + d) * nyquist) / bufferLength;
        } else {
          calculatedPeak = (peakBin * nyquist) / bufferLength;
        }
      }

      // Estimated decibel calculation from energy spectrum
      const avgValue = energySum / bufferLength;
      let db = -96;
      if (avgValue > 0) {
        db = 20 * Math.log10(avgValue / 255) - 6;
      }

      // Audio signals Classification categorization
      let classification = 'SILENCE / ATMOSPHERIC NOISE';
      if (calculatedPeak > 0 && db > -85) {
        if (calculatedPeak < 100) {
          classification = 'LOW_FREQUENCY_HUM (Mains Hum, Inductors)';
        } else if (calculatedPeak >= 100 && calculatedPeak < 350) {
          classification = 'SUB_BASS_SPECTRUM (Subwoofers, Heavy Machinery)';
        } else if (calculatedPeak >= 350 && calculatedPeak < 1000) {
          classification = 'HUMAN_AUDIO_MIDRANGE (Vocal, Comms Line)';
        } else if (calculatedPeak >= 1000 && calculatedPeak < 3200) {
          classification = 'HIGH_SIREN_BEACON (Pulsed Alarms, Alert Chimes)';
        } else if (calculatedPeak >= 3200 && calculatedPeak < 7000) {
          classification = 'FRICTION_NOISE (High frequency leakage)';
        } else {
          classification = 'HIGH_CRT_LINE_SCAN (Ultrasonic beacon detection)';
        }
      }

      // 2. Compute pattern similarity ratio targeting the actively selected profile
      const activeProf = this.currentActiveProfile();
      let matchRatio = 0;

      if (activeProf && calculatedPeak > 0 && db > -85) {
        const diff = Math.abs(calculatedPeak - activeProf.targetFreq);
        if (diff <= activeProf.tolerance) {
          // Excellent match, linearly mapping from 85% to 100% depending on closeness
          matchRatio = 100 - (diff / activeProf.tolerance) * 15;
        } else {
          // Slanted dropoff
          matchRatio = Math.max(0, 85 - (diff / activeProf.targetFreq) * 120);
        }
      }

      const nowTime = performance.now();
      if (nowTime - this.lastSignalUpdateTime > 100) {
        this.currentPeakFreq.set(calculatedPeak);
        this.currentVolumeDb.set(db > -96 ? db : -96);
        this.signalClassification.set(classification);
        this.vectorMatch.set(matchRatio);
        this.lastSignalUpdateTime = nowTime;
      }

      // 3. Match LOCK timing counter
      const lockedValueThreshold = 85; 
      if (matchRatio >= lockedValueThreshold) {
        if (!this.matchLockStart) {
          this.matchLockStart = performance.now();
        } else {
          const matchDuration = performance.now() - this.matchLockStart;
          if (matchDuration >= activeProf!.requiredDuration) {
            if (!this.isMatched()) {
              this.isMatched.set(true);
              this.lastMatchFreq.set(calculatedPeak);
              this.lastMatchDb.set(db);

              this.appendLog('match', `PATTERN MATCH SECURED: '${activeProf!.name}' running at ${calculatedPeak.toFixed(1)}Hz // Volume: ${db.toFixed(1)}dB`);
              
              // Trigger a small high frequency synth tone bleep as sound notification
              if (this.soundActivatedAlert()) {
                this.playAudibleAlertChime();
              }
            }
          }
        }
      } else {
        if (this.isMatched()) {
          this.isMatched.set(false);
          this.matchLockStart = null;
        }
      }

      // 4. GUI Rendering on the canvas element
      ctx.clearRect(0, 0, width, height);

      const sens = this.visualizerSensitivity();
      const scheme = this.visualizerColorScheme();

      let colors = {
        primary: '#00FF41',
        fill: 'rgba(0, 255, 65, 0.1)',
        marker: 'rgba(0, 255, 65, 0.4)'
      };

      if (scheme === 'amber') {
        colors = {
          primary: '#FFB000',
          fill: 'rgba(255, 176, 0, 0.1)',
          marker: 'rgba(255, 176, 0, 0.4)'
        };
      } else if (scheme === 'neon') {
        colors = {
          primary: '#FF007F',
          fill: 'rgba(255, 0, 127, 0.1)',
          marker: 'rgba(255, 0, 127, 0.4)'
        };
      } else if (scheme === 'cyan') {
        colors = {
          primary: '#00F0FF',
          fill: 'rgba(0, 240, 255, 0.1)',
          marker: 'rgba(0, 240, 255, 0.4)'
        };
      }

      // Grid Line CRT background ticks
      ctx.strokeStyle = '#181e19';
      ctx.lineWidth = 1;
      const step = 25;
      for (let x = 0; x < width; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      for (let y = 0; y < height; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      if (this.scopeType() === 'fft') {
        // Frequency spec bar chart renders
        ctx.fillStyle = colors.fill;
        ctx.strokeStyle = colors.primary;
        ctx.lineWidth = 1.8;

        ctx.beginPath();
        const barWidth = width / bufferLength * 4; // Zoom into low-mid bands
        let x = 0;

        for (let i = 0; i < bufferLength / 4; i++) {
          const val = dataArray[i];
          const barHeight = Math.min(height, (val / 255) * height * 0.85 * sens);

          if (i === 0) {
            ctx.moveTo(x, height - barHeight);
          } else {
            ctx.lineTo(x, height - barHeight);
          }

          x += barWidth;
        }
        ctx.lineTo(width, height);
        ctx.lineTo(0, height);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // High Density Guidelines target profile vertical indicator lines
        if (activeProf) {
          const targetBin = (activeProf.targetFreq * bufferLength) / nyquist;
          const targetX = (targetBin * width) / (bufferLength / 4);

          // Draw target marker only if inside our visible range
          if (targetX > 0 && targetX < width) {
            ctx.strokeStyle = colors.marker;
            ctx.setLineDash([5, 5]);
            ctx.beginPath();
            ctx.moveTo(targetX, 0);
            ctx.lineTo(targetX, height);
            ctx.stroke();
            ctx.setLineDash([]);

            ctx.fillStyle = colors.primary;
            ctx.font = '8px monospace';
            ctx.fillText(`TARGET: ${activeProf.targetFreq}Hz`, targetX + 5, 12);
          }
        }

      } else {
        // TimeDomain Oscilloscope sweep lines
        ctx.strokeStyle = colors.primary;
        ctx.lineWidth = 2.2;
        ctx.shadowBlur = 4;
        ctx.shadowColor = colors.primary;

        ctx.beginPath();
        const sliceWidth = width / bufferLength;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
          const deviation = (waveArray[i] / 128.0 - 1.0) * sens;
          const v = 1.0 + deviation;
          const y = (v * height) / 2;

          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }

          x += sliceWidth;
        }

        ctx.lineTo(width, height / 2);
        ctx.stroke();
        ctx.shadowBlur = 0; // reset
      }
    };

    this.animationFrameId = requestAnimationFrame(draw);
  }

  // Trigger high tech alert chime sound feedback
  private playAudibleAlertChime() {
    const now = Date.now();
    if (now - this.lastAlertTriggerTime < 2500) return; // guard against rapid chirping

    this.lastAlertTriggerTime = now;
    if (!this.audioCtx) return;

    try {
      const alertOsc = this.audioCtx.createOscillator();
      const alertGain = this.audioCtx.createGain();

      alertOsc.type = 'triangle';
      alertOsc.frequency.setValueAtTime(880, this.audioCtx.currentTime); // chime frequency
      alertGain.gain.setValueAtTime(0.04, this.audioCtx.currentTime);

      alertOsc.connect(alertGain);
      alertGain.connect(this.audioCtx.destination);

      alertOsc.start();
      // Fast fadeout decrescendo
      alertGain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + 0.15);
      alertOsc.stop(this.audioCtx.currentTime + 0.16);
    } catch {
      /* feedback alert fallback */
    }
  }

  // Session Logging operations
  appendLog(type: 'info' | 'match' | 'warn' | 'error', message: string) {
    const rawTime = new Date();
    const parsedTime = rawTime.toTimeString().split(' ')[0];
    
    const newLogItem: LogEntry = {
      timestamp: rawTime.getTime(),
      timeFormatted: parsedTime,
      type,
      message
    };

    this.logs.update(current => [newLogItem, ...current].slice(0, 150));
  }

  clearLogs() {
    this.logs.set([]);
    this.appendLog('info', 'Secure buffer rotation cleared. Analytics ready.');
  }

  // Export logs to standard JSON data file on client disk
  exportSessionData() {
    try {
      if (this.logs().length === 0) {
        this.appendLog('warn', 'Zero log signals compiled to download.');
        return;
      }

      this.appendLog('info', 'Compiling session logs to JSON file schema...');
      
      const payloadString = JSON.stringify(this.logs(), null, 2);
      const blob = new Blob([payloadString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      
      const a = document.createElement('a');
      a.href = url;
      a.download = `signal_scan_session_${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      this.appendLog('info', 'Download stream successful.');
    } catch {
      this.appendLog('error', 'Compile file failed.');
    }
  }

  // Multi-source Inside & Outside Audio Recorder Engine
  startRecording() {
    if (this.isRecording()) return;

    // Direct initialization helper
    const ok = this.initAudioContext();
    if (!ok) {
      this.appendLog('error', 'Audio infrastructure offline. Recording cancelled.');
      return;
    }

    const ctx = this.audioCtx!;
    let streamToRecord: MediaStream | null = null;
    const sourceMode = this.recordingSource();

    try {
      if (sourceMode === 'outside') {
        // Outside recording: Physical microphone stream
        if (!this.micStream) {
          this.appendLog('warn', 'Outside Capture requires live Microphone streaming. Sparking microphone stream...');
          this.startMicInput().then(() => {
            if (this.micStream) {
              this.startRecordingWithStream(this.micStream, 'Outside (Microphone Input)');
            } else {
              this.appendLog('error', 'Outside Capture active initialization failed.');
            }
          });
          return;
        } else {
          streamToRecord = this.micStream;
        }
      } else if (sourceMode === 'inside') {
        // Inside recording: Synthesizer signal / Simulated stream
        if (!this.analyser) {
          this.appendLog('warn', 'Inside Capture requires active synthetic audio. Launching Custom Oscillator...');
          this.injectDynamicOscillator();
        }

        if (!this.recordDestination) {
          this.recordDestination = ctx.createMediaStreamDestination();
        }

        if (this.analyser) {
          this.analyser.connect(this.recordDestination);
          streamToRecord = this.recordDestination.stream;
        }
      } else {
        // Hybrid recording: Combined active nodes
        if (!this.analyser) {
          this.appendLog('warn', 'Pipeline idle. Activating manual Custom Oscillator for hybrid recording...');
          this.injectDynamicOscillator();
        }

        if (!this.recordDestination) {
          this.recordDestination = ctx.createMediaStreamDestination();
        }

        if (this.analyser) {
          this.analyser.connect(this.recordDestination);
          streamToRecord = this.recordDestination.stream;
        }
      }

      if (streamToRecord) {
        const readableLabel = sourceMode === 'inside' ? 'Inside Loopback Feed' : (sourceMode === 'outside' ? 'Outside Acoustics Mic' : 'Hybrid Combined Stream');
        this.startRecordingWithStream(streamToRecord, readableLabel);
      } else {
        this.appendLog('error', 'Audio track capture node stream missing.');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendLog('error', `Recorder connection aborted: ${msg}`);
    }
  }

  private startRecordingWithStream(stream: MediaStream, sourceLabel: string) {
    this.recordedChunks = [];
    let mimeType = '';
    const options: MediaRecorderOptions = {};

    if (MediaRecorder.isTypeSupported('audio/webm')) {
      options.mimeType = 'audio/webm';
      mimeType = 'audio/webm';
    } else if (MediaRecorder.isTypeSupported('audio/ogg')) {
      options.mimeType = 'audio/ogg';
      mimeType = 'audio/ogg';
    } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
      options.mimeType = 'audio/mp4';
      mimeType = 'audio/mp4';
    }

    try {
      this.mediaRecorder = new MediaRecorder(stream, options);

      this.mediaRecorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          this.recordedChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.recordedChunks, { type: mimeType || 'audio/webm' });
        const url = URL.createObjectURL(blob);
        const sizeBytes = blob.size;
        const sizeStr = sizeBytes > 1024 * 1024
          ? `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`
          : `${(sizeBytes / 1024).toFixed(1)} KB`;

        const freshFileId = 'rec-' + Date.now();
        const freshFile = {
          id: freshFileId,
          url,
          name: `RECO_SIG_${Date.now().toString().slice(-6)}.wav`,
          date: new Date().toLocaleTimeString(),
          duration: this.recordingDuration(),
          sizeStr,
          source: sourceLabel
        };

        this.recordedFiles.update(files => [freshFile, ...files]);
        this.appendLog('match', `COMPILED STREAM CLIPS: '${freshFile.name}' (${sizeStr}) secured to localized index.`);
        this.recordingDuration.set(0);
      };

      this.mediaRecorder.start(250);
      this.isRecording.set(true);
      this.recordingDuration.set(0);
      this.appendLog('info', `Recorder capture online targeting: ${sourceLabel}`);

      this.recordInterval = setInterval(() => {
        this.recordingDuration.update(d => d + this.recordingSpeedMultiplier());
      }, 1000);

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendLog('error', `MediaRecorder constructor failed: ${msg}`);
    }
  }

  stopRecording() {
    if (!this.isRecording() || !this.mediaRecorder) return;

    try {
      this.mediaRecorder.stop();
    } catch {
      /* secure fallbacks */
    }

    if (this.recordInterval) {
      clearInterval(this.recordInterval);
      this.recordInterval = null;
    }

    this.isRecording.set(false);
    this.mediaRecorder = null;
    this.appendLog('info', 'Active stream recording finalized.');
  }

  deleteRecordedFile(id: string) {
    const file = this.recordedFiles().find(f => f.id === id);
    if (file) {
      URL.revokeObjectURL(file.url);
    }
    this.recordedFiles.update(files => files.filter(f => f.id !== id));
    this.appendLog('info', 'Purged file buffer registry.');
  }

  downloadRecordedFile(file: RecordedFile) {
    const a = document.createElement('a');
    a.href = file.url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    this.appendLog('info', `Downloaded segment stream: ${file.name}`);
  }

  playRecordedFile(file: RecordedFile) {
    if (this.currentlyPlayingId() === file.id && this.playbackAudio) {
      // Pause
      this.playbackAudio.pause();
      this.currentlyPlayingId.set(null);
      this.appendLog('info', `Playback paused: ${file.name}`);
      return;
    }

    if (this.playbackAudio) {
      this.playbackAudio.pause();
    }

    try {
      this.playbackAudio = new Audio(file.url);
      this.currentlyPlayingId.set(file.id);
      this.appendLog('info', `Playing recorded clip: ${file.name}`);

      this.playbackAudio.play().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.appendLog('error', `Playback failed: ${msg}`);
        this.currentlyPlayingId.set(null);
      });

      this.playbackAudio.onended = () => {
        this.currentlyPlayingId.set(null);
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.appendLog('error', `Audio element creation failed: ${msg}`);
      this.currentlyPlayingId.set(null);
    }
  }

  generateDemoClips() {
    const demoFiles: RecordedFile[] = [
      {
        id: 'demo-1',
        url: '',
        name: 'DEC_STREAM_PORT_8422.wav',
        date: new Date().toLocaleTimeString(),
        duration: 324, // 5.4 minutes
        sizeStr: '1.48 MB',
        source: 'Inside Loopback (Chrome Window)'
      },
      {
        id: 'demo-2',
        url: '',
        name: 'SEC_SIREN_GATEWAY_4401.wav',
        date: new Date().toLocaleTimeString(),
        duration: 720, // 12.0 minutes
        sizeStr: '4.12 MB',
        source: 'Hybrid Stream (WebRTC Siren)'
      },
      {
        id: 'demo-3',
        url: '',
        name: 'ACOUSTICAL_MIC_VENT.wav',
        date: new Date().toLocaleTimeString(),
        duration: 15, // 0.25 minutes
        sizeStr: '243 KB',
        source: 'Outside Acoustics (Mic Hardware)'
      },
      {
        id: 'demo-4',
        url: '',
        name: 'BEACON_SPECTRUM_1200.wav',
        date: new Date().toLocaleTimeString(),
        duration: 1800, // 30.0 minutes
        sizeStr: '11.83 MB',
        source: 'Inside Loopback (Custom Oscillator)'
      },
      {
        id: 'demo-5',
        url: '',
        name: 'BACKGROUND_MSN_9901.wav',
        date: new Date().toLocaleTimeString(),
        duration: 94, // 1.57 minutes
        sizeStr: '412 KB',
        source: 'Inside Loopback (MS Edge Media)'
      }
    ];

    this.recordedFiles.update(files => [...demoFiles, ...files]);
    this.appendLog('match', 'LOADED 5 PREMIUM SIGNAL RECORDINGS WITH EXTENDED TIME INDEX TO ARCHIVE.');
  }
}
