use super::*;
use rusqlite::{OpenFlags, TransactionBehavior};

fn target_meta<T: DeserializeOwned>(
    connection: &Connection,
    key: &str,
) -> PortableResult<Option<T>> {
    let raw: Option<String> = connection
        .query_row(
            "SELECT json FROM target.local_meta WHERE key=?1",
            [key],
            |row| row.get(0),
        )
        .optional()?;
    raw.map(|raw| parse_json(&raw, key)).transpose()
}

fn write_target_meta<T: Serialize>(
    connection: &Connection,
    key: &str,
    value: &T,
) -> PortableResult<()> {
    connection.execute(
        "INSERT INTO target.local_meta(key,json) VALUES(?1,?2)
         ON CONFLICT(key) DO UPDATE SET json=excluded.json",
        params![key, serialize_json(value)?],
    )?;
    Ok(())
}

impl PortableStore {
    /// Called with both repositories exclusively borrowed. A short-lived
    /// connection ensures the attachment never becomes visible to other code.
    pub(crate) fn move_local_book(
        &mut self,
        destination: &mut PortableStore,
        hash: &str,
        binding: &str,
        still_authorized: impl FnOnce() -> bool,
    ) -> PortableResult<()> {
        if !dto::valid_content_hash(hash) {
            return Err(PortableError::invalid_entity("无效的书籍内容指纹"));
        }
        let source = self
            .connection
            .path()
            .filter(|path| !path.is_empty())
            .ok_or_else(|| PortableError::storage_error("源资料库必须是本机文件"))?;
        let target = destination
            .connection
            .path()
            .filter(|path| !path.is_empty() && *path != source)
            .ok_or_else(|| PortableError::storage_error("目标资料库必须是另一个本机文件"))?;
        let mut connection =
            Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        connection.execute("ATTACH DATABASE ?1 AS target", [target])?;
        // SQLite only guarantees cross-file crash atomicity with rollback
        // journals. Do not change an existing library's journal settings.
        for database in ["main", "target"] {
            let mode: String =
                connection.query_row(&format!("PRAGMA {database}.journal_mode"), [], |row| {
                    row.get(0)
                })?;
            if !mode.eq_ignore_ascii_case("delete") {
                return Err(PortableError::storage_error(
                    "当前数据库日志模式不支持安全移动",
                ));
            }
        }
        connection
            .execute_batch("PRAGMA main.synchronous=FULL; PRAGMA target.synchronous=FULL;")?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let duplicate: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM target.book_meta WHERE hash=?1)",
            [hash],
            |row| row.get(0),
        )?;
        if duplicate {
            return Err(PortableError::invalid_entity(
                "目标书架已有同一本书，未移动",
            ));
        }
        let inserted = tx.execute(
            "INSERT INTO target.book_meta SELECT * FROM main.book_meta WHERE hash=?1",
            [hash],
        )?;
        if inserted != 1 {
            return Err(PortableError::invalid_entity("源书架中没有这本书"));
        }
        for table in ["progress", "annotations"] {
            tx.execute(
                &format!("INSERT INTO target.{table} SELECT * FROM main.{table} WHERE hash=?1"),
                [hash],
            )?;
        }
        tx.execute(
            "INSERT INTO target.device_bindings(hash,json) VALUES(?1,?2)",
            params![hash, binding],
        )?;
        let mut visible: BTreeSet<String> =
            target_meta(&tx, KEY_LOCAL_VISIBLE)?.unwrap_or_default();
        visible.insert(hash.to_owned());
        write_target_meta(&tx, KEY_LOCAL_VISIBLE, &visible)?;
        let mut new: BTreeSet<String> = target_meta(&tx, KEY_LOCAL_IS_NEW)?.unwrap_or_default();
        if load_local_is_new_hashes(&tx)?.contains(hash) {
            new.insert(hash.to_owned());
        }
        write_target_meta(&tx, KEY_LOCAL_IS_NEW, &new)?;
        let counter = load_counter(&tx)?.max(target_meta::<u64>(&tx, KEY_COUNTER)?.unwrap_or(0));
        write_target_meta(&tx, KEY_COUNTER, &counter)?;

        // Folder ids belong to their original shelf. Only the book-level
        // favorite follows the book.
        if let Some(favorite) = load_organization(&tx)?
            .books
            .remove(hash)
            .and_then(|entry| entry.favorite)
        {
            let raw: Option<String> = tx
                .query_row(
                    "SELECT json FROM target.organization WHERE key='state'",
                    [],
                    |row| row.get(0),
                )
                .optional()?;
            let mut organization: LibraryOrganization = raw
                .map(|raw| parse_json(&raw, "organization"))
                .transpose()?
                .unwrap_or_else(empty_organization);
            organization.books.insert(
                hash.to_owned(),
                crate::library_organization::BookOrganization {
                    favorite: Some(favorite),
                    folder_id: None,
                },
            );
            tx.execute(
                "INSERT INTO target.organization(key,json) VALUES('state',?1)
                 ON CONFLICT(key) DO UPDATE SET json=excluded.json",
                [serialize_json(&organization)?],
            )?;
        }

        super::super::local_books::purge(&tx, &[hash.to_owned()])?;
        if !still_authorized() {
            return Err(PortableError::invalid_entity("隐私书架已锁定，未移动"));
        }
        tx.commit()?;
        self.release(ReleaseTarget::BookHash(hash.to_owned()))?;
        destination.release(ReleaseTarget::BookHash(hash.to_owned()))?;
        Ok(())
    }
}
