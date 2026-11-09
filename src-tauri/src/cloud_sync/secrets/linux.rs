//! Linux Secret Service backend for the WebDAV app password.
//!
//! The password lives in the desktop keyring, addressed by the application
//! identifier plus the cloud connection UUID. This is deliberately not a
//! file/environment fallback. The service is reached over the session D-Bus;
//! every call here is blocking and must remain on a worker thread.
use super::*;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use zbus::blocking::Connection;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Type, Value};

const SERVICE_NAME: &str = "org.freedesktop.secrets";
const DEFAULT_COLLECTION: &str = "default";
const APPLICATION_ATTRIBUTE: &str = "application";
const SERVICE_ATTRIBUTE: &str = "service";
const CONNECTION_ATTRIBUTE: &str = "connectionId";
const LABEL_ATTRIBUTE: &str = "org.freedesktop.Secret.Item.Label";
const ATTRIBUTES_ATTRIBUTE: &str = "org.freedesktop.Secret.Item.Attributes";
const SERVICE_ATTRIBUTE_VALUE: &str = "EPUBReader-WebDAV";
const CONTENT_TYPE: &str = "text/plain";
const RETRY_AFTER: Duration = Duration::from_secs(30);

static READY: AtomicBool = AtomicBool::new(false);
static LAST_PROBE: Mutex<Option<(Instant, bool)>> = Mutex::new(None);

fn failure() -> Failure {
    Failure::new(FailureCode::CredentialUnavailable)
}

fn attributes(identifier: &str, connection_id: &str) -> HashMap<String, String> {
    HashMap::from([
        (APPLICATION_ATTRIBUTE.to_string(), identifier.to_string()),
        (
            SERVICE_ATTRIBUTE.to_string(),
            SERVICE_ATTRIBUTE_VALUE.to_string(),
        ),
        (CONNECTION_ATTRIBUTE.to_string(), connection_id.to_string()),
    ])
}

fn label(connection_id: &str) -> String {
    format!("EPUBReader WebDAV ({connection_id})")
}

fn valid_connection_id(connection_id: &str) -> bool {
    !connection_id.is_empty()
        && connection_id.len() <= 128
        && !connection_id.chars().any(char::is_control)
}

#[derive(serde::Serialize, serde::Deserialize, Type)]
struct Secret {
    session: OwnedObjectPath,
    parameters: Vec<u8>,
    value: Vec<u8>,
    content_type: String,
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.value.fill(0);
        self.parameters.fill(0);
    }
}

#[zbus::proxy(
    interface = "org.freedesktop.Secret.Service",
    default_service = "org.freedesktop.secrets",
    default_path = "/org/freedesktop/secrets"
)]
trait SecretService {
    fn open_session(
        &self,
        algorithm: &str,
        input: &Value<'_>,
    ) -> zbus::Result<(OwnedValue, OwnedObjectPath)>;
    fn read_alias(&self, name: &str) -> zbus::Result<OwnedObjectPath>;
}

#[zbus::proxy(
    interface = "org.freedesktop.Secret.Collection",
    default_service = "org.freedesktop.secrets"
)]
trait SecretCollection {
    fn create_item(
        &self,
        properties: HashMap<&str, Value<'_>>,
        secret: Secret,
        replace: bool,
    ) -> zbus::Result<(OwnedObjectPath, OwnedObjectPath)>;
    fn delete(&self) -> zbus::Result<OwnedObjectPath>;
    fn search_items(
        &self,
        attributes: HashMap<String, String>,
    ) -> zbus::Result<Vec<OwnedObjectPath>>;
    #[zbus(property)]
    fn locked(&self) -> zbus::Result<bool>;
}

#[zbus::proxy(
    interface = "org.freedesktop.Secret.Item",
    default_service = "org.freedesktop.secrets"
)]
trait SecretItem {
    fn get_secret(&self, session: OwnedObjectPath) -> zbus::Result<Secret>;
    fn set_secret(&self, secret: Secret) -> zbus::Result<()>;
    fn delete(&self) -> zbus::Result<OwnedObjectPath>;
}

fn mark_unavailable() {
    READY.store(false, Ordering::Release);
}

fn connect() -> Result<Connection> {
    Connection::session().map_err(|_| {
        mark_unavailable();
        failure()
    })
}

