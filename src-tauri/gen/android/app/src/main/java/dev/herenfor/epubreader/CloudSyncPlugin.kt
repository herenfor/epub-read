package dev.herenfor.epubreader

import android.app.Activity
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class CloudSecretArgs {
    var connectionId: String = ""
    var secret: String? = null
}

/** Rust side of the HTTPS setup (cloud_sync/secrets/android.rs). */
object CloudSyncNative {
    @JvmStatic
    external fun initPlatformVerifier(context: Context): Boolean
}

/**
 * WebDAV sync on Android: the app password for one saved connection, and the
 * one-time HTTPS setup the Rust client needs.
 *
 * The password is sealed with AES-GCM under a key that never leaves the
 * Android Keystore; the sealed file lives in noBackupFilesDir, so neither
 * backup nor device transfer carries it (the Keystore key would not follow
 * anyway). There is no plaintext fallback: if the Keystore fails, sync is
 * unavailable and reading is unaffected. Only this small secret crosses the
 * bridge, never book data.
 */
@TauriPlugin
class CloudSyncPlugin(activity: Activity) : Plugin(activity) {
    private val context: Context = activity.applicationContext

    private fun secretsDir(): File = File(context.noBackupFilesDir, SECRETS_DIR)

    private fun secretFile(connectionId: String): File = File(secretsDir(), "$connectionId.bin")

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    private fun key(create: Boolean): SecretKey? {
        (keyStore().getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        if (!create) return null
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    /** Keystore and Rust work stay off the calling thread. */
    private fun background(invoke: Invoke, work: () -> JSObject) {
        Thread {
            try {
                invoke.resolve(work())
            } catch (error: Throwable) {
                // Never echo the secret or the cipher state; the code is enough.
                invoke.reject("cloud-sync-secret-failed")
            }
        }.start()
    }

    private fun connectionId(invoke: Invoke): String? {
        val id = invoke.parseArgs(CloudSecretArgs::class.java).connectionId
        if (!UUID_RE.matches(id)) {
            invoke.reject("invalid connection id")
            return null
        }
        return id
    }

    @Command
    fun prepare(invoke: Invoke) {
        background(invoke) {
            val ready = synchronized(LOCK) {
                if (!prepared) {
                    keyStore()
                    prepared = CloudSyncNative.initPlatformVerifier(context)
                }
                prepared
            }
            JSObject().put("ready", ready)
        }
    }

    @Command
    fun save(invoke: Invoke) {
        val id = connectionId(invoke) ?: return
        val secret = invoke.parseArgs(CloudSecretArgs::class.java).secret
        if (secret.isNullOrEmpty()) {
            invoke.reject("empty secret")
            return
        }
        background(invoke) {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, key(create = true))
            val sealed = cipher.doFinal(secret.toByteArray(Charsets.UTF_8))
            val iv = cipher.iv
            val dir = secretsDir().apply { mkdirs() }
            val temp = File(dir, "$id.tmp")
            temp.outputStream().use { out ->
                out.write(FORMAT_VERSION)
                out.write(iv.size)
                out.write(iv)
                out.write(sealed)
                out.fd.sync()
            }
            if (!temp.renameTo(secretFile(id))) {
                temp.delete()
                throw IllegalStateException("rename failed")
            }
            JSObject()
        }
    }

    @Command
    fun load(invoke: Invoke) {
        val id = connectionId(invoke) ?: return
        background(invoke) {
            val bytes = secretFile(id).readBytes()
            require(bytes.size > 2 && bytes[0].toInt() == FORMAT_VERSION)
            val ivLength = bytes[1].toInt()
            require(ivLength in 12..16 && bytes.size > 2 + ivLength)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                key(create = false) ?: throw IllegalStateException("no key"),
                GCMParameterSpec(128, bytes, 2, ivLength)
            )
            val plain = cipher.doFinal(bytes, 2 + ivLength, bytes.size - 2 - ivLength)
            JSObject().put("secret", String(plain, Charsets.UTF_8))
        }
    }

    /** Removing a connection that has no stored secret is not an error. */
    @Command
    fun remove(invoke: Invoke) {
        val id = connectionId(invoke) ?: return
        background(invoke) {
            val file = secretFile(id)
            if (file.exists() && !file.delete()) throw IllegalStateException("delete failed")
            JSObject()
        }
    }

    companion object {
        private const val KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "epub-reader-cloud-sync-v1"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val SECRETS_DIR = "cloud-sync-secrets"
        private const val FORMAT_VERSION = 1
        private val UUID_RE = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
        private val LOCK = Any()
        @Volatile private var prepared = false
    }
}
