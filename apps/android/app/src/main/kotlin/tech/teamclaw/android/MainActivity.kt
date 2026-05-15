package tech.teamclaw.android

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import tech.teamclaw.android.core.deeplink.DeepLink
import tech.teamclaw.android.core.design.TeamclawTheme
import tech.teamclaw.android.nav.TeamclawNavHost

class MainActivity : ComponentActivity() {

    private val app get() = application as TeamclawApplication

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        intent?.let { handleIntent(it) }
        setContent {
            TeamclawTheme {
                TeamclawNavHost(
                    coordinator = app.coordinator,
                    appleHandler = app.appleHandler,
                    googleHandler = app.googleHandler,
                    sessionListStoreFactory = app.sessionListStoreFactory,
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent) {
        val data = intent.data ?: return
        val deepLink = app.deepLinkParser.parse(data) ?: return
        lifecycleScope.launch {
            when (deepLink) {
                is DeepLink.InviteToken -> app.coordinator.setPendingInviteToken(deepLink.token)
                is DeepLink.AuthCallback -> app.coordinator.handleAuthCallback(data)
            }
        }
    }
}
