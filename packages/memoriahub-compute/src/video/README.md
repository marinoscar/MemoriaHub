# video

Video frame sampling: seek timestamps, frame extraction at computed or given timestamps, the poster frame, the audio lead and the range-seek suitability probe for remote sources.

## Purpose and scope

Video frame sampling: seek timestamps, frame extraction at computed or given timestamps, the poster frame, the audio lead and the range-seek suitability probe for remote sources.

Pure compute only: no framework import, no environment read, no persistence. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-compute/video`. `video/index.ts`: `extractFrames`, `extractFramesAt`, `extractPosterFrame`, `extractAudioLead`, `computeSeekTimestamps`, `probeRangeSeekSuitability`, `isHttpUrl`. Other slices are imported only through their `index.ts`.

## Peer dependencies

None beyond Node built-ins. Depends on the `ffmpeg` slice; the binaries must be on `PATH`.

## Configuration

None. Counts, intervals and timeouts are parameters.

## Extension-point catalog

None. The slice exposes functions and data shapes, not extension points.
