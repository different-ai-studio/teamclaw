package tech.teamclaw.android.nav

import androidx.activity.ComponentActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.rememberCoroutineScope
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import kotlinx.coroutines.DisposableHandle
import kotlinx.coroutines.launch
import tech.teamclaw.android.core.auth.ActorStore
import tech.teamclaw.android.core.auth.OnboardingCoordinator
import tech.teamclaw.android.core.auth.OnboardingRoute
import tech.teamclaw.android.core.auth.SessionDetailStore
import tech.teamclaw.android.core.auth.SessionListStore
import tech.teamclaw.android.core.auth.WorkspaceStore
import tech.teamclaw.android.core.auth.apple.AppleSignInHandler
import tech.teamclaw.android.core.auth.google.GoogleSignInHandler
import tech.teamclaw.android.core.model.SessionRecord
import tech.teamclaw.android.core.model.TeamSummary
import tech.teamclaw.android.feature.onboarding.ChooseAuthScreen
import tech.teamclaw.android.feature.onboarding.CreateTeamScreen
import tech.teamclaw.android.feature.onboarding.InviteJoinSheet
import tech.teamclaw.android.feature.onboarding.InviteMemberSheet
import tech.teamclaw.android.core.model.ActorRecord
import tech.teamclaw.android.core.model.InviteKind
import tech.teamclaw.android.feature.onboarding.ActorDetailScreen
import tech.teamclaw.android.feature.onboarding.LobsterSplashScreen
import tech.teamclaw.android.feature.onboarding.LoginScreen
import tech.teamclaw.android.feature.onboarding.MembersScreen
import tech.teamclaw.android.feature.onboarding.NewSessionSheet
import tech.teamclaw.android.feature.onboarding.OnboardingErrorScreen
import tech.teamclaw.android.feature.onboarding.SessionDetailScreen
import tech.teamclaw.android.feature.onboarding.SessionListScreen
import tech.teamclaw.android.feature.onboarding.SettingsScreen
import tech.teamclaw.android.feature.onboarding.SettingsViewState
import tech.teamclaw.android.feature.onboarding.UpgradeAccountSheet
import tech.teamclaw.android.feature.onboarding.WelcomeScreen

@Composable
fun TeamclawNavHost(
    coordinator: OnboardingCoordinator,
    appleHandler: AppleSignInHandler,
    googleHandler: GoogleSignInHandler,
    sessionListStoreFactory: (teamId: String, currentActorId: String) -> SessionListStore,
    sessionDetailStoreFactory: (teamId: String, sessionId: String, currentActorId: String) -> SessionDetailStore,
    actorStoreFactory: (teamId: String) -> ActorStore,
    workspaceStoreFactory: (teamId: String) -> WorkspaceStore,
    versionName: String,
    versionCode: Int,
    onStartVoiceInput: ((onResult: (String) -> Unit) -> Unit)? = null,
    onSessionReady: (suspend (userId: String) -> Unit)? = null,
) {
    val state by coordinator.state.collectAsStateWithLifecycle()
    val activity = LocalContext.current as ComponentActivity

    LaunchedEffect(Unit) { coordinator.bootstrap() }

    // Trigger MQTT connect (or any other "logged-in side-effect") once we
    // land on Ready with a known actor. Re-fires on actor change.
    LaunchedEffect(state.currentContext?.memberActorId) {
        val actorId = state.currentContext?.memberActorId
        if (actorId != null && state.route == OnboardingRoute.Ready) {
            onSessionReady?.invoke(actorId)
        }
    }

    when (state.route) {
        OnboardingRoute.Loading -> LobsterSplashScreen()
        OnboardingRoute.Failed -> OnboardingErrorScreen(
            message = state.errorMessage ?: "Unknown setup error.",
            onRetry = { coordinator.launch { coordinator.bootstrap() } },
        )
        OnboardingRoute.NeedsAuth -> AuthFlow(
            coordinator = coordinator,
            appleHandler = appleHandler,
            googleHandler = googleHandler,
            activity = activity,
            isBusy = state.isBusy,
            pendingEmail = state.pendingEmailOtpEmail,
            errorMessage = state.errorMessage,
        )
        OnboardingRoute.CreateTeam -> CreateTeamScreen(
            isBusy = state.isBusy,
            errorMessage = state.errorMessage,
            onCreate = { name -> coordinator.launch { coordinator.createTeam(name) } },
        )
        OnboardingRoute.Ready -> {
            val team = state.currentContext?.team
            val actorId = state.currentContext?.memberActorId
            if (team == null || actorId == null) {
                LobsterSplashScreen()
            } else {
                ReadyFlow(
                    coordinator = coordinator,
                    team = team,
                    isAnonymous = state.isAnonymous,
                    currentActorId = actorId,
                    sessionListStoreFactory = sessionListStoreFactory,
                    sessionDetailStoreFactory = sessionDetailStoreFactory,
                    actorStoreFactory = actorStoreFactory,
                    workspaceStoreFactory = workspaceStoreFactory,
                    versionName = versionName,
                    versionCode = versionCode,
                    onStartVoiceInput = onStartVoiceInput,
                )
            }
        }
    }
}

