package io.github.alvnukov.helmapps.settings

import com.intellij.openapi.options.Configurable
import com.intellij.openapi.options.SearchableConfigurable
import com.intellij.openapi.ui.LabeledComponent
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import com.intellij.util.ui.JBUI
import javax.swing.JComponent
import javax.swing.JPanel

class HelmAppsConfigurable : SearchableConfigurable, Configurable.NoScroll {
  private val happPathField = JBTextField()
  private val happArgsField = JBTextField()
  private val noteArea = JBTextArea(
    "happ должен быть доступен в PATH или указан явным путем. " +
      "LSP запускается в stdio-режиме и используется как общее ядро для IDE.",
  ).apply {
    lineWrap = true
    wrapStyleWord = true
    isEditable = false
    isOpaque = false
    border = JBUI.Borders.emptyTop(8)
  }

  private var panel: JPanel? = null

  override fun getId(): String = "helm-apps"

  override fun getDisplayName(): String = "helm-apps"

  override fun createComponent(): JComponent {
    if (panel == null) {
      panel = FormBuilder.createFormBuilder()
        .addComponent(
          LabeledComponent.create(happPathField, "Path to happ binary:"),
          1,
        )
        .addComponent(
          LabeledComponent.create(happArgsField, "happ LSP args:"),
          1,
        )
        .addComponent(noteArea, 1)
        .addComponentFillVertically(JPanel(), 0)
        .panel
    }
    reset()
    return panel!!
  }

  override fun isModified(): Boolean {
    val settings = HelmAppsSettingsService.getInstance().snapshot()
    return happPathField.text != settings.happPath || happArgsField.text != settings.happLspArgs
  }

  override fun apply() {
    val service = HelmAppsSettingsService.getInstance()
    val current = service.snapshot()
    service.update(
      current.copy(
        happPath = happPathField.text.trim(),
        happLspArgs = happArgsField.text.trim(),
      ),
    )
  }

  override fun reset() {
    val settings = HelmAppsSettingsService.getInstance().snapshot()
    happPathField.text = settings.happPath
    happArgsField.text = settings.happLspArgs
  }
}
