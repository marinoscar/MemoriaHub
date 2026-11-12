---
"@marinoscar/memoriahub-api": patch
---

`describeMemoriahubPortsConformance` (`@marinoscar/memoriahub-api/testing`) gains the `sharedWhereSql` option and the grant fixture's optional `matching` and `scopeItemId`: three access rules that run the `sharedWhere` fragment and the owner-scope list as SQL over the host's real records (the fragment selects exactly the granted record, a read grant yields none for write access, a member, a grantee and an outsider each see only their own records). Without the option the kit is unchanged.
