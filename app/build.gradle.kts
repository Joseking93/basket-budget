plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.basketbudget.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.basketbudget.app"
        minSdk = 24
        targetSdk = 36
        versionCode = 19
        versionName = "3.1"

        ndk {
            // ML Kit's OCR engine ships native libraries for four ABIs. x86 and
            // x86_64 are emulators only and were 22 MB of the APK, so phones
            // only. Add them back here if you ever run this on an emulator.
            abiFilters += listOf("arm64-v8a", "armeabi-v7a")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")

    // BUNDLED text recognition: the Latin model ships inside the APK, so no
    // download and no network at runtime.
    implementation("com.google.mlkit:text-recognition:16.0.1")

    testImplementation("junit:junit:4.13.2")
}
