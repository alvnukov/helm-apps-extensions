package io.github.alvnukov.helmapps.lsp

import com.intellij.openapi.vfs.VirtualFile
import java.nio.charset.StandardCharsets

object HelmAppsFileDetector {
  private const val MAX_READ_BYTES = 128 * 1024
  private val yamlExtensions = setOf("yaml", "yml")
  private val topLevelGroupRegex = Regex("(?m)^apps-[A-Za-z0-9-]+:\\s*$")
  private val globalRegex = Regex("(?m)^global:\\s*$")

  fun isHelmAppsValuesFile(file: VirtualFile): Boolean {
    if (file.isDirectory || !file.isValid) {
      return false
    }
    val ext = file.extension?.lowercase() ?: return false
    if (ext !in yamlExtensions) {
      return false
    }
    val name = file.nameWithoutExtension.lowercase()
    if (!name.startsWith("values")) {
      return false
    }
    val text = readTextPreview(file) ?: return false
    return globalRegex.containsMatchIn(text) && topLevelGroupRegex.containsMatchIn(text)
  }

  private fun readTextPreview(file: VirtualFile): String? {
    return runCatching {
      file.inputStream.use { input ->
        val bytes = input.readNBytes(MAX_READ_BYTES)
        String(bytes, StandardCharsets.UTF_8)
      }
    }.getOrNull()
  }
}
