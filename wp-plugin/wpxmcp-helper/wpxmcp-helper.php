<?php
/**
 * Plugin Name:       wpxmcp Helper
 * Plugin URI:        https://github.com/wpxmcp
 * Description:       Companion plugin for the wpxmcp MCP server. Exposes the things core REST does not: emulated WP-CLI, read-only SQL, theme files and sandboxed drafts, unregistered post meta, options, theme mods, site health, code snippets and editable fields.
 * Version:           1.0.0
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

define( 'WPXMCP_VERSION', '1.0.0' );
define( 'WPXMCP_NAMESPACE', 'wpxmcp/v1' );
define( 'WPXMCP_FILE', __FILE__ );
define( 'WPXMCP_DIR', plugin_dir_path( __FILE__ ) );

/**
 * Every mutating route requires this capability. Read routes require edit_posts
 * or better, checked per route.
 */
define( 'WPXMCP_ADMIN_CAP', 'manage_options' );

require_once WPXMCP_DIR . 'includes/class-wpxmcp-rest.php';
require_once WPXMCP_DIR . 'includes/class-wpxmcp-cli.php';
require_once WPXMCP_DIR . 'includes/class-wpxmcp-themes.php';
require_once WPXMCP_DIR . 'includes/class-wpxmcp-fields.php';
require_once WPXMCP_DIR . 'includes/class-wpxmcp-snippets.php';

/**
 * Boot.
 */
function wpxmcp_init() {
	WPXMCP_REST::instance();
	WPXMCP_Themes::instance();
	WPXMCP_Fields::instance();
	WPXMCP_Snippets::instance();
}
add_action( 'plugins_loaded', 'wpxmcp_init' );

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
