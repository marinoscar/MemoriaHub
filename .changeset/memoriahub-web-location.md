---
"@marinoscar/memoriahub-web": minor
---

Add the `location` slice to `@marinoscar/memoriahub-web` (private): the geo provider clients and `useGeoSettings`, the Location Grouping clients (`listLocationGroups`, `mergeLocationGroups`, `rebuildLocationGroups`, ...), `GeoSettingsPage`, `LocationGroupsSettingsPage`, `LocationGroupEditorDialog` and `MergeLocationsDialog`. The host binds the media slice's `media.mergeLocationsDialog` slot to the packaged dialog. The settings document gains the `geo` and `locationGrouping` namespaces (`MemoriahubGeoSettings`), the request options gain `body` (a `DELETE` that carries one) and a saved secret's `hint` may be `null`.