fn name_has_owner(connection: &Connection) -> bool {
    let Ok(reply) = connection.call_method(
        Some("org.freedesktop.DBus"),
        "/org/freedesktop/DBus",
        Some("org.freedesktop.DBus"),
        "NameHasOwner",
        &SERVICE_NAME,
    ) else {
        return false;
    };
    matches!(reply.body().deserialize::<bool>(), Ok(true))
}

fn default_collection(connection: &Connection) -> Result<OwnedObjectPath> {
    if !name_has_owner(connection) {
        mark_unavailable();
        return Err(failure());
    }
    let service = SecretServiceProxyBlocking::new(connection).map_err(|_| failure())?;
    let collection = service.read_alias(DEFAULT_COLLECTION).map_err(|_| {
        mark_unavailable();
        failure()
    })?;
    if collection.as_str() == "/" {
        mark_unavailable();
        return Err(failure());
    }
    Ok(collection)
}

fn collection_proxy(
    connection: &Connection,
    path: OwnedObjectPath,
) -> Result<SecretCollectionProxyBlocking<'_>> {
    SecretCollectionProxyBlocking::new(connection, path).map_err(|_| failure())
}

fn open_session(connection: &Connection) -> Result<(OwnedObjectPath, OwnedObjectPath)> {
    let collection = default_collection(connection)?;
    let service = SecretServiceProxyBlocking::new(connection).map_err(|_| failure())?;
    let (_, session) = service
        .open_session("plain", &Value::from(""))
        .map_err(|_| {
            mark_unavailable();
            failure()
        })?;
    if session.as_str() == "/" {
        mark_unavailable();
        return Err(failure());
    }
    Ok((collection, session))
}

fn secret(session: &OwnedObjectPath, password: &str) -> Secret {
    Secret {
        session: session.clone(),
        parameters: Vec::new(),
        value: password.as_bytes().to_vec(),
        content_type: CONTENT_TYPE.to_string(),
    }
}

fn delete_item(connection: &Connection, path: OwnedObjectPath) -> Result<()> {
    let item = SecretItemProxyBlocking::new(connection, path).map_err(|_| failure())?;
    let prompt = item.delete().map_err(|_| failure())?;
    if prompt.as_str() == "/" {
        Ok(())
    } else {
        Err(failure())
    }
}

pub fn available() -> bool {
    READY.load(Ordering::Acquire)
}

/// Probe the service without unlocking it or causing an unlock prompt. A
/// failed probe is cached briefly; explicit commands use `prepare_force` to
/// retry immediately after the user starts/unlocks the keyring.
fn probe() -> bool {
    let Ok(connection) = connect() else {
        return false;
    };
    default_collection(&connection).is_ok()
}

pub fn prepare(force: bool) -> bool {
    if READY.load(Ordering::Acquire) {
        return true;
    }
    let mut last = LAST_PROBE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !force {
        if let Some((at, false)) = last.as_ref() {
            if at.elapsed() < RETRY_AFTER {
                return false;
            }
        }
    }
    let ok = probe();
    *last = Some((Instant::now(), ok));
    if ok {
        READY.store(true, Ordering::Release);
    }
    ok
}

pub fn save<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    connection_id: &str,
    password: &str,
) -> Result<()> {
    if password.is_empty() || password.len() > 2560 || !valid_connection_id(connection_id) {
        return Err(Failure::new(FailureCode::InvalidConfig));
    }
    let identifier = &app.config().identifier;
    let save_attrs = attributes(identifier, connection_id);
    let connection = connect()?;
    let (collection_path, session) = open_session(&connection)?;
    let collection = collection_proxy(&connection, collection_path)?;
    if collection.locked().map_err(|_| failure())? {
        return Err(failure());
    }
    let existing = collection
        .search_items(save_attrs.clone())
        .map_err(|_| failure())?;
    for extra in existing.iter().skip(1) {
        delete_item(&connection, extra.clone())?;
    }
    let value = secret(&session, password);
    if let Some(item) = existing.first() {
        let item =
            SecretItemProxyBlocking::new(&connection, item.clone()).map_err(|_| failure())?;
        item.set_secret(value).map_err(|_| failure())?;
        return Ok(());
    }
    let mut properties: HashMap<&str, Value<'_>> = HashMap::new();
    properties.insert(LABEL_ATTRIBUTE, Value::from(label(connection_id)));
    properties.insert(ATTRIBUTES_ATTRIBUTE, Value::from(save_attrs));
    let (_, prompt) = collection
        .create_item(properties, value, false)
        .map_err(|_| failure())?;
    if prompt.as_str() != "/" {
        return Err(failure());
    }
    Ok(())
}

