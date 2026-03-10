package io.github.alvnukov.helmapps.settings

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import com.intellij.util.execution.ParametersListUtil

@Service(Service.Level.APP)
@State(name = "HelmAppsSettings", storages = [Storage("helm-apps.xml")])
class HelmAppsSettingsService : PersistentStateComponent<HelmAppsSettingsService.State> {
  data class State(
    var happPath: String = "happ",
    var happLspArgs: String = "lsp",
  )

  private var state = State()

  override fun getState(): State = state

  override fun loadState(state: State) {
    this.state = state
  }

  fun snapshot(): State = state.copy()

  fun update(next: State) {
    state = next
  }

  fun happPath(): String = state.happPath.trim().ifEmpty { "happ" }

  fun lspArgs(): List<String> {
    val parsed = ParametersListUtil.parse(state.happLspArgs.trim())
    return if (parsed.isEmpty()) listOf("lsp") else parsed
  }

  companion object {
    fun getInstance(): HelmAppsSettingsService = service()
  }
}
