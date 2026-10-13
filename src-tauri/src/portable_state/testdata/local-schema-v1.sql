-- Fully synthetic v1: deleted, never-bound, bound-but-missing books.
-- Six-table portable database before directory import; all data is synthetic.
CREATE TABLE book_meta (hash TEXT PRIMARY KEY NOT NULL,
                 json TEXT NOT NULL);
CREATE TABLE progress (hash TEXT PRIMARY KEY NOT NULL,
                 json TEXT NOT NULL,
                 local_revision INTEGER NOT NULL);
CREATE TABLE annotations (hash TEXT NOT NULL,
                 kind TEXT NOT NULL,
                 id TEXT NOT NULL,
                 json TEXT NOT NULL,
                 local_revision INTEGER NOT NULL,
                 PRIMARY KEY (hash, kind, id));
CREATE TABLE organization (key TEXT PRIMARY KEY NOT NULL,
                 json TEXT NOT NULL);
CREATE TABLE device_bindings (hash TEXT PRIMARY KEY NOT NULL,
                 json TEXT NOT NULL);
CREATE TABLE local_meta (key TEXT PRIMARY KEY NOT NULL,
                 json TEXT NOT NULL);
INSERT INTO local_meta VALUES ('installationId', '"00000000-0000-4000-8000-000000000001"');
INSERT INTO local_meta VALUES ('counter', '7');

CREATE TABLE directory_bindings (directory_key TEXT PRIMARY KEY NOT NULL,
                 folder_id TEXT NOT NULL);
PRAGMA user_version=1;
INSERT INTO book_meta VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','{"value":{"title":"Deleted","creator":"Synthetic","fileName":"synthetic.epub","addedAtMs":1},"stamp":{"deviceId":"00000000-0000-4000-8000-000000000001","counter":2}}');
INSERT INTO progress VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','{"versions":[{"stamp":{"deviceId":"00000000-0000-4000-8000-000000000001","counter":2},"clock":{"00000000-0000-4000-8000-000000000001":2},"value":{"locator":{"locatorVersion":1,"chapterPath":"Text/c.xhtml","spineIndexHint":0,"target":{"kind":"chapter-start"}},"progressPctHint":20},"updatedAtMs":2}]}',2);
INSERT INTO annotations VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','bookmark','00000000-0000-4000-8000-000000000020','{"versions":[],"deleted":{"deviceId":"00000000-0000-4000-8000-000000000001","counter":2}}',2);
INSERT INTO annotations VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','note','00000000-0000-4000-8000-000000000020','{"versions":[],"deleted":{"deviceId":"00000000-0000-4000-8000-000000000001","counter":2}}',2);
INSERT INTO book_meta VALUES ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','{"value":{"title":"Never bound","creator":"Synthetic","fileName":"synthetic.epub","addedAtMs":1},"stamp":{"deviceId":"00000000-0000-4000-8000-000000000001","counter":2}}');
INSERT INTO progress VALUES ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','{"versions":[{"stamp":{"deviceId":"00000000-0000-4000-8000-000000000001","counter":2},"clock":{"00000000-0000-4000-8000-000000000001":2},"value":{"locator":{"locatorVersion":1,"chapterPath":"Text/c.xhtml","spineIndexHint":0,"target":{"kind":"chapter-start"}},"progressPctHint":20},"updatedAtMs":2}]}',2);
INSERT INTO annotations VALUES ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','bookmark','00000000-0000-4000-8000-000000000020','{"versions":[],"deleted":{"deviceId":"00000000-0000-4000-8000-000000000001","counter":2}}',2);
INSERT INTO annotations VALUES ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','note','00000000-0000-4000-8000-000000000020','{"versions":[],"deleted":{"deviceId":"00000000-0000-4000-8000-000000000001","counter":2}}',2);
INSERT INTO book_meta VALUES ('cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','{"value":{"title":"Bound missing source","creator":"Synthetic","fileName":"synthetic.epub","addedAtMs":1},"stamp":{"deviceId":"00000000-0000-4000-8000-000000000001","counter":2}}');
INSERT INTO progress VALUES ('cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','{"versions":[{"stamp":{"deviceId":"00000000-0000-4000-8000-000000000001","counter":2},"clock":{"00000000-0000-4000-8000-000000000001":2},"value":{"locator":{"locatorVersion":1,"chapterPath":"Text/c.xhtml","spineIndexHint":0,"target":{"kind":"chapter-start"}},"progressPctHint":20},"updatedAtMs":2}]}',2);
INSERT INTO annotations VALUES ('cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','bookmark','00000000-0000-4000-8000-000000000020','{"versions":[],"deleted":{"deviceId":"00000000-0000-4000-8000-000000000001","counter":2}}',2);
INSERT INTO annotations VALUES ('cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','note','00000000-0000-4000-8000-000000000020','{"versions":[],"deleted":{"deviceId":"00000000-0000-4000-8000-000000000001","counter":2}}',2);
INSERT INTO organization VALUES ('state','{"schemaVersion":1,"folders":{"00000000-0000-4000-8000-000000000010":{"name":{"value":"Synthetic folder","stamp":{"deviceId":"00000000-0000-4000-8000-000000000001","counter":2}}}},"books":{"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":{"favorite":{"value":true,"stamp":{"deviceId":"00000000-0000-4000-8000-000000000001","counter":2}},"folderId":{"value":"00000000-0000-4000-8000-000000000010","stamp":{"deviceId":"00000000-0000-4000-8000-000000000001","counter":2}}},"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb":{"favorite":{"value":true,"stamp":{"deviceId":"00000000-0000-4000-8000-000000000001","counter":2}},"folderId":{"value":"00000000-0000-4000-8000-000000000010","stamp":{"deviceId":"00000000-0000-4000-8000-000000000001","counter":2}}},"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc":{"favorite":{"value":true,"stamp":{"deviceId":"00000000-0000-4000-8000-000000000001","counter":2}},"folderId":{"value":"00000000-0000-4000-8000-000000000010","stamp":{"deviceId":"00000000-0000-4000-8000-000000000001","counter":2}}}}}');
INSERT INTO device_bindings VALUES ('cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','{"contentHash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","canonicalSourcePath":"/synthetic/missing.epub","storageKind":"linked"}');
INSERT INTO local_meta VALUES ('visibleHashes','["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]');
INSERT INTO local_meta VALUES ('isNewHashes','["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"]');
