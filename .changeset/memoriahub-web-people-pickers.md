---
"@marinoscar/memoriahub-web": minor
---

Move the four people pickers into the `people` slice of `@marinoscar/memoriahub-web` (private): `PersonMultiSelect`, `AlbumPeopleDialog`, `SearchPeopleExplore` and `WorkflowPersonSelect` are exports of `people/ui`. The `search` and `workflows` slices now import `people` and use the pickers directly, so `SEARCH_PEOPLE_EXPLORE_SLOT`, `SearchPeopleExploreSlot`, `WORKFLOW_PERSON_SELECT_SLOT` and `WorkflowPersonSelectSlot` are removed (the web edition registered them unconditionally, so nothing changes for users). `media.albumPeopleDialog` and `media.personMultiSelect` stay host slots, because `people` imports `media`; the web app binds them to the packaged components.
