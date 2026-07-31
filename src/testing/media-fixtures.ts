import { deflateSync } from "node:zlib";
import { wavFromPcm16 } from "../providers/media-client";

/**
 * Real, decodable media fixtures for the render proofs — generated, not committed.
 *
 * The render e2e's existing fixtures are a 1×1 PNG and half a second of SILENT PCM. Neither
 * can prove anything about motion or audio coverage: a 1×1 image looks identical however far
 * you pan it, and silence is indistinguishable from a track that stopped early. So these
 * build the two things the proofs actually need — a PATTERNED image whose pixels change when
 * it moves, and AUDIBLE tones whose presence or absence in a time window is measurable.
 *
 * Both are pure functions of their arguments (no randomness, no clock), so a spec that uses
 * them stays deterministic.
 */

// --- PNG ------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * A `width`×`height` 8-bit RGB PNG carrying a hard-edged checkerboard.
 *
 * High-contrast hard edges are the point: a Ken Burns pan of a smooth gradient can move by a
 * couple of percent and change almost no pixel values, which would make the proof depend on
 * the pan being LARGE. Sharp edges mean even the modest 1.10-scale / 1.5%-drift move this
 * project uses shifts a large number of pixels, so the assertion tests the effect rather than
 * its magnitude.
 */
export function checkerboardPng(
  width: number,
  height: number,
  square = 8,
): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter type 0 (None) for this scanline
    for (let x = 0; x < width; x++) {
      const on = (Math.floor(x / square) + Math.floor(y / square)) % 2 === 0;
      const v = on ? 245 : 15;
      raw[p++] = v;
      raw[p++] = on ? 200 : 40;
      raw[p++] = on ? 90 : 120;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- WAV tones ------------------------------------------------------------------

export const TONE_SAMPLE_RATE = 24_000;

/**
 * `seconds` of a full-scale sine tone as a mono 24 kHz PCM16 WAV.
 *
 * WAV rather than MP3 on purpose: Chromium has to really decode this during the render, and
 * a hand-assembled MP3 frame stream with a synthetic payload is not guaranteed to decode to
 * anything. A WAV is unambiguous, and its length is exactly computable from its own header —
 * which is also what `audioDurationSeconds` reads, so the fixture and the code under test
 * agree by construction rather than by coincidence.
 */
export function toneWav(seconds: number, frequencyHz = 440): Buffer {
  const samples = Math.round(seconds * TONE_SAMPLE_RATE);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const value = Math.round(
      0.8 * 32767 * Math.sin((2 * Math.PI * frequencyHz * i) / TONE_SAMPLE_RATE),
    );
    pcm.writeInt16LE(value, i * 2);
  }
  return wavFromPcm16(pcm, { sampleRate: TONE_SAMPLE_RATE, channels: 1 });
}

/**
 * `seconds` of digital SILENCE in the same container as {@link toneWav}.
 *
 * Needed to measure ONE track in a mix. The music-duck proof asks "how loud is the bed
 * while narration is playing?" — and a narration tone would drown the answer, because
 * `windowLevel` measures the SUM. A silent narration clip keeps the duck WINDOW (which is
 * derived from the manifest's `narrationAssetKey`/`narrationDurationSeconds`, not from the
 * audio) while leaving the measured level as the music alone.
 */
export function silentWav(seconds: number): Buffer {
  const samples = Math.round(seconds * TONE_SAMPLE_RATE);
  return wavFromPcm16(Buffer.alloc(samples * 2), {
    sampleRate: TONE_SAMPLE_RATE,
    channels: 1,
  });
}

// --- WAV analysis ---------------------------------------------------------------

/**
 * Mean absolute amplitude (0..1) of a mono/stereo PCM16 WAV between two times.
 *
 * This is how "the music covers the whole video" and "narration starts when its scene starts"
 * become falsifiable rather than rhetorical: render the composition to an audio-only WAV, then
 * ask whether a specific window contains sound. A bed that stops early leaves its tail window
 * silent; narration mounted at frame 0 instead of inside its scene leaves the wrong window
 * loud.
 */
export function windowLevel(
  wav: Buffer,
  startSeconds: number,
  endSeconds: number,
): number {
  const channels = wav.readUInt16LE(22);
  const sampleRate = wav.readUInt32LE(24);
  // Walk chunks to find `data` — the renderer's WAV is not guaranteed to use the canonical
  // 44-byte layout our own writer emits.
  let offset = 12;
  let dataStart = -1;
  let dataLength = 0;
  while (offset + 8 <= wav.length) {
    const id = wav.subarray(offset, offset + 4).toString("ascii");
    const size = wav.readUInt32LE(offset + 4);
    if (id === "data") {
      dataStart = offset + 8;
      dataLength = Math.min(size, wav.length - dataStart);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataStart < 0) throw new Error("windowLevel: no data chunk in the rendered WAV");

  const frameBytes = 2 * channels;
  const firstFrame = Math.floor(startSeconds * sampleRate);
  const lastFrame = Math.min(
    Math.floor(endSeconds * sampleRate),
    Math.floor(dataLength / frameBytes),
  );
  if (lastFrame <= firstFrame) return 0;

  let sum = 0;
  let count = 0;
  for (let f = firstFrame; f < lastFrame; f++) {
    for (let c = 0; c < channels; c++) {
      sum += Math.abs(wav.readInt16LE(dataStart + f * frameBytes + c * 2));
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count / 32768;
}