pub fn load<R: tauri::Runtime>(app: &tauri::AppHandle<R>, connection_id: &str) -> Result<String> {
    if !valid_connection_id(connection_id) {
        return Err(Failure::new(FailureCode::InvalidConfig));
    }
    let identifier = &app.config().identifier;
    let attrs = attributes(identifier, connection_id);
    let connection = connect()?;
    let (collection_path, session) = open_session(&connection)?;
    let collection = collection_proxy(&connection, collection_path)?;
    if collection.locked().map_err(|_| failure())? {
        return Err(failure());
    }
    let items = collection.search_items(attrs).map_err(|_| failure())?;
    let item_path = items.first().cloned().ok_or_else(failure)?;
    let item = SecretItemProxyBlocking::new(&connection, item_path).map_err(|_| failure())?;
    let mut value = item.get_secret(session).map_err(|_| failure())?;
    if value.content_type != CONTENT_TYPE || value.value.is_empty() {
        return Err(failure());
    }
    String::from_utf8(std::mem::take(&mut value.value)).map_err(|_| failure())
}

pub fn delete<R: tauri::Runtime>(app: &tauri::AppHandle<R>, connection_id: &str) -> Result<()> {
    if !valid_connection_id(connection_id) {
        return Err(Failure::new(FailureCode::InvalidConfig));
    }
    let identifier = &app.config().identifier;
    let attrs = attributes(identifier, connection_id);
    let connection = connect()?;
    let collection_path = default_collection(&connection)?;
    let collection = collection_proxy(&connection, collection_path)?;
    if collection.locked().map_err(|_| failure())? {
        return Err(failure());
    }
    let items = collection.search_items(attrs).map_err(|_| failure())?;
    for item in items {
        delete_item(&connection, item)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_matches_the_secret_service_struct_signature() {
        assert_eq!(Secret::SIGNATURE.to_string(), "(oayays)");
    }

    #[test]
    fn attributes_are_scoped_by_application_and_connection() {
        let first = attributes("dev.herenfor.epubreader", "connection-a");
        let second = attributes("dev.herenfor.epubreader", "connection-b");
        assert_eq!(first[APPLICATION_ATTRIBUTE], "dev.herenfor.epubreader");
        assert_eq!(first[SERVICE_ATTRIBUTE], SERVICE_ATTRIBUTE_VALUE);
        assert_eq!(first[CONNECTION_ATTRIBUTE], "connection-a");
        assert_ne!(first[CONNECTION_ATTRIBUTE], second[CONNECTION_ATTRIBUTE]);
        assert_eq!(first[SERVICE_ATTRIBUTE], second[SERVICE_ATTRIBUTE]);
    }

    #[test]
    fn labels_are_derived_from_the_connection_not_the_secret() {
        assert_eq!(label("connection-a"), "EPUBReader WebDAV (connection-a)");
        assert!(!label("connection-a").contains("secret"));
    }

    #[test]
    fn missing_service_or_item_is_reported_as_credential_unavailable() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let handle = app.handle();
        let failure = load(handle, "00000000-0000-4000-8000-000000000399").unwrap_err();
        assert_eq!(failure.code, FailureCode::CredentialUnavailable);
    }

    #[test]
    fn invalid_connection_ids_and_empty_passwords_are_rejected_before_dbus() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let handle = app.handle();
        assert_eq!(
            save(handle, "", "secret").unwrap_err().code,
            FailureCode::InvalidConfig
        );
        assert_eq!(
            save(handle, "connection-a", "").unwrap_err().code,
            FailureCode::InvalidConfig
        );
        assert_eq!(
            load(handle, "").unwrap_err().code,
            FailureCode::InvalidConfig
        );
        assert_eq!(
            delete(handle, "").unwrap_err().code,
            FailureCode::InvalidConfig
        );
    }
}