@Composable
private fun ReadyFlow(
    coordinator: OnboardingCoordinator,
    team: TeamSummary,
    isAnonymous: Boolean,
    currentActorId: String,
    sessionListStoreFactory: (teamId: String, currentActorId: String) -> SessionListStore,
    sessionDetailStoreFactory: (teamId: String, sessionId: String, currentActorId: String) -> SessionDetailStore,
    actorStoreFactory: (teamId: String) -> ActorStore,
    workspaceStoreFactory: (teamId: String) -> WorkspaceStore,
    versionName: String,
    versionCode: Int,
    onStartVoiceInput: ((onResult: (String) -> Unit) -> Unit)? = null,
) {
    val teamId = team.id
    val teamName = team.name
    var openSession by remember { mutableStateOf<SessionRecord?>(null) }
    var showMembers by remember { mutableStateOf(false) }
    var showSettings by remember { mutableStateOf(false) }
    var showUpgrade by remember { mutableStateOf(false) }
    var showNewSession by remember { mutableStateOf(false) }
    val coordState by coordinator.state.collectAsStateWithLifecycle()
    val listStore = remember(teamId, currentActorId) {
        sessionListStoreFactory(teamId, currentActorId)
    }
    val listState by listStore.state.collectAsStateWithLifecycle()
    val actorStore = remember(teamId) { actorStoreFactory(teamId) }
    val actorState by actorStore.state.collectAsStateWithLifecycle()
    val workspaceStore = remember(teamId) { workspaceStoreFactory(teamId) }
    val workspaceState by workspaceStore.state.collectAsStateWithLifecycle()
    LaunchedEffect(teamId) {
        listStore.reload()
        actorStore.reload()
        workspaceStore.reload()
    }
    LaunchedEffect(listState.justCreatedSessionId) {
        val id = listState.justCreatedSessionId ?: return@LaunchedEffect
        showNewSession = false
        listStore.clearJustCreated()
        openSession = listState.sessions.firstOrNull { it.id == id }
    }

    val active = openSession
    if (showSettings) {
        SettingsScreen(
            state = SettingsViewState(
                teamName = teamName,
                teamRole = team.role.replaceFirstChar { it.uppercase() },
                displayName = if (isAnonymous) "Anonymous" else "Signed-in user",
                isAnonymous = isAnonymous,
                versionName = versionName,
                versionCode = versionCode,
            ),
            onBack = { showSettings = false },
            onUpgradeAccount = { showUpgrade = true },
            onSignOut = {
                showSettings = false
                coordinator.launch { coordinator.signOut() }
            },
        )
        if (showUpgrade) {
            UpgradeAccountSheet(
                isBusy = coordState.isBusy,
                errorMessage = coordState.errorMessage,
                onDismiss = { showUpgrade = false },
                onSubmit = { email, password ->
                    coordinator.launch {
                        coordinator.upgradeWithPassword(email, password)
                        if (!coordinator.state.value.isAnonymous) {
                            showUpgrade = false
                        }
                    }
                },
            )
        }
    } else if (showMembers) {
        MembersFlow(
            coordinator = coordinator,
            teamId = teamId,
            teamName = teamName,
            actorStoreFactory = actorStoreFactory,
            onBack = { showMembers = false },
        )
    } else if (active == null) {
        SessionListScreen(
            teamName = teamName,
            sessions = listState.sessions,
            isLoading = listState.isLoading,
            errorMessage = listState.errorMessage,
            onRefresh = { coordinator.launch { listStore.reload() } },
            onSessionClick = { openSession = it },
            onMembers = { showMembers = true },
            onSettings = { showSettings = true },
            onNewSession = { showNewSession = true },
            onSignOut = { coordinator.launch { coordinator.signOut() } },
        )
        if (showNewSession) {
            NewSessionSheet(
                agents = actorState.actors.filter { it.isAgent },
                workspaces = workspaceState.workspaces,
                isCreating = listState.isCreating,
                errorMessage = listState.errorMessage,
                onDismiss = { showNewSession = false },
                onSubmit = { input ->
                    coordinator.launch {
                        listStore.createSession(
                            title = input.title,
                            agentActorId = input.agentActorId,
                            firstMessage = input.firstMessage,
                        )
                    }
                },
            )
        }
    } else {
        val detailStore = remember(active.id) {
            sessionDetailStoreFactory(teamId, active.id, currentActorId)
        }
        val detailState by detailStore.state.collectAsStateWithLifecycle()
        val scope = rememberCoroutineScope()
        LaunchedEffect(active.id) {
            detailStore.reload()
            detailStore.startRealtime(scope)
        }
        SessionDetailScreen(
            title = active.title.ifBlank { "Session" },
            currentActorId = currentActorId,
            messages = detailState.messages,
            mentionCandidates = actorState.actors.filter { it.id != currentActorId },
            isLoading = detailState.isLoading,
            isSending = detailState.isSending,
            errorMessage = detailState.errorMessage,
            onSend = { text, mentions ->
                coordinator.launch { detailStore.send(text, mentions) }
            },
            onBack = { openSession = null },
            onStartVoiceInput = onStartVoiceInput,
        )
    }
}

