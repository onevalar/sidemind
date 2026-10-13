"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import Image from "next/image";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-react";
import { motionTokens } from "../../lib/motion-tokens";
import { photos } from "../../lib/media";
import styles from "./media-player.module.css";

type Track = { title: string; artist: string; length: number; bpm: number; notes: number[]; cover: string };
const tracks: Track[] = [
  { title: "Morning tide", artist: "Arc Sessions", length: 24, bpm: 84, notes: [220, 261.63, 329.63, 293.66, 246.94, 196, 246.94, 293.66], cover: "sea-at-dusk" },
  { title: "Glass garden", artist: "Arc Sessions", length: 24, bpm: 96, notes: [261.63, 329.63, 392, 440, 392, 329.63, 293.66, 329.63], cover: "sunroom" },
  { title: "After the rain", artist: "Arc Sessions", length: 24, bpm: 72, notes: [196, 246.94, 293.66, 261.63, 220, 261.63, 329.63, 246.94], cover: "alpine-lake" },
];

// A short, original PCM loop. Keeping the sound local makes every transport control real.
function renderTrack(track: Track): Blob {
  const rate = 22050;
  const samples = rate * track.length;
  const bytes = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(bytes);
  const write = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  write(0, "RIFF"); view.setUint32(4, 36 + samples * 2, true); write(8, "WAVE"); write(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, "data"); view.setUint32(40, samples * 2, true);
  const beat = 60 / track.bpm;
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const step = Math.floor(t / beat) % track.notes.length;
    const phase = (t % beat) / beat;
    const frequency = track.notes[step];
    const pluck = Math.sin(2 * Math.PI * frequency * t) * Math.exp(-phase * 5.2);
    const overtone = Math.sin(2 * Math.PI * frequency * 2 * t) * Math.exp(-phase * 8) * .16;
    const pad = Math.sin(2 * Math.PI * track.notes[Math.floor(step / 2) * 2] * .5 * t) * .18;
    const pulse = Math.sin(2 * Math.PI * 82 * t) * Math.exp(-((t % (beat * 2)) / beat) * 18) * .08;
    const fade = Math.min(1, t / .18, (track.length - t) / .5);
    const value = Math.max(-1, Math.min(1, (pluck * .43 + overtone + pad + pulse) * fade));
    view.setInt16(44 + i * 2, value * 32767, true);
  }
  return new Blob([bytes], { type: "audio/wav" });
}

const standardEase = [...motionTokens.ease.standard] as [number, number, number, number];

function coverFor(id: string) { return photos.find(photo => photo.id === id) ?? photos[0]; }

