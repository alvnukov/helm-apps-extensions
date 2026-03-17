plugins {
  kotlin("jvm") version "1.9.25"
  id("org.jetbrains.intellij") version "1.17.4"
}

group = "io.github.alvnukov.helmapps"
version = "0.1.3"

repositories {
  mavenCentral()
}

dependencies {
  implementation(kotlin("stdlib"))
}

intellij {
  type.set("IU")
  version.set("2025.3.3")
}

java {
  sourceCompatibility = JavaVersion.VERSION_17
  targetCompatibility = JavaVersion.VERSION_17
}

tasks {
  patchPluginXml {
    sinceBuild.set("253")
    untilBuild.set("253.*")
  }

  buildSearchableOptions {
    enabled = false
  }

  withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile> {
    kotlinOptions {
      jvmTarget = "17"
      freeCompilerArgs = listOf("-Xjvm-default=all")
    }
  }
}
