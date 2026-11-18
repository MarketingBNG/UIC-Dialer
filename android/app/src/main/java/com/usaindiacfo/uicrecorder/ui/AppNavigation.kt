package com.usaindiacfo.uicrecorder.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
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
import com.usaindiacfo.uicrecorder.AppContainer
import com.usaindiacfo.uicrecorder.data.api.UserDto
import com.usaindiacfo.uicrecorder.ui.admin.AdminBackBar
import com.usaindiacfo.uicrecorder.ui.admin.AuditScreen
import com.usaindiacfo.uicrecorder.ui.admin.ClientListScreen
import com.usaindiacfo.uicrecorder.ui.admin.DevicesScreen
import com.usaindiacfo.uicrecorder.ui.admin.FirefliesBanner
import com.usaindiacfo.uicrecorder.ui.admin.ServerSettingsScreen
import com.usaindiacfo.uicrecorder.ui.admin.UsersScreen
import com.usaindiacfo.uicrecorder.ui.calls.CallDetailScreen
import com.usaindiacfo.uicrecorder.ui.calls.CallsScreen
import com.usaindiacfo.uicrecorder.ui.contacts.ContactsScreen
import com.usaindiacfo.uicrecorder.ui.dialer.Avatar
import com.usaindiacfo.uicrecorder.ui.dialer.ContactDetailScreen
import com.usaindiacfo.uicrecorder.ui.dialer.DialerScreen
import com.usaindiacfo.uicrecorder.ui.dialer.PendingDialHost
import com.usaindiacfo.uicrecorder.ui.settings.SettingsScreen
import com.usaindiacfo.uicrecorder.ui.setup.SetupScreen
import com.usaindiacfo.uicrecorder.ui.signin.SignInScreen
import com.usaindiacfo.uicrecorder.ui.today.TodayScreen

object Routes {
    const val SIGN_IN = "signIn"
    const val SETUP = "setup"
    const val TODAY = "today"
    const val DIALER = "dialer"
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

    fun callDetail(id: String) = "callDetail/$id"
    fun contact(phone: String) = "contact/${android.net.Uri.encode(phone)}"
}

/** Values of MainActivity.EXTRA_OPEN (notification deep links). */
object OpenTargets {
    const val TODAY = "today"
    const val CONTACT = "contact"
}

private data class NavTab(val route: String, val label: String, val icon: ImageVector)

private val TABS = listOf(
    NavTab(Routes.TODAY, "Today", Icons.Filled.Home),
    NavTab(Routes.DIALER, "Keypad", dialpadIcon()),
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

    val showBottom = route in TAB_ROUTES || route == Routes.CONTACT || route == Routes.CALL_DETAIL
    val selectedTab = when (route) {
        in TAB_ROUTES -> route
        Routes.CALL_DETAIL -> Routes.CALLS
        Routes.CONTACT -> lastTab
        else -> null
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            if (route in TAB_ROUTES) TopAppBar(
                title = { Text(TABS.first { it.route == route }.label, fontWeight = FontWeight.SemiBold) },
                actions = { Avatar(user?.name ?: user?.email, onClick = { nav.navigate(Routes.SETTINGS) { launchSingleTop = true } }) },
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
        ) {
            composable(Routes.SIGN_IN) {
                SignInScreen(onSignedIn = {
                    nav.navigate(Routes.SETUP) { popUpTo(Routes.SIGN_IN) { inclusive = true } }
                })
            }
            composable(Routes.SETUP) {
                SetupScreen(onDone = {
                    // From Settings or Today: go back there; after sign-in: start at Today.
                    if (nav.previousBackStackEntry != null) nav.popBackStack()
                    else nav.navigate(Routes.TODAY) { popUpTo(Routes.SETUP) { inclusive = true } }
                })
            }
            composable(Routes.TODAY) {
                TodayScreen(onOpenContact = { nav.navigate(Routes.contact(it)) }, onOpenSetup = { nav.navigate(Routes.SETUP) })
            }
            composable(Routes.DIALER) { DialerScreen(onOpenContact = { nav.navigate(Routes.contact(it)) }) }
            composable(Routes.CONTACTS) { ContactsScreen(onOpenContact = { nav.navigate(Routes.contact(it)) }) }
            composable(Routes.CONTACT, arguments = listOf(navArgument("phone") { type = NavType.StringType })) {
                ContactDetailScreen(phone = it.arguments?.getString("phone").orEmpty(), onBack = { nav.popBackStack() })
            }
            composable(Routes.CALLS) { CallsScreen(onOpenCall = { nav.navigate(Routes.callDetail(it)) }) }
            composable(Routes.CALL_DETAIL, arguments = listOf(navArgument("id") { type = NavType.StringType })) {
                CallDetailScreen(id = it.arguments?.getString("id").orEmpty(), onBack = { nav.popBackStack() })
            }
            composable(Routes.ADMIN_USERS) { AdminTabs(user, route, nav) { UsersScreen() } }
            composable(Routes.ADMIN_DEVICES) { AdminTabs(user, route, nav) { DevicesScreen() } }
            composable(Routes.ADMIN_SETTINGS) { AdminTabs(user, route, nav) { ServerSettingsScreen() } }
            composable(Routes.ADMIN_CLIENTS) { AdminTabs(user, route, nav) { ClientListScreen() } }
            composable(Routes.ADMIN_AUDIT) {
                AdminTabs(user, route, nav) { AuditScreen(onOpenCall = { id -> nav.navigate(Routes.callDetail(id)) }) }
            }
            composable(Routes.SETTINGS) {
                SettingsScreen(
                    onOpenSetup = { nav.navigate(Routes.SETUP) },
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
private fun dialpadIcon(): ImageVector = ImageVector.Builder("Dialpad", 24.dp, 24.dp, 24f, 24f).apply {
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
