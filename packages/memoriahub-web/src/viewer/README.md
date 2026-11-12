# viewer

The media viewer on the web: the full-screen lightbox, the properties drawer and the video player.

## Purpose and scope

`viewer/headless` carries the name of the one slot the slice reads (`VIEWER_LINK_SHARE_PANEL_SLOT`). `viewer/ui` carries `MediaLightbox` (browse, play, slideshow, favorite, download, edit the orientation, enhance, share), `MediaDetailDrawer` (metadata and its editing, tags, faces, location suggestions, the AI enhancement and the inline public link), `VideoPlayer` (Vidstack) and the `LinkSharePanel` host slot.

The viewer uses the `people`, `tagging`, `review` and `enhancement` hooks and components, so it is a slice of its own over them. The `media` pages open it through the `media.lightbox` and `media.detailDrawer` host slots (`media` cannot import the viewer back, because the viewer imports `media`); the host binds both to these components. The public-link controls are the platform's sharing slice, reached through the host slot `viewer.linkSharePanel` (a plain node, never a modal, because the drawer and the lightbox are modals themselves).

## Entry point

`@marinoscar/memoriahub-web/viewer/headless` and `@marinoscar/memoriahub-web/viewer/ui`. The slice imports `core`, `media`, `people`, `tagging`, `review` and `enhancement` through their entries.

## Peer dependencies

`react` and `react-dom` for every file; the `ui` entry adds `@mui/material`, `@mui/icons-material`, `react-router-dom` and `@vidstack/react` (the player and its two stylesheets).

## Configuration

None of its own. It reads the host's API client, permissions, feature flags and slots.

## Extension-point catalog

`LinkSharePanel` is the host slot the viewer reads: the host registers the inline public-link controls under `viewer.linkSharePanel`; a host that registers none renders the viewer without them.
