# tagging

AI auto-tagging on the web: the per-item tag status and re-run, the tag vocabulary clients and the page that browses the library by tag.

## Purpose and scope

`tagging/headless` carries the clients over the host's API client: the per-item status and re-run (`getMediaTagStatus`, `rerunMediaTags`, `useMediaTags`, which polls a re-run to a terminal status and then asks the caller to refresh the tags), and the vocabulary (`listTagLabels`, `createTagLabel`, `updateTagLabel`, `deleteTagLabel`, and the CSV `exportTagLabels` and `importTagLabels`, which go out of the client as raw requests to the host's API root with the host's credential). `tagging/ui` carries `TagsBrowsePage`, the explore grid of tags that opens `/media?tag=`.

Staying in the app: the admin vocabulary page (`TagsPage`) and the Tagging settings page, because they are built on the platform's data table and the app's admin page header and system-settings hook, which a host-neutral package cannot import (the data table needs a host port first); the media-detail drawer and lightbox, which call `useMediaTags` and move with the face and location slices; and the global tagging backfill call, which shares a client with the other backfills. All of them import this slice's clients.

## Entry point

`@marinoscar/memoriahub-web/tagging/headless` and `@marinoscar/memoriahub-web/tagging/ui`. The slice imports `core` and `media` through their entries.

## Peer dependencies

`react` and `react-dom` for every file; the `ui` entry adds `@mui/material`, `@mui/icons-material` and `react-router-dom`.

## Configuration

None of its own. It reads the host's API client (including its credential and `baseUrl`) and owner scope.

## Extension-point catalog

None: the slice registers no slot of its own.
