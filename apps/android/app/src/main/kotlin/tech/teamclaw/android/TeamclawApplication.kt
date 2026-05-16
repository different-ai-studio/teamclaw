package tech.teamclaw.android

import android.app.Application
import io.github.jan.supabase.SupabaseClient
import io.sentry.android.core.SentryAndroid
import tech.teamclaw.android.core.auth.ActorStore
import tech.teamclaw.android.core.auth.MqttService
import tech.teamclaw.android.core.auth.OnboardingCoordinator
import tech.teamclaw.android.core.auth.SessionDetailStore
import tech.teamclaw.android.core.auth.SessionListStore
import tech.teamclaw.android.core.auth.SupabaseActorRepository
import tech.teamclaw.android.core.auth.SupabaseMessagesRepository
import tech.teamclaw.android.core.auth.SupabaseOnboardingStore
import tech.teamclaw.android.core.auth.SupabaseSessionsRepository
import tech.teamclaw.android.core.auth.SupabaseWorkspaceRepository
import tech.teamclaw.android.core.auth.WorkspaceStore
import tech.teamclaw.android.core.auth.apple.AppleSignInHandler
import tech.teamclaw.android.core.auth.google.GoogleSignInHandler
import tech.teamclaw.android.core.deeplink.DeepLinkParser
import tech.teamclaw.android.core.network.SupabaseClientFactory
import tech.teamclaw.android.core.network.SupabaseConfig

/**
 * Manual DI for P1 — the dependency graph is tiny (5 singletons). Switch
 * to Hilt later if/when the graph grows beyond what manual init can manage.
 */
class TeamclawApplication : Application() {

    lateinit var supabaseClient: SupabaseClient
        private set
    lateinit var coordinator: OnboardingCoordinator
        private set
    lateinit var appleHandler: AppleSignInHandler
        private set
    lateinit var googleHandler: GoogleSignInHandler
        private set
    lateinit var deepLinkParser: DeepLinkParser
        private set
    lateinit var sessionListStoreFactory: (teamId: String, currentActorId: String) -> SessionListStore
        private set
    lateinit var sessionDetailStoreFactory: (teamId: String, sessionId: String, currentActorId: String) -> SessionDetailStore
        private set
    lateinit var actorStoreFactory: (teamId: String) -> ActorStore
        private set
    lateinit var workspaceStoreFactory: (teamId: String) -> WorkspaceStore
        private set
    lateinit var mqttService: MqttService
        private set

    override fun onCreate() {
        super.onCreate()

        if (BuildConfig.SENTRY_DSN.isNotBlank()) {
            SentryAndroid.init(this) { options ->
                options.dsn = BuildConfig.SENTRY_DSN
                options.environment = if (BuildConfig.DEBUG) "development" else "production"
                options.tracesSampleRate = 0.2
                options.isAttachScreenshot = true
                options.isAttachViewHierarchy = true
                options.isEnableAutoSessionTracking = true
            }
        }

        supabaseClient = SupabaseClientFactory.create(
            SupabaseConfig(
                url = BuildConfig.SUPABASE_URL,
                publishableKey = BuildConfig.SUPABASE_PUBLISHABLE_KEY,
            )
        )
        val store = SupabaseOnboardingStore(supabaseClient)
        coordinator = OnboardingCoordinator(store)
        appleHandler = AppleSignInHandler(serviceId = BuildConfig.APPLE_SERVICE_ID)
        googleHandler = GoogleSignInHandler(clientId = BuildConfig.GOOGLE_OAUTH_CLIENT_ID)
        deepLinkParser = DeepLinkParser()
        val sessionsRepo = SupabaseSessionsRepository(supabaseClient)
        val messagesRepo = SupabaseMessagesRepository(supabaseClient)
        mqttService = MqttService(host = "ai.ucar.cc", port = 8883, useTls = true)
        sessionListStoreFactory = { teamId, actorId ->
            SessionListStore(teamId, actorId, sessionsRepo, messagesRepo)
        }
        sessionDetailStoreFactory = { teamId, sessionId, actorId ->
            val topic = "amux/${teamId.ifEmpty { "teamclaw" }}/session/$sessionId/live"
            SessionDetailStore(
                teamId = teamId,
                sessionId = sessionId,
                currentActorId = actorId,
                repository = messagesRepo,
                realtimeSignal = mqttService.subscribeAsSignal(topic),
                realtimeEvents = mqttService.subscribeAsEvents(topic),
            )
        }
        val actorRepo = SupabaseActorRepository(supabaseClient)
        actorStoreFactory = { teamId -> ActorStore(teamId, actorRepo) }
        val workspaceRepo = SupabaseWorkspaceRepository(supabaseClient)
        workspaceStoreFactory = { teamId -> WorkspaceStore(teamId, workspaceRepo) }
    }
}
