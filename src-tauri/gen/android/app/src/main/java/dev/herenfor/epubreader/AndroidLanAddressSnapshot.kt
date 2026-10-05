package dev.herenfor.epubreader

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import java.net.Inet4Address

/**
 * One immutable platform fact. The shared Rust policy core decides which
 * address becomes the default host; Kotlin never ranks candidates.
 */
internal data class LanAddressFact(
    val address: String,
    val interfaceId: String,
    val label: String,
    val kind: String,
    val up: Boolean,
    val excluded: Boolean,
)

/**
 * One on-demand LAN address snapshot.
 *
 * Call this only when a QR code is created or the user refreshes; there is no
 * polling and no app-wide network binding. `getAllNetworks` is deprecated
 * because it has no change callback, but this finite snapshot keeps the
 * implementation simple and Rust still validates the eventual bind address.
 *
 * Requires only ACCESS_NETWORK_STATE. It never reads SSID/BSSID/MAC and never
 * asks for location or Wi-Fi scan permissions.
 */
@Suppress("DEPRECATION")
internal fun lanAddressSnapshot(context: Context): List<LanAddressFact> {
    val manager = context.getSystemService(ConnectivityManager::class.java) ?: return emptyList()
    return manager.allNetworks.flatMap { network ->
        val capabilities = manager.getNetworkCapabilities(network) ?: return@flatMap emptyList()
        // A VPN may also carry the underlying Wi-Fi transport, so VPN must be
        // rejected before transport kind is inspected.
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN) ||
            !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
        ) {
            return@flatMap emptyList()
        }
        val kind = when {
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> return@flatMap emptyList()
        }
        // Do not require INTERNET or VALIDATED: an offline router can still
        // carry local traffic between the two devices.
        val properties = manager.getLinkProperties(network) ?: return@flatMap emptyList()
        val interfaceName = properties.interfaceName ?: return@flatMap emptyList()
        properties.linkAddresses.mapNotNull { link ->
            val ip = link.address as? Inet4Address ?: return@mapNotNull null
            if (ip.isAnyLocalAddress || ip.isLoopbackAddress || ip.isMulticastAddress) {
                return@mapNotNull null
            }
            LanAddressFact(
                address = ip.hostAddress ?: return@mapNotNull null,
                interfaceId = interfaceName,
                label = if (kind == "wifi") "Wi-Fi" else "以太网",
                kind = kind,
                up = true,
                excluded = false,
            )
        }
    }
}
