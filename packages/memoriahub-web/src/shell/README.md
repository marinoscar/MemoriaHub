# shell

The domain's navigation and settings data: the route prefixes its pages own and its settings cards, for the app's registries to spread.

## Purpose and scope

The settings hub, the rail and the top bar are the platform's (`@marinoscar/platform-web/shell`, `settings/ui`); the app owns the registries (`apps/web/src/config/*`). This slice exports what the domain contributes to them as **data**: `memoriahubDestinationRoutes` (the prefixes the packaged pages own) and `memoriahubUserSettingsCards` (the `Media sync` card with its exact permission string). Each later J11 part adds the cards and prefixes of the slice it moves. The package adds no breakpoint read: the five coupled breakpoint gates stay in the platform shell. Status: experimental until the first published release.

## Entry point

`@marinoscar/memoriahub-web/shell`. It imports the `core`, `brand` and `media` slices through their entries.

## Peer dependencies

`react`, `@mui/icons-material` (the card icons).

## Configuration

None. The app spreads the arrays into its registries, keeping the registry's append order and never inserting between existing cards (Settings UI Pattern).

## Extension-point catalog

`MemoriahubSettingsCard` is the shape a card takes; a host may spread, filter or wrap the arrays.
