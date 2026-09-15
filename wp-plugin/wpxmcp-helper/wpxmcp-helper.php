<?php
/**
 * Plugin Name:       wpxmcp Helper
 * Plugin URI:        https://github.com/alokemajumder/wpxmcp
 * Description:       Companion plugin for the wpxmcp MCP server. Exposes the things core REST does not: emulated WP-CLI, guarded SQL, theme files and sandboxed drafts, error logs and cache purges, request profiling, developer introspection, plugin settings and admin screens, unregistered post meta, options, snippets and editable fields.
 * Version:           2.0.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            wpxmcp
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       wpxmcp
 *
 * @package wpxmcp
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'WPXMCP_VERSION', '2.0.0' );
define( 'WPXMCP_NAMESPACE', 'wpxmcp/v1' );
define( 'WPXMCP_FILE', __FILE__ );
define( 'WPXMCP_DIR', plugin_dir_path( __FILE__ ) );

/**
 * Every route requires this capability (a network super admin on multisite).
 * Routes that change files or themes additionally check the specific capability,
 * so DISALLOW_FILE_EDIT and DISALLOW_FILE_MODS are honoured.
 */
define( 'WPXMCP_ADMIN_CAP', 'manage_options' );

require_once WPXMCP_DIR . 'includes/class-wpxmcp-rest.php';
require_once WPXMCP_DIR . 'includes/class-wpxmcp-cli.php';
require_once WPXMCP_DIR . 'includes/class-wpxmcp-themes.php';
require_once WPXMCP_DIR . 'includes/class-wpxmcp-fields.php';
require_once WPXMCP_DIR . 'includes/class-wpxmcp-snippets.php';
require_once WPXMCP_DIR . 'includes/class-wpxmcp-diagnostics.php';
require_once WPXMCP_DIR . 'includes/class-wpxmcp-inspect.php';
require_once WPXMCP_DIR . 'includes/class-wpxmcp-profiler.php';
require_once WPXMCP_DIR . 'includes/class-wpxmcp-admin.php';

/**
 * Boot.
 */
function wpxmcp_init() {
	WPXMCP_REST::instance();
	WPXMCP_Themes::instance();
	WPXMCP_Fields::instance();
	WPXMCP_Snippets::instance();
	WPXMCP_Diagnostics::instance();
	WPXMCP_Inspect::instance();
	WPXMCP_Profiler::instance();
	WPXMCP_Admin::instance();
}
add_action( 'plugins_loaded', 'wpxmcp_init' );

/**
 * Options no wpxmcp write path may touch: the ones that lock the site out or
 * break this connection, and the plugin's own state — writing wpxmcp_snippets
 * directly would activate PHP without the wp-admin review step, and the audit
 * log is meant to be append-only.
 *
 * @param string $name Option name.
 * @return bool
 */
function wpxmcp_is_protected_option( $name ) {
	// MySQL compares option names case-insensitively and ignores trailing spaces.
	$name = strtolower( trim( (string) $name ) );

	$protected = array(
		// Lock-out or broken connection.
		'siteurl', 'home', 'active_plugins', 'active_sitewide_plugins', 'template', 'stylesheet',
		// Core state that is regenerated or migrated by WordPress itself.
		'cron', 'db_version', 'rewrite_rules',
		// Where uploads are written — pointing it elsewhere writes files outside wp-content.
		'upload_path', 'upload_url_path',
		// Privilege: the role every new account receives.
		'default_role',
	);
	if ( in_array( $name, $protected, true ) ) {
		return true;
	}

	// Role definitions ({prefix}user_roles) and salts stored as options.
	if ( '_user_roles' === substr( $name, -11 ) ) {
		return true;
	}
	if ( preg_match( '/^(auth|secure_auth|logged_in|nonce)_(key|salt)$/', $name ) ) {
		return true;
	}

	return 0 === strpos( $name, 'wpxmcp_' );
}

/**
 * Append-only audit trail of every sensitive action, mirrored site-side so it
 * survives independently of the MCP server's own log.
 *
 * @param string $action  What happened.
 * @param array  $context Extra detail.
 */
function wpxmcp_audit( $action, $context = array() ) {
	$log = get_option( 'wpxmcp_audit_log', array() );
	if ( ! is_array( $log ) ) {
		$log = array();
	}

	$log[] = array(
		'time'    => gmdate( 'c' ),
		'user'    => get_current_user_id(),
		'action'  => $action,
		'context' => $context,
		'ip'      => isset( $_SERVER['REMOTE_ADDR'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ) ) : '',
	);

	// Keep the tail bounded so the option never bloats the database.
	if ( count( $log ) > 500 ) {
		$log = array_slice( $log, -500 );
	}

	update_option( 'wpxmcp_audit_log', $log, false );
}

/**
 * Activation — create the working directories the theme draft workflow needs.
 */
function wpxmcp_activate() {
	$uploads = wp_upload_dir();
	$dir     = trailingslashit( $uploads['basedir'] ) . 'wpxmcp';

	if ( ! file_exists( $dir ) ) {
		wp_mkdir_p( $dir );
		// Never serve anything out of the working directory.
		file_put_contents( $dir . '/.htaccess', "Deny from all\n" ); // phpcs:ignore WordPress.WP.AlternativeFunctions
		file_put_contents( $dir . '/index.php', "<?php // Silence is golden.\n" ); // phpcs:ignore WordPress.WP.AlternativeFunctions
	}

	add_option( 'wpxmcp_version', WPXMCP_VERSION );
}
register_activation_hook( __FILE__, 'wpxmcp_activate' );

/**
 * A small admin notice so the site owner knows the plugin is live and what it does.
 */
function wpxmcp_admin_notice() {
	if ( ! current_user_can( WPXMCP_ADMIN_CAP ) ) {
		return;
	}
	$screen = get_current_screen();
	if ( ! $screen || 'plugins' !== $screen->id ) {
		return;
	}
	?>
	<div class="notice notice-info is-dismissible">
		<p>
			<strong>wpxmcp Helper</strong> is active. It exposes the <code><?php echo esc_html( WPXMCP_NAMESPACE ); ?></code>
			REST namespace to authenticated administrators only. Every sensitive action is recorded &mdash;
			see <code>wpxmcp_audit_log</code> in the options table.
		</p>
	</div>
	<?php
}
add_action( 'admin_notices', 'wpxmcp_admin_notice' );
