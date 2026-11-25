package com.usaindiacfo.uicdialer.ui

import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.navigation.NavBackStackEntry
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.PrimaryScrollableTabRow
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.usaindiacfo.uicdialer.AppContainer
import com.usaindiacfo.uicdialer.data.api.UserDto
import com.usaindiacfo.uicdialer.ui.admin.AdminBackBar
import com.usaindiacfo.uicdialer.ui.admin.AuditScreen
import com.usaindiacfo.uicdialer.ui.admin.ClientListScreen
import com.usaindiacfo.uicdialer.ui.admin.DevicesScreen
import com.usaindiacfo.uicdialer.ui.admin.FirefliesBanner
import com.usaindiacfo.uicdialer.ui.admin.ServerSettingsScreen
import com.usaindiacfo.uicdialer.ui.admin.UsersScreen
import com.usaindiacfo.uicdialer.ui.calls.CallDetailScreen
import com.usaindiacfo.uicdialer.ui.calls.CallsScreen
import com.usaindiacfo.uicdialer.ui.contacts.ContactsScreen
import com.usaindiacfo.uicdialer.ui.dialer.Avatar
import com.usaindiacfo.uicdialer.ui.dialer.ContactDetailScreen
import com.usaindiacfo.uicdialer.ui.dialer.DialerScreen
import com.usaindiacfo.uicdialer.ui.dialer.PendingDialHost
import com.usaindiacfo.uicdialer.ui.lists.ListSessionScreen
import com.usaindiacfo.uicdialer.ui.lists.ListsScreen
import com.usaindiacfo.uicdialer.ui.settings.SettingsScreen
import com.usaindiacfo.uicdialer.ui.setup.SetupScreen
import com.usaindiacfo.uicdialer.ui.setup.SetupGuideScreen
import kotlinx.coroutines.flow.first
import com.usaindiacfo.uicdialer.ui.signin.SignInScreen
import com.usaindiacfo.uicdialer.ui.today.TodayScreen

object Routes {
    const val SIGN_IN = "signIn"
    const val SETUP = "setup"
    const val SETUP_GUIDE = "setupGuide"
    const val TODAY = "today"
    const val DIALER = "dialer"
    const val RECENTS = "recents"
    const val CONTACTS = "contacts"
    const val CONTACT = "contact/{phone}"
    const val CALLS = "calls"
    const val CALL_DETAIL = "callDetail/{id}"
    const val ADMIN_USERS = "admin/users"
    const val ADMIN_DEVICES = "admin/devices"
    const val ADMIN_SETTINGS = "admin/settings"
    const val ADMIN_CLIENTS = "admin/clients"
    const val ADMIN_AUDIT = "admin/audit"
    const val SETTINGS = "settings"
    const val LISTS = "lists"
    const val LIST_SESSION = "listSession/{id}"

    fun callDetail(id: String) = "callDetail/$id"
    fun listSession(id: String) = "listSession/$id"
    fun contact(phone: String) = "contact/${android.net.Uri.encode(phone)}"
}

/** Values of MainActivity.EXTRA_OPEN (notification deep links). */
object OpenTargets {
    const val TODAY = "today"
    const val CONTACT = "contact"
}

// Screen transitions, WhatsApp-style: an opened screen slides in fully from the right while the one under it
// drifts a quarter to the left; Back reverses it. With the back gesture (Android 16+) it follows the finger.
// Tabs just cross-fade quickly.
private val Emphasized = CubicBezierEasing(0.2f, 0f, 0f, 1f)
private const val PUSH_MS = 300
private val TAB_IN = fadeIn(tween(150, delayMillis = 40))
private val TAB_OUT = fadeOut(tween(90))
private val PUSH_IN: EnterTransition = slideInHorizontally(tween(PUSH_MS, easing = Emphasized)) { it }
private val PUSH_OUT: ExitTransition = slideOutHorizontally(tween(PUSH_MS, easing = Emphasized)) { -it / 4 }
private val POP_IN: EnterTransition = slideInHorizontally(tween(PUSH_MS, easing = Emphasized)) { -it / 4 }
private val POP_OUT: ExitTransition = slideOutHorizontally(tween(PUSH_MS, easing = Emphasized)) { it }
// During the back gesture the screen tracks the finger 1:1 (linear), then finishes on release.
private val SWIPE_IN: EnterTransition = slideInHorizontally(tween(PUSH_MS, easing = LinearEasing)) { -it / 4 }
private val SWIPE_OUT: ExitTransition = slideOutHorizontally(tween(PUSH_MS, easing = LinearEasing)) { it }