function format(seconds: number) { const safe = Number.isFinite(seconds) ? Math.floor(seconds) : 0; return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`; }

export function MediaPlayerBlock() {
  const reduce = useReducedMotion();
  const audioRef = useRef<HTMLAudioElement>(null);
  const continueRef = useRef(false);
  const [trackIndex, setTrackIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [volume, setVolume] = useState(.7);
  const [previousVolume, setPreviousVolume] = useState(.7);
  const [ready, setReady] = useState(false);
  const track = tracks[trackIndex];
  const cover = coverFor(track.cover);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const url = URL.createObjectURL(renderTrack(tracks[trackIndex]));
    audio.src = url;
    audio.load();
    audio.currentTime = 0;
    if (continueRef.current) { void audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false)); }
    setReady(true);
    return () => { audio.pause(); URL.revokeObjectURL(url); };
  }, [trackIndex]);

  useEffect(() => { if (audioRef.current) audioRef.current.volume = volume; }, [volume]);

  async function togglePlay() {
    const audio = audioRef.current;
    if (!audio || !ready) return;
    if (audio.paused) { try { await audio.play(); setPlaying(true); } catch { setPlaying(false); } }
    else { audio.pause(); setPlaying(false); }
  }
  function select(index: number) { if (index === trackIndex) { void togglePlay(); return; } continueRef.current = playing; setPlaying(false); setPosition(0); setTrackIndex(index); }
  function skip(direction: -1 | 1) { select((trackIndex + direction + tracks.length) % tracks.length); }
  function seek(value: number) { const audio = audioRef.current; if (audio) audio.currentTime = value; setPosition(value); }
  function toggleMute() { if (volume > 0) { setPreviousVolume(volume); setVolume(0); } else setVolume(previousVolume || .7); }

  const motionEnabled = !reduce;
  const transition = motionEnabled ? motionTokens.spring.gentle : { duration: 0 };
  const progress = Math.min(1, position / track.length) * 100;

  return <section className={styles.player} aria-label="Audio player"><audio ref={audioRef} preload="auto" onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)} onEnded={(event) => { event.currentTarget.currentTime = 0; setPlaying(false); continueRef.current = false; setPosition(0); }} />
    <div className={styles.cover}>
      <AnimatePresence initial={false}>
        <motion.div key={cover.id} className={styles.coverImage} initial={motionEnabled ? { opacity: 0 } : false} animate={{ opacity: 1 }} exit={motionEnabled ? { opacity: 0 } : undefined} transition={{ duration: motionEnabled ? motionTokens.duration.standard : 0, ease: standardEase }}>
          <Image src={cover.src} alt={cover.alt} fill sizes="(max-width: 560px) 100vw, 520px" />
        </motion.div>
      </AnimatePresence>
    </div>
    <div className={styles.nowPlaying}>
      <div className={styles.titleClip}><AnimatePresence mode="popLayout" initial={false}><motion.div key={track.title} initial={motionEnabled ? { opacity: 0, y: 10 } : false} animate={{ opacity: 1, y: 0 }} exit={motionEnabled ? { opacity: 0, y: -10 } : { opacity: 0 }} transition={motionEnabled ? motionTokens.spring.gentle : { duration: 0 }}><h2>{track.title}</h2><p>{track.artist} · Original loop</p></motion.div></AnimatePresence></div>
      <div className={styles.transport}>
        <button type="button" onClick={() => skip(-1)} aria-label="Previous track"><SkipBack size={18} fill="currentColor"/></button>
        <button className={styles.playButton} type="button" onClick={() => void togglePlay()} disabled={!ready} aria-label={playing ? "Pause" : "Play"}>{motionEnabled ? <AnimatePresence mode="popLayout" initial={false}><motion.span key={playing ? "pause" : "play"} className={styles.playIcon} initial={{ opacity: 0, scale: .6, filter: "blur(2px)" }} animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }} exit={{ opacity: 0, scale: .6, filter: "blur(2px)" }} transition={{ duration: motionTokens.duration.fast, ease: standardEase }}>{playing ? <Pause size={20} fill="currentColor"/> : <Play size={20} fill="currentColor"/>}</motion.span></AnimatePresence> : playing ? <Pause size={20} fill="currentColor"/> : <Play size={20} fill="currentColor"/>}</button>
        <button type="button" onClick={() => skip(1)} aria-label="Next track"><SkipForward size={18} fill="currentColor"/></button>
      </div>
    </div>
    <div className={styles.timeline}><span>{format(position)}</span><input className={styles.range} style={{ "--fill": `${progress}%` } as CSSProperties} type="range" min={0} max={track.length} step={.1} value={Math.min(position, track.length)} onChange={(event) => seek(Number(event.target.value))} aria-label={`Seek ${track.title}`} aria-valuetext={`${format(position)} of ${format(track.length)}`}/><span>{format(track.length)}</span></div>
    <div className={styles.queueHead}><h3>Playlist</h3><div className={styles.volume}><button type="button" onClick={toggleMute} aria-label={volume ? "Mute audio" : "Unmute audio"}>{volume ? <Volume2 size={16}/> : <VolumeX size={16}/>}</button><input className={styles.range} style={{ "--fill": `${volume * 100}%` } as CSSProperties} type="range" min={0} max={1} step={.01} value={volume} onChange={(event) => setVolume(Number(event.target.value))} aria-label="Volume" aria-valuetext={`${Math.round(volume * 100)}%`}/></div></div>
    <ul className={styles.queue}>{tracks.map((item, index) => { const current = index === trackIndex; return <li key={item.title}><button type="button" className={styles.track} data-current={current} onClick={() => select(index)} aria-label={`${current && playing ? "Pause" : "Play"} ${item.title}`} aria-current={current ? "true" : undefined}>{current && <motion.span className={styles.selectionRail} layoutId="media-player-selection" transition={transition} aria-hidden="true"/>}<span className={styles.trackTitle}>{item.title}</span><span className={styles.trackStatus}>{current && playing ? <span className={styles.bars} data-reduce={reduce ? "true" : undefined} aria-label="Playing"><i/><i/><i/></span> : format(item.length)}</span></button></li>; })}</ul>
  </section>;
}

export default MediaPlayerBlock;
