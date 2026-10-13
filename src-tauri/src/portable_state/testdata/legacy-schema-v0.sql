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