private fun AnimatedContentTransitionScope<NavBackStackEntry>.isTabSwitch() =
    initialState.destination.route in TAB_ROUTES && targetState.destination.route in TAB_ROUTES

/** A destination with a solid background, so during Back the screen on top fully covers the one under it. */
private fun androidx.navigation.NavGraphBuilder.screen(
    route: String,
    arguments: List<androidx.navigation.NamedNavArgument> = emptyList(),
    content: @Composable (NavBackStackEntry) -> Unit,
) = composable(route, arguments) { entry ->
    androidx.compose.foundation.layout.Box(
        Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background),
    ) { content(entry) }
}

private data class NavTab(val route: String, val label: String, val icon: ImageVector)

private val TABS = listOf(
    NavTab(Routes.TODAY, "Today", Icons.Filled.Home),
    NavTab(Routes.RECENTS, "Recents", Icons.Filled.DateRange),
    NavTab(Routes.CONTACTS, "Contacts", Icons.Filled.Person),
    NavTab(Routes.CALLS, "Calls", Icons.Filled.Call),
)
private val TAB_ROUTES = TABS.map { it.route }.toSet()

/**
 * [openRequest] is a notification deep link (target, phone); handled once signed in, then [onOpenHandled] clears it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppNavigation(
    container: AppContainer,
    nav: NavHostController = rememberNavController(),
    openRequest: Pair<String, String?>? = null,
    onOpenHandled: () -> Unit = {},
) {
    val user by container.authRepository.currentUser.collectAsStateWithLifecycle()
    val entry by nav.currentBackStackEntryAsState()
    val route = entry?.destination?.route
    val start = remember { if (user == null) Routes.SIGN_IN else Routes.TODAY }
    var lastTab by remember { mutableStateOf(Routes.TODAY) }
    if (route in TAB_ROUTES && route != lastTab) lastTab = route!!

    // Signed out (button, or refresh token rejected): back to sign-in with a clean back stack.
    LaunchedEffect(user == null) {
        if (user == null && route != null && route != Routes.SIGN_IN) {
            nav.navigate(Routes.SIGN_IN) { popUpTo(0) { inclusive = true } }
        }
    }

    // Guided setup until finished once, and again whenever a required permission was revoked.
    val appContext = androidx.compose.ui.platform.LocalContext.current.applicationContext
    LaunchedEffect(user != null) {
        if (user == null || start != Routes.TODAY) return@LaunchedEffect
        val businessOnly = runCatching { container.deviceConfigRepository.config.first().businessOnly }.getOrDefault(false)
        val show = com.usaindiacfo.uicdialer.ui.setup.SetupFlow.shouldShowGuide(
            com.usaindiacfo.uicdialer.ui.setup.GuidePrefs.completed(appContext),
            com.usaindiacfo.uicdialer.ui.setup.SetupChecks.requiredPermissionsMissing(appContext, businessOnly),
        )
        if (show) nav.navigate(Routes.SETUP_GUIDE) { launchSingleTop = true }
    }

    // Notification deep link, once signed in and past sign-in.
    LaunchedEffect(openRequest, user != null, route != null && route != Routes.SIGN_IN) {
        val req = openRequest ?: return@LaunchedEffect
        if (user == null || route == null || route == Routes.SIGN_IN) return@LaunchedEffect
        when (req.first) {
            OpenTargets.CONTACT -> req.second?.takeIf { it.isNotBlank() }?.let { nav.navigate(Routes.contact(it)) { launchSingleTop = true } }
                ?: nav.navigateTab(Routes.TODAY)
            else -> nav.navigateTab(Routes.TODAY)
        }
        onOpenHandled()
    }

    val showBottom = route in TAB_ROUTES || route == Routes.CONTACT || route == Routes.CALL_DETAIL ||
        route == Routes.LIST_SESSION || route == Routes.DIALER
    val selectedTab = when (route) {
        in TAB_ROUTES -> route
        Routes.CALL_DETAIL -> Routes.CALLS
        Routes.DIALER -> Routes.TODAY
        Routes.CONTACT, Routes.LIST_SESSION -> lastTab
        else -> null
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            if (route in TAB_ROUTES) TopAppBar(
                title = { Text(TABS.first { it.route == route }.label, fontWeight = FontWeight.SemiBold) },
                actions = {
                    Avatar(user?.name ?: user?.email, onClick = { nav.navigate(Routes.SETTINGS) { launchSingleTop = true } }) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
        bottomBar = {
            if (showBottom) NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                TABS.forEach { tab ->
                    NavigationBarItem(
                        selected = selectedTab == tab.route,
                        onClick = { nav.navigateTab(tab.route) },
                        icon = { Icon(tab.icon, contentDescription = null) },
                        label = { Text(tab.label) },
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = MaterialTheme.colorScheme.primary,
                            selectedTextColor = MaterialTheme.colorScheme.primary,
                            indicatorColor = MaterialTheme.colorScheme.primaryContainer,
                        ),
                    )
                }
            }
        },
    ) { padding ->
        NavHost(
            navController = nav,
            startDestination = start,
            modifier = Modifier.padding(padding),
            enterTransition = { if (isTabSwitch()) TAB_IN else PUSH_IN },
            exitTransition = { if (isTabSwitch()) TAB_OUT else PUSH_OUT },
            popEnterTransition = { if (isTabSwitch()) TAB_IN else POP_IN },
            popExitTransition = { if (isTabSwitch()) TAB_OUT else POP_OUT },
            // The back gesture follows the finger with the same slide (not the default shrink).
            predictivePopEnterTransition = { if (isTabSwitch()) TAB_IN else SWIPE_IN },
            predictivePopExitTransition = { if (isTabSwitch()) TAB_OUT else SWIPE_OUT },
        ) {
            screen(Routes.SIGN_IN) {
                SignInScreen(onSignedIn = {
                    nav.navigate(Routes.SETUP_GUIDE) { popUpTo(Routes.SIGN_IN) { inclusive = true } }
                })
            }
            screen(Routes.SETUP) {
                SetupScreen(onDone = {
                    // From Settings or Today: go back there; after sign-in: start at Today.
                    if (nav.previousBackStackEntry != null) nav.popBackStack()
                    else nav.navigate(Routes.TODAY) { popUpTo(Routes.SETUP) { inclusive = true } }
                })
            }
            screen(Routes.SETUP_GUIDE) {
                SetupGuideScreen(
                    onFinished = {
                        if (nav.previousBackStackEntry != null) nav.popBackStack()
                        else nav.navigate(Routes.TODAY) { popUpTo(Routes.SETUP_GUIDE) { inclusive = true } }
                    },
                    onOpenChecks = { nav.navigate(Routes.SETUP) },
                )
            }
            screen(Routes.TODAY) {
                TodayScreen(
                    onOpenContact = { nav.navigate(Routes.contact(it)) },
                    onOpenSetup = { nav.navigate(Routes.SETUP) },
                    onOpenLists = { nav.navigate(Routes.LISTS) { launchSingleTop = true } },
                    onOpenKeypad = { nav.navigate(Routes.DIALER) { launchSingleTop = true } },
                )
            }
            screen(Routes.DIALER) {
                // Opened from the Dial button on Today; no longer a tab.
                Column(Modifier.fillMaxSize()) {
                    TopAppBar(
                        title = { Text("Keypad", fontWeight = FontWeight.SemiBold) },
                        navigationIcon = {
                            IconButton(onClick = { if (!nav.popBackStack()) nav.navigateTab(Routes.TODAY) }) {
                                Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
                            }
                        },
                        colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                    )
                    DialerScreen(onOpenContact = { nav.navigate(Routes.contact(it)) })
                }
            }
            screen(Routes.RECENTS) { com.usaindiacfo.uicdialer.ui.recents.RecentsScreen(onOpenContact = { nav.navigate(Routes.contact(it)) }) }
            screen(Routes.CONTACTS) { ContactsScreen(onOpenContact = { nav.navigate(Routes.contact(it)) }) }
            screen(Routes.CONTACT, arguments = listOf(navArgument("phone") { type = NavType.StringType })) {
                ContactDetailScreen(phone = it.arguments?.getString("phone").orEmpty(), onBack = { nav.popBackStack() })
            }
            screen(Routes.LISTS) {
                ListsScreen(onOpenList = { nav.navigate(Routes.listSession(it)) }, onBack = { nav.popBackStack() })
            }
            screen(Routes.LIST_SESSION, arguments = listOf(navArgument("id") { type = NavType.StringType })) {
                ListSessionScreen(
                    listId = it.arguments?.getString("id").orEmpty(),
                    onBack = { nav.popBackStack() },
                    onOpenContact = { phone -> nav.navigate(Routes.contact(phone)) },
                )
            }
            screen(Routes.CALLS) { CallsScreen(onOpenCall = { nav.navigate(Routes.callDetail(it)) }) }
            screen(Routes.CALL_DETAIL, arguments = listOf(navArgument("id") { type = NavType.StringType })) {
                CallDetailScreen(id = it.arguments?.getString("id").orEmpty(), onBack = { nav.popBackStack() })
            }
            screen(Routes.ADMIN_USERS) { AdminTabs(user, route, nav) { UsersScreen() } }
            screen(Routes.ADMIN_DEVICES) { AdminTabs(user, route, nav) { DevicesScreen() } }
            screen(Routes.ADMIN_SETTINGS) { AdminTabs(user, route, nav) { ServerSettingsScreen() } }
            screen(Routes.ADMIN_CLIENTS) { AdminTabs(user, route, nav) { ClientListScreen() } }
            screen(Routes.ADMIN_AUDIT) {
                AdminTabs(user, route, nav) { AuditScreen(onOpenCall = { id -> nav.navigate(Routes.callDetail(id)) }) }
            }
            screen(Routes.SETTINGS) {
                SettingsScreen(
                    onOpenSetup = { nav.navigate(Routes.SETUP) },
                    onOpenGuide = { nav.navigate(Routes.SETUP_GUIDE) },
                    onOpenAdmin = { nav.navigate(Routes.ADMIN_USERS) { launchSingleTop = true } },
                    onBack = { if (nav.previousBackStackEntry != null) nav.popBackStack() else nav.navigateTab(Routes.TODAY) },
                )
            }
        }
        // Outcome prompt after a call started from the app; shown over whichever screen the rep returns to.
        if (user != null) PendingDialHost()
    }
}

/** Users / Devices for managers and admins; Server settings for admins only (server enforces too). */
@Composable
private fun AdminTabs(user: UserDto?, route: String?, nav: NavHostController, content: @Composable () -> Unit) {
    val items = buildList {
        add(Routes.ADMIN_USERS to "Users")
        add(Routes.ADMIN_DEVICES to "Devices")
        if (user?.isAdmin == true) {
            add(Routes.ADMIN_SETTINGS to "Server")
            add(Routes.ADMIN_CLIENTS to "Clients")
            add(Routes.ADMIN_AUDIT to "Audit")
        }
    }
    Column(Modifier.fillMaxSize()) {
        // Back pops to Settings (admin tabs replace each other above it).
        AdminBackBar(onBack = { if (!nav.popBackStack(Routes.SETTINGS, inclusive = false)) nav.navigate(Routes.SETTINGS) })
        PrimaryScrollableTabRow(edgePadding = 0.dp, selectedTabIndex = items.indexOfFirst { it.first == route }.coerceAtLeast(0)) {
            items.forEach { (r, label) ->
                Tab(selected = r == route, onClick = {
                    if (r != route) nav.navigate(r) {
                        popUpTo(Routes.SETTINGS)
                        launchSingleTop = true
                    }
                }, text = { Text(label) })
            }
        }
        FirefliesBanner(route, user?.id, fetch = route != Routes.ADMIN_DEVICES) // Devices fetches with its panel
        content()
    }
}

private fun NavHostController.navigateTab(route: String) = navigate(route) {
    // Today, not the graph's start destination: after a fresh sign-in that is SIGN_IN, which is no longer on the stack.
    popUpTo(Routes.TODAY) { saveState = true }
    launchSingleTop = true
    restoreState = true
}

/** 3x3 + 1 dots (material-icons-core has no Dialpad). */
internal fun dialpadIcon(): ImageVector = ImageVector.Builder("Dialpad", 24.dp, 24.dp, 24f, 24f).apply {
    for (row in 0..3) for (col in 0..2) {
        if (row == 3 && col != 1) continue
        val cx = 6f + col * 6f
        val cy = 3f + row * 6f
        path(fill = SolidColor(Color.Black)) {
            moveTo(cx - 2f, cy)
            arcToRelative(2f, 2f, 0f, true, true, 4f, 0f)
            arcToRelative(2f, 2f, 0f, true, true, -4f, 0f)
            close()
        }
    }
}.build()
