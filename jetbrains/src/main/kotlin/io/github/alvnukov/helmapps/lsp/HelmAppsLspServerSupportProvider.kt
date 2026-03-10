package io.github.alvnukov.helmapps.lsp

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.openapi.diagnostic.thisLogger
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.platform.lsp.api.LspServer
import com.intellij.platform.lsp.api.LspServerSupportProvider
import com.intellij.platform.lsp.api.LspServerWidgetItem
import com.intellij.platform.lsp.api.ProjectWideLspServerDescriptor
import com.intellij.util.execution.ParametersListUtil
import io.github.alvnukov.helmapps.HelmAppsIcons
import io.github.alvnukov.helmapps.settings.HelmAppsConfigurable
import io.github.alvnukov.helmapps.settings.HelmAppsSettingsService

class HelmAppsLspServerSupportProvider : LspServerSupportProvider {
  override fun fileOpened(project: Project, file: VirtualFile, serverStarter: LspServerSupportProvider.LspServerStarter) {
    if (!HelmAppsFileDetector.isHelmAppsValuesFile(file)) {
      return
    }
    serverStarter.ensureServerStarted(HelmAppsLspServerDescriptor(project))
  }

  override fun createLspServerWidgetItem(lspServer: LspServer, currentFile: VirtualFile?): LspServerWidgetItem? {
    if (currentFile != null && !HelmAppsFileDetector.isHelmAppsValuesFile(currentFile)) {
      return null
    }
    return LspServerWidgetItem(lspServer, currentFile, HelmAppsIcons.TOOL_WINDOW, HelmAppsConfigurable::class.java)
  }
}

private class HelmAppsLspServerDescriptor(project: Project) :
  ProjectWideLspServerDescriptor(project, "helm-apps (happ LSP)") {

  override fun isSupportedFile(file: VirtualFile): Boolean = HelmAppsFileDetector.isHelmAppsValuesFile(file)

  override fun createCommandLine(): GeneralCommandLine {
    val settings = HelmAppsSettingsService.getInstance()
    val command = settings.happPath()
    val args = withParentPid(settings.lspArgs())

    thisLogger().info("Starting happ LSP: command=$command args=${args.joinToString(" ")}")
    return GeneralCommandLine(command)
      .withParameters(args)
      .withEnvironment("NO_COLOR", "1")
      .withCharset(Charsets.UTF_8)
  }

  override fun getLanguageId(file: VirtualFile): String = "yaml"

  override fun equals(other: Any?): Boolean = other is HelmAppsLspServerDescriptor && other.project == project

  override fun hashCode(): Int = project.hashCode()

  private fun withParentPid(args: List<String>): List<String> {
    val parsed = if (args.isEmpty()) listOf("lsp") else args
      .flatMap { ParametersListUtil.parse(it) }
      .filter { it.isNotBlank() }
    val hasParentPid = parsed.any { it == "--parent-pid" || it.startsWith("--parent-pid=") }
    if (hasParentPid) {
      return parsed
    }
    val pid = try {
      ProcessHandle.current().pid()
    } catch (_: Throwable) {
      -1L
    }
    return if (pid > 0) parsed + "--parent-pid=$pid" else parsed
  }
}
