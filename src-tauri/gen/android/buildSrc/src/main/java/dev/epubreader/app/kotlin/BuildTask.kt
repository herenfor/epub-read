import java.io.File
import org.apache.tools.ant.taskdefs.condition.Os
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.logging.LogLevel
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction

open class BuildTask : DefaultTask() {
    @Input
    var rootDirRel: String? = null
    @Input
    var target: String? = null
    @Input
    var release: Boolean? = null

    @TaskAction
    fun assemble() {
        // Use the CLI the project itself installed (package.json / pnpm-lock.yaml)
        // instead of `pnpm dlx @tauri-apps/cli`, which resolves the newest published
        // CLI over the network and drifts away from the lockfile.
        // TAURI_CLI_NODE / TAURI_CLI_JS are exported by scripts/build-android.sh;
        // both have working-directory based fallbacks so a plain Android Studio or
        // `./gradlew` build keeps working without that wrapper script.
        val executable = System.getenv("TAURI_CLI_NODE")?.takeIf { it.isNotBlank() } ?: "node"
        try {
            runTauriCli(executable)
        } catch (e: Exception) {
            if (Os.isFamily(Os.FAMILY_WINDOWS)) {
                // Try different Windows-specific extensions
                val fallbacks = listOf(
                    "$executable.exe",
                    "$executable.cmd",
                    "$executable.bat",
                )

                var lastException: Exception = e
                for (fallback in fallbacks) {
                    try {
                        runTauriCli(fallback)
                        return
                    } catch (fallbackException: Exception) {
                        lastException = fallbackException
                    }
                }
                throw lastException
            } else {
                throw e;
            }
        }
    }

    fun runTauriCli(executable: String) {
        val rootDirRel = rootDirRel ?: throw GradleException("rootDirRel cannot be null")
        val target = target ?: throw GradleException("target cannot be null")
        val release = release ?: throw GradleException("release cannot be null")
        // rootDirRel points at <project>/src-tauri, which is also the CLI working dir.
        val cliWorkingDir = File(project.projectDir, rootDirRel)
        val cliScript = tauriCliScript(cliWorkingDir)
        val args = ArrayList<String>()
        args.add(cliScript.absolutePath)
        args.add("android")
        args.add("android-studio-script")
        if (project.logger.isEnabled(LogLevel.DEBUG)) {
            args.add("-vv")
        } else if (project.logger.isEnabled(LogLevel.INFO)) {
            args.add("-v")
        }
        if (release) {
            args.add("--release")
        }
        args.add("--target")
        args.add(target)

        // Printed so the build log shows which CLI this task actually executed.
        // The outer Tauri CLI runs Gradle with quiet logging, so logger.lifecycle
        // would be swallowed; task stdout is still captured at quiet level.
        println("rust: tauri CLI -> $executable ${args.joinToString(" ")}")

        project.exec {
            workingDir(cliWorkingDir)
            executable(executable)
            args(args)
        }.assertNormalExitValue()
    }

    /** Project-local CLI script, i.e. the one pinned by package.json / pnpm-lock.yaml. */
    private fun tauriCliScript(cliWorkingDir: File): File {
        val candidates = ArrayList<File>()
        System.getenv("TAURI_CLI_JS")?.takeIf { it.isNotBlank() }?.let { candidates.add(File(it)) }
        candidates.add(File(cliWorkingDir, "../node_modules/@tauri-apps/cli/tauri.js"))
        candidates.add(File(cliWorkingDir, "node_modules/@tauri-apps/cli/tauri.js"))
        // Keep the project-relative path (no canonicalization) so the log shows the
        // same location the outer CLI uses; isFile() already follows the pnpm symlink.
        return candidates.firstOrNull { it.isFile }
            ?: throw GradleException(
                "Tauri CLI script not found; run `pnpm install` in the project or set TAURI_CLI_JS. " +
                    "Looked at: " + candidates.joinToString(", ") { it.path }
            )
    }
}
