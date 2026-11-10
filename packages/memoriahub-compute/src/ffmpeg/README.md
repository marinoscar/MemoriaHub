# ffmpeg

The thin in-house ffmpeg and ffprobe process wrapper: argv builders, the runner with a hard SIGKILL timeout, ffprobe output parsing.

## Purpose and scope

The thin in-house ffmpeg and ffprobe process wrapper: argv builders, the runner with a hard SIGKILL timeout, ffprobe output parsing. One implementation, so the server and every worker node invoke ffmpeg with byte-identical arguments.

Pure compute only: no framework import, no environment read, no persistence. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-compute/ffmpeg`. `ffmpeg/index.ts`: `runFfmpeg`, `runFfprobe`, `buildFrameExtractionArgs`, `buildAudioLeadArgs`, `buildFfprobeArgs`, `parseFfprobeOutput`, `resolveFfmpegPath`, `resolveFfprobePath`. Other slices are imported only through their `index.ts`.

## Peer dependencies

None beyond Node built-ins. The `ffmpeg` and `ffprobe` binaries must be on `PATH` at run time (a host concern).

## Configuration

None. The timeout is a parameter of each call.

## Extension-point catalog

None. The slice exposes functions and data shapes, not extension points.