@Composable
private fun MembersFlow(
    coordinator: OnboardingCoordinator,
    teamId: String,
    teamName: String,
    actorStoreFactory: (teamId: String) -> ActorStore,
    onBack: () -> Unit,
) {
    val store = remember(teamId) { actorStoreFactory(teamId) }
    val s by store.state.collectAsStateWithLifecycle()
    var showInvite by remember { mutableStateOf(false) }
    var openActor by remember { mutableStateOf<ActorRecord?>(null) }
    LaunchedEffect(teamId) { store.reload() }

    val activeActor = openActor
    if (activeActor != null) {
        ActorDetailScreen(
            actor = activeActor,
            rotatedInvite = s.lastInvite,
            isBusy = s.isInviting,
            errorMessage = s.errorMessage,
            onBack = {
                openActor = null
                store.clearLastInvite()
            },
            onRotate = {
                coordinator.launch {
                    store.rotateActor(
                        actorId = activeActor.id,
                        displayName = activeActor.displayName,
                        kind = if (activeActor.isAgent) InviteKind.AGENT else InviteKind.MEMBER,
                        agentKind = activeActor.agentKind,
                    )
                }
            },
            onRemove = {
                coordinator.launch {
                    store.removeActor(activeActor.id)
                    openActor = null
                }
            },
            onDismissInvite = { store.clearLastInvite() },
        )
        return
    }

    MembersScreen(
        teamName = teamName,
        actors = s.actors,
        isLoading = s.isLoading,
        errorMessage = s.errorMessage,
        onRefresh = { coordinator.launch { store.reload() } },
        onInvite = { showInvite = true },
        onActorClick = { openActor = it },
        onBack = onBack,
    )

    if (showInvite) {
        InviteMemberSheet(
            isInviting = s.isInviting,
            errorMessage = s.errorMessage,
            lastInvite = s.lastInvite,
            onDismiss = {
                showInvite = false
                store.clearLastInvite()
            },
            onSubmit = { input -> coordinator.launch { store.createInvite(input) } },
            onClearLastInvite = { store.clearLastInvite() },
        )
    }
}

@Composable
private fun AuthFlow(
    coordinator: OnboardingCoordinator,
    appleHandler: AppleSignInHandler,
    googleHandler: GoogleSignInHandler,
    activity: ComponentActivity,
    isBusy: Boolean,
    pendingEmail: String?,
    errorMessage: String?,
) {
    val navController = rememberNavController()
    var showInviteSheet by remember { mutableStateOf(false) }

    NavHost(navController, startDestination = "welcome") {
        composable("welcome") {
            WelcomeScreen(
                errorMessage = errorMessage,
                onGetStarted = { navController.navigate("choose") },
            )
        }
        composable("choose") {
            ChooseAuthScreen(
                isBusy = isBusy,
                errorMessage = errorMessage,
                onCreatePrivateWorkspace = { coordinator.launch { coordinator.signInAnonymously() } },
                onSignInOrRegister = { navController.navigate("login") },
                onJoinTeam = { showInviteSheet = true },
            )
        }
        composable("login") {
            LoginScreen(
                pendingEmail = pendingEmail,
                isBusy = isBusy,
                errorMessage = errorMessage,
                onSendCode = { email -> coordinator.launch { coordinator.sendEmailOtp(email) } },
                onVerifyCode = { email, code -> coordinator.launch { coordinator.verifyOtp(email, code) } },
                onUseDifferentEmail = { coordinator.resetPendingEmailOtp() },
                onSignInWithApple = {
                    coordinator.launch {
                        runCatching {
                            val cred = appleHandler.request(activity)
                            coordinator.signInWithAppleCredential(cred.idToken, cred.nonce)
                        }
                    }
                },
                onSignInWithGoogle = {
                    coordinator.launch {
                        runCatching {
                            val cred = googleHandler.request(activity)
                            coordinator.signInWithAppleCredential(cred.idToken, nonce = "")
                        }
                    }
                },
            )
        }
    }

    if (showInviteSheet) {
        InviteJoinSheet(
            isBusy = isBusy,
            errorMessage = errorMessage,
            onDismiss = { showInviteSheet = false },
            onSubmit = { token ->
                coordinator.launch {
                    coordinator.claimInviteSmart(token)
                    showInviteSheet = false
                }
            },
        )
    }
}
