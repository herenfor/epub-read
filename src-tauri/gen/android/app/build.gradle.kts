import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Release signing comes from a properties file outside every repository
// (scripts/build-android.sh passes its path); release builds fail without it.
val releaseSigning = System.getenv("EPUB_READER_SIGNING_PROPERTIES")
    ?.takeIf { it.isNotBlank() && file(it).exists() }
    ?.let { path -> Properties().apply { file(path).inputStream().use { load(it) } } }

val optimizedDev = System.getenv("EPUB_READER_OPTIMIZED_DEV") == "1"
// Update test builds install as their own app so an in-app upgrade can be
// tried without touching the release or everyday Dev install.
val updateTest = System.getenv("EPUB_READER_UPDATE_TEST") == "1"

android {
    compileSdk = 36
    // Use the same NDK as build-android.sh, including its native strip tool.
    ndkVersion = System.getenv("ANDROID_NDK_VERSION") ?: "28.2.13676358"
    ndkPath = System.getenv("NDK_HOME")
    namespace = "dev.herenfor.epubreader"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = if (updateTest) "dev.herenfor.epubreader.updatetest" else "dev.herenfor.epubreader"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        if (releaseSigning != null) {
            create("release") {
                storeFile = file(releaseSigning.getProperty("storeFile"))
                storePassword = releaseSigning.getProperty("storePassword")
                keyAlias = releaseSigning.getProperty("keyAlias")
                keyPassword = releaseSigning.getProperty("keyPassword")
            }
        }
    }
    buildTypes {
        // The Tauri CLI writes applicationIdSuffix from
        // bundle.android.debugApplicationIdSuffix in tauri.android.conf.json,
        // so development builds install next to the release app.
        getByName("debug") {
            applicationIdSuffix = ".debug"
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            // Keep Dev inspection; --optimized-dev also removes local Rust symbols
            // and enables the release shrinker without changing this app's identity.
            isJniDebuggable = false
            isMinifyEnabled = optimizedDev
            if (optimizedDev) {
                proguardFiles(
                    *fileTree(".") { include("**/*.pro") }
                        .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                        .toList().toTypedArray()
                )
            }
        }
        getByName("release") {
            signingConfig = signingConfigs.findByName("release")
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

// WebDAV sync checks HTTPS certificates with Android's own verifier through
// rustls-platform-verifier. Its small Kotlin part ships inside that Rust crate
// as a local Maven repository; cargo metadata finds the locked copy.
val rustlsPlatformVerifierMaven: File by lazy {
    val metadata = providers.exec {
        workingDir = rootProject.projectDir
        commandLine(
            "cargo", "metadata", "--format-version", "1",
            "--filter-platform", "aarch64-linux-android",
            "--manifest-path", rootProject.file("../../Cargo.toml").path,
        )
    }.standardOutput.asText.get()
    @Suppress("UNCHECKED_CAST")
    val packages = (groovy.json.JsonSlurper().parseText(metadata) as Map<String, Any?>)["packages"] as List<Map<String, Any?>>
    val manifest = packages.first { it["name"] == "rustls-platform-verifier-android" }["manifest_path"] as String
    File(File(manifest).parentFile, "maven")
}

repositories {
    maven {
        url = uri(rustlsPlatformVerifierMaven)
        metadataSources { mavenPom() }
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    implementation("rustls:rustls-platform-verifier:0.1.1")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

gradle.taskGraph.whenReady {
    if (releaseSigning == null && allTasks.any { it.project == project && it.name.matches(Regex("(package|bundle).*Release")) }) {
        throw GradleException("Release builds need EPUB_READER_SIGNING_PROPERTIES; run scripts/build-android.sh build --release")
    }
}

apply(from = "tauri.build.gradle.kts")
